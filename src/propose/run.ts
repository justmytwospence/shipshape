import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { botIdentity, env, loadPolicy } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { budgetExhausted } from '../analyze/claude.ts'
import { scanRepo } from '../compose/scan.ts'
import { sourceFor } from '../resolver/index.ts'
import { parseImageRef } from '../images/ref.ts'
import { buildBranch } from '../gitops/ship.ts'
import { eligibleGroups, shipBranchFor } from '../gitops/ship.ts'
import { ensureWorkRepo, git, withGitLock } from '../gitops/repo.ts'
import { blockFor, checkAndApply, composeAccepts, restore } from './commit.ts'
import { scopeFor, boundaryFor, describeBoundary, allowedServices } from './paths.ts'
import { proposalHunks } from './hunks.ts'
import { propose, type Proposal } from './propose.ts'
import { gatherContext } from './context.ts'
import { llmConfigured } from '../analyze/client.ts'
import { backoffUntil } from '../backoff.ts'

/**
 * Turning a proposal into a second commit on a local branch.
 *
 * Never a replacement for the tag bump -- an addition to it. The branch (built in
 * shipshape's work clone, never pushed) then carries two commits: the mechanical change
 * shipshape can prove correct, and the drafted changes it cannot. The change record's
 * scope flips to `proposed`, which means it never ships on its own and is never reverted
 * without you. Every path here ends with a human deciding: the decision card says what
 * was drafted, and shipping it merges both commits.
 */

export interface ProposeRunResult {
  drafted: number
  skipped: number
  failed: number
  /**
   * Why nothing was drafted, when nothing was. Every one of these used to be the same
   * empty result, which is how "the budget for this window is spent" and "this pull
   * request needs no config change" reached the operator as one sentence.
   */
  reason?: 'budget' | 'mode' | 'unconfigured' | 'nothing'
}

interface Candidate {
  /** The local change record for a draft in progress or retrying; null before the first attempt. */
  prId: number | null
  updateId: number
  stack: string
  service: string
  image: string
  fromTag: string
  toTag: string
  composeFile: string
}

/** Draft changes for at most one pull request per pass: slow, expensive, and rare. */
export async function runProposePass(only?: number): Promise<ProposeRunResult> {
  const out: ProposeRunResult = { drafted: 0, skipped: 0, failed: 0 }
  const { policy } = loadPolicy()
  if (!llmConfigured()) {
    out.reason = 'unconfigured'
    return out
  }
  if (budgetExhausted()) {
    out.skipped++
    out.reason = 'budget'
    return out
  }

  const { candidate, declined } = pickCandidate(policy.propose.mode, only)
  if (!candidate) {
    // A pass that declines on mode used to return the same empty result as a pass with
    // nothing to do, and returned it just as quietly: every logEvent in this file sits
    // downstream of a candidate being picked, so there was no event, no comment and no
    // digest line. That made a configured opt-out indistinguishable from the feature not
    // existing -- which is exactly how it was read. Say it once a day, per pull request.
    if (declined) {
      out.reason = 'mode'
      logEvent({
        level: 'info',
        kind: 'analysis',
        stack: declined.stack,
        service: declined.service,
        message: `config changes could be drafted for ${declined.stack}/${declined.service}`,
        detail: `propose.mode is ${policy.propose.mode}: use the Draft config changes verb, or set it to auto`,
      })
    } else {
      out.reason = 'nothing'
    }
    return out
  }

  try {
    const drafted = await draftFor(candidate)
    if (drafted) out.drafted++
    else out.skipped++
  } catch (err) {
    out.failed++
    await recordRetryable(candidate, (err as Error).message)
  }
  return out
}

/** How many times a draft that failed for a passing reason is tried before giving up. */
export const DRAFT_ATTEMPTS = 3

/** 15 minutes, then four times that each attempt, capped at a day. */
export function nextDraftAt(attempts: number, now = Date.now()): string {
  return backoffUntil(attempts, { baseMs: 15 * 60_000, capMs: 24 * 60 * 60_000 }, now)
}

