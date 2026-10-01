import { Octokit } from 'octokit'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from 'execa'
import { botIdentity, env, loadPolicy } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { budgetExhausted } from '../analyze/claude.ts'
import { scanRepo } from '../compose/scan.ts'
import { routine } from '../notify/digest.ts'
import { sourceFor } from '../resolver/index.ts'
import { parseImageRef } from '../images/ref.ts'
import { postIssueComment } from '../gitops/comments.ts'
import { ensureWorkRepo, git, httpsUrl, withGitLock } from '../gitops/repo.ts'
import { blockFor, checkAndApply, composeAccepts, restore } from './commit.ts'
import { scopeFor, boundaryFor, describeBoundary, allowedServices } from './paths.ts'
import { proposalHunks } from './hunks.ts'
import { propose, type Proposal } from './propose.ts'
import { gatherContext } from './context.ts'
import { llmConfigured } from '../analyze/client.ts'
import { backoffUntil } from '../backoff.ts'

/**
 * Turning a proposal into a second commit on the pull request branch.
 *
 * Never a replacement for the tag bump -- an addition to it. The pull request then shows
 * two commits: the mechanical change shipshape can prove correct, and the drafted changes
 * it cannot. Its badge flips to `proposed`, which permanently disqualifies it from
 * auto-merge. Every path here ends with a human deciding.
 */

