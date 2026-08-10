import { Octokit } from 'octokit'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from 'execa'
import { botIdentity, env, loadPolicy } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { budgetExhausted } from '../analyze/claude.ts'
import { scanRepo } from '../compose/scan.ts'
import { routine } from '../notify/digest.ts'
import { resolveSource } from '../resolver/index.ts'
import { parseImageRef } from '../images/ref.ts'
import { ensureWorkRepo, git, httpsUrl, withGitLock } from '../gitops/repo.ts'
import { applyOps } from './apply.ts'
import { scopeFor, boundaryFor, canWrite, describeBoundary, allowedServices } from './paths.ts'
import { proposalHunks } from './hunks.ts'
import { propose, type Proposal } from './propose.ts'
import { gatherContext } from './context.ts'

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
  if (policy.propose.mode === 'off' && only === undefined) return out
  if (!env.anthropicApiKey || !env.githubToken) return out
  if (budgetExhausted()) {
    out.skipped++
    return out
  }

  const candidate = pickCandidate(policy.propose.mode, only)
  if (!candidate) return out

  try {
    const drafted = await draftFor(candidate)
    if (drafted) out.drafted++
    else out.skipped++
  } catch (err) {
    out.failed++
    logEvent({
      level: 'error',
      kind: 'analysis',
      stack: candidate.stack,
      service: candidate.service,
      message: `could not draft config changes for #${candidate.number}`,
      detail: (err as Error).message.slice(0, 200),
    })
  }
  return out
}

/**
 * A pull request is eligible when it is still exactly what shipshape wrote, a verdict
 * exists reporting that more than a tag change is needed, and the service has not opted
 * out. `only` is the per-PR button, which bypasses the mode check but nothing else.
 */
function pickCandidate(mode: string, only?: number): Candidate | null {
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
         AND NOT EXISTS (SELECT 1 FROM proposals pr2 WHERE pr2.pr_id = p.id)
         ${only === undefined ? '' : 'AND p.number = ?'}
       ORDER BY p.number`,
    )
    .all(...(only === undefined ? [] : [only])) as (Candidate & {
    recommendation: string | null
    migration_steps: string | null
  })[]

  const services = scanRepo(env.repoDir, loadPolicy().policy.exclude_stacks)
  for (const r of rows) {
    const svc = services.find((s) => s.stack === r.stack && s.service === r.service)
    if (scopeFor(svc?.proposeLabel) === 'none') continue

    if (only !== undefined) return r

    // Automatic drafting only where the review said something actually breaks.
    const needsWork =
      r.recommendation === 'block' ||
      r.recommendation === 'caution' ||
      (r.migration_steps ? (JSON.parse(r.migration_steps) as string[]).length > 0 : false)
    if (mode === 'auto' && needsWork) return r
  }
  return null
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
    const resolved = await resolveSource({
      registry: ref.registry,
      repository: ref.repository,
      tag: ref.tag ?? c.fromTag,
    })

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
      sourceRepo: resolved.sourceRepo,
      verdict: {
        summary: verdict.summary,
        breaking_changes: JSON.parse(verdict.breaking_changes) as string[],
        migration_steps: JSON.parse(verdict.migration_steps) as string[],
      },
    })
    if ('error' in result) {
      await comment(c.number, `shipshape could not draft config changes: ${result.error}`)
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

    // Ops are grouped by the file they name; anything unnamed edits the compose file.
    // Every target is checked against the boundary before a byte is written, so the
    // permission is enforced here rather than trusted from the model's output.
    const byFile = new Map<string, typeof result.ops>()
    for (const op of result.ops) {
      const file = op.file ?? c.composeFile
      let peek: string | undefined
      try {
        peek = readFileSync(join(repoDir, file), 'utf8').slice(0, 8192)
      } catch {
        peek = undefined
      }
      const verdict = canWrite(file, boundary, env.selfStack, peek)
      if (!verdict.ok) {
        record(c, result, verdict.reason, [])
        await comment(
          c.number,
          `shipshape drafted config changes but refused to apply them: **${verdict.reason}**\n\n` +
            renderComment(result, [], null),
        )
        logEvent({
          level: 'warn',
          kind: 'pr',
          stack: c.stack,
          service: c.service,
          message: `#${c.number}: proposal refused`,
          detail: verdict.reason,
        })
        return false
      }
      byFile.set(file, [...(byFile.get(file) ?? []), op])
    }

    const originals = new Map<string, string>()
    const results = new Map<string, string>()
    const allChanged: string[] = []
    let failure: string | null = null

    for (const [file, ops] of byFile) {
      const abs2 = join(repoDir, file)
      let text: string
      try {
        text = readFileSync(abs2, 'utf8')
      } catch {
        failure = `${file} does not exist`
        break
      }
      originals.set(file, text)
      const step = applyOps(text, c.service, ops, allowed)
      if (!step.ok) {
        failure = step.reason
        break
      }
      results.set(file, step.text)
      allChanged.push(...step.changed.map((x) => (byFile.size > 1 ? `${file}: ${x}` : x)))
    }

    const applied = failure
      ? ({ ok: false, reason: failure } as const)
      : ({ ok: true, text: results.get(c.composeFile) ?? before, changed: allChanged } as const)

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

    for (const [file, text] of results) writeFileSync(join(repoDir, file), text)
    const gate = await composeAccepts(repoDir, c.composeFile)
    if (!gate.ok) {
      for (const [file, text] of originals) writeFileSync(join(repoDir, file), text)
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

async function composeAccepts(
  repoDir: string,
  composeFile: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const r = await execa(
    'docker',
    ['compose', '-f', join(repoDir, composeFile), 'config', '--no-interpolate', '-q'],
    { reject: false, timeout: 60_000, cwd: repoDir },
  )
  return (r.exitCode ?? 1) === 0
    ? { ok: true }
    : { ok: false, reason: String(r.stderr ?? '').slice(0, 200) }
}

/** The service's own block, so the model sees its configuration and nothing else. */
function blockFor(text: string, service: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((l) =>
    new RegExp(`^\\s{1,4}${service.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*$`).test(l),
  )
  if (start === -1) return text.slice(0, 4000)
  const indent = lines[start]!.match(/^\s*/)![0].length
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!
    if (!l.trim()) continue
    if (l.match(/^\s*/)![0].length <= indent) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

function record(
  c: Candidate,
  p: Proposal,
  error: string | null,
  changed: string[],
  hunks: unknown[] = [],
): void {
  const { policy } = loadPolicy()
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

async function comment(number: number, body: string): Promise<void> {
  const [owner, repo] = env.githubRepo.split('/') as [string, string]
  await gh()
    .rest.issues.createComment({ owner, repo, issue_number: number, body })
    .catch(() => {})
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