/** The attempts already spent on this update by drafts that may be tried again. */
function priorAttempts(updateId: number): number {
  const row = getDb()
    .prepare(`SELECT MAX(attempts) AS n FROM proposals WHERE update_id = ? AND retryable = 1`)
    .get(updateId) as { n: number | null }
  return row.n ?? 0
}

/** The local change record a draft hangs off, created on the first attempt. */
function ensureChangeRow(c: Candidate, branch: string): number {
  if (c.prId !== null) return c.prId
  const db = getDb()
  const existing = db
    .prepare(
      `SELECT p.id FROM prs p JOIN pr_updates pu ON pu.pr_id = p.id
        WHERE pu.update_id = ? AND p.kind = 'local' AND p.state = 'open' ORDER BY p.id DESC LIMIT 1`,
    )
    .get(c.updateId) as { id: number } | undefined
  if (existing) return existing.id
  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO prs (number, branch, head_sha_pushed, state, group_key, scope, kind, created_at)
         VALUES (0, ?, '', 'open', NULL, 'tag-only', 'local', ?)`,
      )
      .run(branch, new Date().toISOString())
    const id = Number(info.lastInsertRowid)
    db.prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`).run(id, c.updateId)
    return id
  })()
}

/**
 * A draft that failed for a reason that may pass: the model call errored, returned
 * nothing, or the branch could not be built.
 *
 * Written as a row so the next pass can see it and wait. Before this, nothing was
 * written, so every tick picked the same update again -- another code-model call, once a
 * minute, for as long as the failure lasted. The activity log carries each attempt.
 */
async function recordRetryable(c: Candidate, error: string): Promise<void> {
  const db = getDb()
  const attempts = priorAttempts(c.updateId) + 1
  const giveUp = attempts >= DRAFT_ATTEMPTS
  const prId = ensureChangeRow(c, `shipshape/${c.stack}--${c.service}--draft`)
  db.transaction(() => {
    db.prepare(`DELETE FROM proposals WHERE update_id = ? AND retryable = 1`).run(c.updateId)
    db.prepare(
      `INSERT INTO proposals (pr_id, update_id, ops, notes, summary, sources, changed, model,
                              error, hunks, created_at, retryable, attempts, next_attempt_at)
       VALUES (?, ?, '[]', '[]', NULL, '[]', '[]', ?, ?, '[]', ?, 1, ?, ?)`,
    ).run(
      prId,
      c.updateId,
      loadPolicy().policy.review.code_model,
      error.slice(0, 400),
      new Date().toISOString(),
      attempts,
      giveUp ? null : nextDraftAt(attempts),
    )
  })()
  logEvent({
    level: giveUp ? 'warn' : 'info',
    kind: 'analysis',
    stack: c.stack,
    service: c.service,
    message: giveUp
      ? `gave up drafting config changes for ${c.stack}/${c.service} after ${attempts} attempts`
      : `could not draft config changes for ${c.stack}/${c.service}; trying again later (attempt ${attempts} of ${DRAFT_ATTEMPTS})`,
    detail: error.slice(0, 200),
  })
}

/**
 * An update is eligible when it is detected, a verdict exists reporting that more than a
 * tag change is needed, and the service has not opted out. `only` is the verb, which
 * bypasses the mode check but nothing else.
 *
 * `declined` is the first update that cleared every one of those bars and was left alone
 * only because the mode is not `auto` -- the difference between "nothing to draft" and
 * "something to draft, and you have asked me not to".
 */