let octokit: Octokit | null = null
function gh(): Octokit {
  octokit ??= new Octokit({ auth: env.githubToken })
  return octokit
}

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
  prId: number
  number: number
  branch: string
  headSha: string
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
  if (!llmConfigured() || !env.githubToken) {
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
        message: `config changes could be drafted for #${declined.number}`,
        detail: `propose.mode is ${policy.propose.mode}: press Draft config changes, or set it to auto`,
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

/** The attempts already spent on this pull request by drafts that may be tried again. */
function priorAttempts(prId: number): number {
  const row = getDb()
    .prepare(`SELECT MAX(attempts) AS n FROM proposals WHERE pr_id = ? AND retryable = 1`)
    .get(prId) as { n: number | null }
  return row.n ?? 0
}

/**
 * A draft that failed for a reason that may pass: the model call errored, returned
 * nothing, or the push did not land.
 *
 * Written as a row so the next pass can see it and wait. Before this, nothing was
 * written, so every tick picked the same pull request again -- another code-model call
 * and another "could not draft" comment, once a minute, for as long as the failure
 * lasted. The pull request is told once, when shipshape gives up; until then the
 * activity log carries each attempt.
 */
async function recordRetryable(c: Candidate, error: string): Promise<void> {
  const db = getDb()
  const attempts = priorAttempts(c.prId) + 1
  const giveUp = attempts >= DRAFT_ATTEMPTS
  db.transaction(() => {
    db.prepare(`DELETE FROM proposals WHERE pr_id = ? AND retryable = 1`).run(c.prId)
    db.prepare(
      `INSERT INTO proposals (pr_id, update_id, ops, notes, summary, sources, changed, model,
                              error, hunks, created_at, retryable, attempts, next_attempt_at)
       VALUES (?, ?, '[]', '[]', NULL, '[]', '[]', ?, ?, '[]', ?, 1, ?, ?)`,
    ).run(
      c.prId,
      c.updateId,
      loadPolicy().policy.claude.code_model,
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
      ? `gave up drafting config changes for #${c.number} after ${attempts} attempts`
      : `could not draft config changes for #${c.number}; trying again later (attempt ${attempts} of ${DRAFT_ATTEMPTS})`,
    detail: error.slice(0, 200),
  })
  if (giveUp) {
    await comment(
      c.number,
      `shipshape could not draft config changes after ${attempts} attempts: ${error.slice(0, 300)}\n\n` +
        'Press **Draft config changes** to try again.',
    )
  }
}

/**
 * A pull request is eligible when it is still exactly what shipshape wrote, a verdict
 * exists reporting that more than a tag change is needed, and the service has not opted
 * out. `only` is the per-PR button, which bypasses the mode check but nothing else.
 *
 * `declined` is the first pull request that cleared every one of those bars and was left
 * alone only because the mode is not `auto` -- the difference between "nothing to draft"
 * and "something to draft, and you have asked me not to".
 */
export function pickCandidate(
  mode: string,
  only?: number,
): { candidate: Candidate | null; declined: Candidate | null } {
  const rows = getDb()
    .prepare(
      `SELECT p.id AS prId, p.number, p.branch, p.head_sha_pushed AS headSha,
              u.id AS updateId, u.stack, u.service, u.image, u.from_tag AS fromTag,
              u.to_tag AS toTag, i.compose_file AS composeFile,
              v.recommendation, v.migration_steps
       FROM prs p
       JOIN pr_updates pu ON pu.pr_id = p.id
       JOIN updates u ON u.id = pu.update_id
       JOIN images i ON i.stack = u.stack AND i.service = u.service
       LEFT JOIN verdicts v ON v.image = u.image AND v.from_tag = u.from_tag
                           AND v.to_tag = u.to_tag AND v.error IS NULL
       WHERE p.state = 'open' AND p.scope = 'tag-only' AND p.user_owned = 0
         AND u.detail IS NOT 'rolling'
         -- Never draft config changes onto a pull request whose target was overtaken:
         -- the work would be for a version that is not going to be merged.
         AND u.state != 'superseded'
         -- A proposal settles it, except a failure that may pass: that waits out its
         -- backoff and is tried again, three times at most. The button skips the wait.
         AND NOT EXISTS (
           SELECT 1 FROM proposals pr2 WHERE pr2.pr_id = p.id
             AND NOT (
               pr2.retryable = 1
               AND (${only === undefined ? `pr2.next_attempt_at IS NOT NULL AND pr2.next_attempt_at <= ?` : '1'})
             )
         )
         ${only === undefined ? '' : 'AND p.number = ?'}
       ORDER BY p.number`,
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
    // Work from exactly the commit shipshape pushed. If the branch has moved since, the
    // human got there first and this proposal is already stale.
    await git(repoDir, ['fetch', httpsUrl(), c.branch], { remote: true })
    const remoteSha = (await git(repoDir, ['rev-parse', 'FETCH_HEAD'])).stdout
    if (remoteSha !== c.headSha) {
      logEvent({
        level: 'info',
        kind: 'pr',
        stack: c.stack,
        message: `#${c.number} moved before a proposal could be drafted; leaving it alone`,
      })
      return false
    }
    await git(repoDir, ['checkout', '-B', c.branch, c.headSha])

    const abs = join(repoDir, c.composeFile)
    const before = readFileSync(abs, 'utf8')
    const ref = parseImageRef(c.image)
    const source = await sourceFor(
      { registry: ref.registry, repository: ref.repository },
      { service: { stack: c.stack, service: c.service }, tag: ref.tag ?? c.fromTag },
    )

    // Scope is resolved from the compose file at draft time, so a label edited since
    // the pull request opened takes effect.
    const services = scanRepo(env.repoDir, loadPolicy().policy.exclude_stacks)
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
      await recordRetryable(c, result.error)
      return false
    }

    // Nothing to change in the file: the work is all manual, so say so and stop.
    if (result.ops.length === 0) {
      record(c, result, null, [])
      await comment(c.number, renderComment(result, [], null))
      logEvent({
        level: 'info',
        kind: 'pr',
        stack: c.stack,
        service: c.service,
        message: `#${c.number}: no compose change needed, ${result.notes.length} manual step(s) noted`,
      })
      return true
    }

    // The boundary check, the applier and the parse gate all live in checkAndApply, which
    // the revision path calls too -- one enforcement path rather than two that look alike.
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
      record(c, result, applied.reason, [])
      await comment(
        c.number,
        `shipshape drafted config changes but refused to apply them: **${applied.reason}**\n\n` +
          renderComment(result, [], null),
      )
      logEvent({
        level: 'warn',
        kind: 'pr',
        stack: c.stack,
        service: c.service,
        message: `#${c.number}: proposal refused`,
        detail: applied.reason,
      })
      return false
    }

    const { results, originals } = applied
    const gate = await composeAccepts(repoDir, c.composeFile)
    if (!gate.ok) {
      restore(repoDir, originals)
      record(c, result, gate.reason, [])
      await comment(c.number, `shipshape's drafted changes did not validate: **${gate.reason}**`)
      return false
    }

    const title = `chore(deps): ${c.stack}/${c.service}: config changes for ${c.toTag}`
    await git(repoDir, [
      ...botIdentity(),
      'commit',
      '-am',
      `${title}\n\nDrafted by ${policy.claude.code_model}. Review before merging.`,
    ])
    const newSha = (await git(repoDir, ['rev-parse', 'HEAD'])).stdout
    const pushed = await git(repoDir, ['push', httpsUrl(), `HEAD:${c.branch}`], {
      remote: true,
      allowFail: true,
    })
    if (pushed.exitCode !== 0) {
      await recordRetryable(c, `could not push the drafted commit: ${pushed.stderr.slice(0, 200) || 'push failed'}`)
      return false
    }

    const db = getDb()
    db.transaction(() => {
      // shipshape still owns the branch -- this commit is its own.
      db.prepare(`UPDATE prs SET head_sha_pushed = ?, scope = 'proposed' WHERE id = ?`).run(
        newSha,
        c.prId,
      )
    })()
    record(
      c,
      result,
      null,
      applied.changed,
      [...results].flatMap(([file, text]) => proposalHunks(originals.get(file) ?? '', text, file)),
    )

    const [owner, repo] = env.githubRepo.split('/') as [string, string]
    await gh()
      .rest.issues.addLabels({ owner, repo, issue_number: c.number, labels: ['proposed-changes'] })
      .catch(() => {})
    await comment(c.number, renderComment(result, applied.changed, policy.claude.code_model))

    logEvent({
      level: 'info',
      kind: 'pr',
      stack: c.stack,
      service: c.service,
      message: `#${c.number}: drafted ${applied.changed.length} config change(s)`,
      detail: applied.changed.join(', '),
    })
    await routine({
      category: 'drafted',
      stack: c.stack,
      service: c.service,
      summary: `#${c.number} — ${applied.changed.length} config change(s) drafted`,
      detail: `${c.stack}/${c.service}\n\n${applied.changed.join('\n')}\n\nReview both commits before merging.`,
      url: `https://github.com/${env.githubRepo}/pull/${c.number}/files`,
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
  getDb().prepare(`DELETE FROM proposals WHERE pr_id = ? AND retryable = 1`).run(c.prId)
  getDb()
    .prepare(
      `INSERT INTO proposals (pr_id, update_id, ops, notes, summary, sources, changed,
                              model, error, hunks, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      c.prId,
      c.updateId,
      JSON.stringify(p.ops),
      JSON.stringify(p.notes),
      p.summary,
      JSON.stringify(p.sources),
      JSON.stringify(changed),
      policy.claude.code_model,
      error,
      JSON.stringify(hunks),
      new Date().toISOString(),
    )
}

/**
 * Marked, like everything else shipshape says.
 *
 * This was the one comment that carried no marker, which mattered more than it looks:
 * the token is the operator's, so an unmarked comment from shipshape is indistinguishable
 * from one the operator wrote. Anything reading the thread back as input would have
 * treated shipshape's own summary as an instruction and answered it.
 */
async function comment(number: number, body: string): Promise<void> {
  await postIssueComment(number, 'proposal', body)
}

function renderComment(p: Proposal, changed: string[], model: string | null): string {
  const parts = ['### Drafted config changes', '', p.summary]
  if (changed.length > 0) {
    parts.push('', '**Applied in the second commit**', ...changed.map((c) => `- ${c}`))
  } else if (p.ops.length === 0) {
    parts.push('', '_No compose change is required for this update._')
  }
  if (p.notes.length > 0) {
    parts.push(
      '',
      '**You still need to do these by hand**',
      ...p.notes.map((n) => `- ${n}`),
    )
  }
  if (p.sources.length > 0) {
    parts.push('', '<details><summary>Sources</summary>', '', ...p.sources.map((s) => `- ${s}`), '</details>')
  }
  parts.push(
    '',
    `<sub>${model ? `Drafted by \`${model}\`. ` : ''}This pull request now contains changes nothing has verified, so it will never merge automatically. Read both commits.</sub>`,
  )
  return parts.join('\n')
}