export function pickCandidate(
  mode: string,
  only?: number,
): { candidate: Candidate | null; declined: Candidate | null } {
  const rows = getDb()
    .prepare(
      `SELECT u.id AS updateId, u.stack, u.service, u.image, u.from_tag AS fromTag,
              u.to_tag AS toTag, i.compose_file AS composeFile,
              v.recommendation, v.migration_steps,
              (SELECT p.id FROM prs p JOIN pr_updates pu ON pu.pr_id = p.id
                WHERE pu.update_id = u.id AND p.kind = 'local' AND p.state = 'open'
                ORDER BY p.id DESC LIMIT 1) AS prId
       FROM updates u
       JOIN images i ON i.stack = u.stack AND i.service = u.service
       LEFT JOIN verdicts v ON v.image = u.image AND v.from_tag = u.from_tag
                           AND v.to_tag = u.to_tag AND v.error IS NULL
       WHERE u.state = 'detected' AND u.detail IS NOT 'rolling' AND u.tier != 'skip'
         -- A proposal settles it, except a failure that may pass: that waits out its
         -- backoff and is tried again, three times at most. The verb skips the wait.
         AND NOT EXISTS (
           SELECT 1 FROM proposals pr2 WHERE pr2.update_id = u.id
             AND NOT (
               pr2.retryable = 1
               AND (${only === undefined ? `pr2.next_attempt_at IS NOT NULL AND pr2.next_attempt_at <= ?` : '1'})
             )
         )
         ${only === undefined ? '' : 'AND u.id = ?'}
       ORDER BY u.id`,
    )
    .all(...(only === undefined ? [new Date().toISOString()] : [only])) as (Candidate & {
    recommendation: string | null
    migration_steps: string | null
  })[]

  const services = scanRepo(env.repoDir, loadPolicy().policy.exclude_stacks)
  let declined: Candidate | null = null
  for (const r of rows) {
    const svc = services.find((s) => s.stack === r.stack && s.service === r.service)
    if (scopeFor(svc?.proposeLabel) === 'none') continue

    if (only !== undefined) return { candidate: r, declined: null }

    // Automatic drafting only where the review named work this operator has to do. It
    // used to fire on any caution too -- including one that only meant "read the notes",
    // or that the notes could not be found -- and each of those was a code-model call
    // that came back with nothing to change.
    const needsWork = r.migration_steps ? (JSON.parse(r.migration_steps) as string[]).length > 0 : false
    if (!needsWork) continue
    if (mode === 'auto') return { candidate: r, declined: null }
    declined ??= r
  }
  return { candidate: null, declined }
}

async function draftFor(c: Candidate): Promise<boolean> {
  const { policy } = loadPolicy()
  const verdict = getDb()
    .prepare(
      `SELECT summary, breaking_changes, migration_steps FROM verdicts
       WHERE image = ? AND from_tag = ? AND to_tag = ? AND error IS NULL`,
    )
    .get(c.image, c.fromTag, c.toTag) as
    | { summary: string; breaking_changes: string; migration_steps: string }
    | undefined
  if (!verdict) return false

  return withGitLock('propose', async () => {
    const repoDir = await ensureWorkRepo()
    // The group this update would ship in, so a draft carries its companions' bumps too.
    const group = eligibleGroups(policy).find((g) => g.members.some((m) => m.id === c.updateId))
    if (!group) return false
    const branch = shipBranchFor(group)
    const built = await buildBranch(repoDir, group, branch)
    if (!built.ok) {
      if (!built.alreadyApplied) await recordRetryable(c, built.reason)
      return false
    }
    const headBefore = (await git(repoDir, ['rev-parse', 'HEAD'])).stdout
    const prId = ensureChangeRow(c, branch)

    const abs = join(repoDir, c.composeFile)
    const before = readFileSync(abs, 'utf8')
    const ref = parseImageRef(c.image)
    const source = await sourceFor(
      { registry: ref.registry, repository: ref.repository },
      { service: { stack: c.stack, service: c.service }, tag: ref.tag ?? c.fromTag },
    )

    // Scope is resolved from the compose file at draft time, so a label edited since
    // the update was detected takes effect.
    const services = scanRepo(env.repoDir, policy.exclude_stacks)
    const scope = scopeFor(
      services.find((s) => s.stack === c.stack && s.service === c.service)?.proposeLabel,
    )
    const siblings = services
      .filter((s) => s.stack === c.stack && s.composeFile === c.composeFile)
      .map((s) => s.service)
    const allowed = allowedServices(scope, c.service, siblings)
    const boundary = boundaryFor(scope, c.composeFile)

    const result = await propose({
      context: await gatherContext(before, c.service),
      scope: describeBoundary(boundary, c.service, allowed),
      image: c.image,
      fromTag: c.fromTag,
      toTag: c.toTag,
      service: c.service,
      composeBlock: blockFor(before, c.service),
      sourceRepo: source.repo,
      verdict: {
        summary: verdict.summary,
        breaking_changes: JSON.parse(verdict.breaking_changes) as string[],
        migration_steps: JSON.parse(verdict.migration_steps) as string[],
      },
    })
    if ('error' in result) {
      await recordRetryable({ ...c, prId }, result.error)
      return false
    }

    // Nothing to change in the file: the work is all manual, so say so and stop.
    if (result.ops.length === 0) {
      record({ ...c, prId }, result, null, [])
      logEvent({
        level: 'info',
        kind: 'pr',
        stack: c.stack,
        service: c.service,
        message: `${c.stack}/${c.service}: no compose change needed, ${result.notes.length} manual step(s) noted`,
      })
      return true
    }

    // The boundary check, the applier and the parse gate all live in checkAndApply --
    // one enforcement path rather than two that look alike.
    const applied = checkAndApply({
      repoDir,
      ops: result.ops,
      composeFile: c.composeFile,
      service: c.service,
      boundary,
      allowed,
      selfStack: env.selfStack,
      never: policy.propose.never,
    })

    if (!applied.ok) {
      // A refused proposal must be visible: silence would look like "nothing to do".
      record({ ...c, prId }, result, applied.reason, [])
      logEvent({
        level: 'warn',
        kind: 'pr',
        stack: c.stack,
        service: c.service,
        message: `${c.stack}/${c.service}: proposal refused`,
        detail: applied.reason,
      })
      return false
    }

    const { results, originals } = applied
    const gate = await composeAccepts(repoDir, c.composeFile)
    if (!gate.ok) {
      restore(repoDir, originals)
      record({ ...c, prId }, result, gate.reason, [])
      return false
    }

    const title = `chore(deps): ${c.stack}/${c.service}: config changes for ${c.toTag}`
    await git(repoDir, [
      ...botIdentity(),
      'commit',
      '-am',
      `${title}\n\nDrafted by ${policy.review.code_model}. Review before shipping.`,
    ])
    const newSha = (await git(repoDir, ['rev-parse', 'HEAD'])).stdout
    if (newSha === headBefore) return false

    const db = getDb()
    db.transaction(() => {
      // Proposed: this change carries edits nothing has verified, so it never ships on
      // its own and is never reverted automatically.
      db.prepare(`UPDATE prs SET head_sha_pushed = ?, scope = 'proposed', branch = ? WHERE id = ?`).run(newSha, branch, prId)
      const link = db.prepare(`INSERT OR IGNORE INTO pr_updates (pr_id, update_id) VALUES (?, ?)`)
      for (const m of group.members) link.run(prId, m.id)
    })()
    record(
      { ...c, prId },
      result,
      null,
      applied.changed,
      [...results].flatMap(([file, text]) => proposalHunks(originals.get(file) ?? '', text, file)),
    )

    logEvent({
      level: 'info',
      kind: 'pr',
      stack: c.stack,
      service: c.service,
      message: `${c.stack}/${c.service}: drafted ${applied.changed.length} config change(s)`,
      detail: applied.changed.join(', '),
    })
    return true
  })
}

function record(
  c: Candidate,
  p: Proposal,
  error: string | null,
  changed: string[],
  hunks: unknown[] = [],
): void {
  const { policy } = loadPolicy()
  // A retry that got this far supersedes the failures that led to it.
  getDb().prepare(`DELETE FROM proposals WHERE update_id = ? AND retryable = 1`).run(c.updateId)
  getDb()
    .prepare(
      `INSERT INTO proposals (pr_id, update_id, ops, notes, summary, sources, changed,
                              model, error, hunks, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      c.prId!,
      c.updateId,
      JSON.stringify(p.ops),
      JSON.stringify(p.notes),
      p.summary,
      JSON.stringify(p.sources),
      JSON.stringify(changed),
      policy.review.code_model,
      error,
      JSON.stringify(hunks),
      new Date().toISOString(),
    )
}
