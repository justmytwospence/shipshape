import { Octokit } from 'octokit'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { env, loadPolicy } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { routine } from '../notify/digest.ts'
import { analyze, budgetExhausted, type Verdict } from './claude.ts'
import { verdictHolds, type Confidence } from '../policy.ts'

/**
 * Analysing open pull requests and folding the result back into them.
 *
 * Analysis is decoupled from PR creation on purpose: a pull request must appear whether
 * or not the model is reachable. When a verdict arrives later it is written into the
 * body between markers, and the labels change to match.
 */

let octokit: Octokit | null = null
function gh(): Octokit {
  octokit ??= new Octokit({ auth: env.githubToken })
  return octokit
}

const START = '<!-- shipshape:verdict:start -->'
const END = '<!-- shipshape:verdict:end -->'

export interface AnalysisRun {
  analysed: number
  skipped: number
  failed: number
}

/**
 * How far back to reach for updates that applied without a pull request.
 *
 * Without a bound the first pass after this shipped would try to read the changelog of
 * every minor and major release ever recorded, which is a large one-off bill for entries
 * nobody is going to scroll to. A month keeps the feed's recent end populated, which is
 * the end anyone reads, and older rows keep their links.
 */
const UNREVIEWED_WINDOW_DAYS = 30

function sinceForUnreviewed(): string {
  return new Date(Date.now() - UNREVIEWED_WINDOW_DAYS * 86_400_000).toISOString()
}

export interface PendingAnalysis {
  image: string
  from_tag: string
  to_tag: string
  stack: string
  service: string
  /** 1 when an open pull request is waiting on this verdict. */
  has_pr: number
  /** 1 when someone asked for the existing verdict to be read again. */
  rerun: number
  detected_at: string
}

/**
 * Which updates want a verdict next, most deserving first.
 *
 * One verdict per (image, from, to): the same postgres bump in three stacks is judged
 * once and reused everywhere.
 *
 * Two things want a verdict, and they are not the same thing. An open pull request wants
 * one because a decision is waiting on it. An update that applied on its own wants one
 * because otherwise nobody ever finds out what changed -- it never had a pull request to
 * carry the reading, so the releases feed would show it as a version number and nothing
 * else. Open pull requests still go first: a verdict nobody is waiting on can wait.
 *
 * Patches are deliberately excluded from the second set. They are the bulk of what lands
 * here and the least worth reading, and each one costs a model call against a budget that
 * a feed is not worth exhausting. Their changelog links are derived rather than analysed,
 * so a patch still has somewhere to send you.
 *
 * Exported because which updates get paid for is a decision worth testing on its own,
 * without a model or a network anywhere near it.
 */
export function pendingAnalysis(limit: number): PendingAnalysis[] {
  return getDb()
    .prepare(
      `SELECT DISTINCT u.image, u.from_tag, u.to_tag, u.stack, u.service, u.detected_at,
              CASE WHEN EXISTS (
                SELECT 1 FROM pr_updates pu JOIN prs p ON p.id = pu.pr_id
                WHERE pu.update_id = u.id AND p.state = 'open'
              ) THEN 1 ELSE 0 END AS has_pr,
              CASE WHEN EXISTS (
                SELECT 1 FROM verdicts v
                WHERE v.image = u.image AND v.from_tag = u.from_tag AND v.to_tag = u.to_tag
                  AND v.rerun_requested_at IS NOT NULL
              ) THEN 1 ELSE 0 END AS rerun
       FROM updates u
       WHERE (
         EXISTS (
           SELECT 1 FROM pr_updates pu JOIN prs p ON p.id = pu.pr_id
           WHERE pu.update_id = u.id AND p.state = 'open'
         )
         OR (u.magnitude IN ('minor', 'major') AND u.detected_at >= ?)
       )
       -- A verdict that arrived is done, unless someone asked for it to be read again.
       AND NOT EXISTS (
         SELECT 1 FROM verdicts v
         WHERE v.image = u.image AND v.from_tag = u.from_tag AND v.to_tag = u.to_tag
           AND v.error IS NULL AND v.rerun_requested_at IS NULL
       )
       -- A failure that will fail again is not work. Without this, one unreachable
       -- changelog is retried on every poll cycle for as long as the pull request is
       -- open, which is where 852 identical log lines came from.
       AND NOT EXISTS (
         SELECT 1 FROM verdicts v
         WHERE v.image = u.image AND v.from_tag = u.from_tag AND v.to_tag = u.to_tag
           AND v.error IS NOT NULL
           AND v.next_attempt_at IS NOT NULL AND v.next_attempt_at > ?
       )
       -- A requested re-read first: somebody pressed a button and is waiting to see it.
       ORDER BY rerun DESC, has_pr DESC, u.detected_at DESC
       LIMIT ?`,
    )
    .all(sinceForUnreviewed(), new Date().toISOString(), limit) as PendingAnalysis[]
}

/** Analyse up to `limit` updates that want a verdict: open pull requests first. */
export async function runAnalysisPass(limit = 3): Promise<AnalysisRun> {
  const out: AnalysisRun = { analysed: 0, skipped: 0, failed: 0 }
  const { policy } = loadPolicy()
  if (policy.claude.mode === 'off' || !env.anthropicApiKey) return out
  if (budgetExhausted()) {
    out.skipped++
    return out
  }

  const db = getDb()
  const pending = pendingAnalysis(limit)

  for (const row of pending) {
    if (budgetExhausted()) {
      out.skipped++
      break
    }
    try {
      const result = await analyze({
        image: row.image,
        fromTag: row.from_tag,
        toTag: row.to_tag,
        observedAt: row.detected_at,
        composeSnippet: composeSnippet(row.stack, row.service),
      })
      if ('error' in result) {
        recordFailure(row, result.error)
        out.failed++
        continue
      }
      recordVerdict(row, result)
      await applyToPrs(row, result)
      // applyToPrs writes the log line per pull request it edits. An update that applied
      // without one edits nothing, so say it here instead -- otherwise the only evidence
      // a review ran is a row quietly gaining a summary in the feed.
      if (!row.has_pr) {
        logEvent({
          level: result.recommendation === 'block' ? 'warn' : 'info',
          kind: 'analysis',
          stack: row.stack,
          service: row.service,
          message: `${row.stack}/${row.service} ${row.from_tag} -> ${row.to_tag} reviewed after the fact: ${result.recommendation} (${result.confidence} confidence)`,
          detail: result.summary.slice(0, 160),
        })
      }
      out.analysed++
    } catch (err) {
      recordFailure(row, (err as Error).message)
      out.failed++
    }
  }
  return out
}

/** The service's own compose block, so the model can flag config-relevant changes. */
function composeSnippet(stack: string, service: string): string | undefined {
  const row = getDb()
    .prepare(`SELECT compose_file FROM images WHERE stack = ? AND service = ?`)
    .get(stack, service) as { compose_file: string } | undefined
  if (!row) return undefined
  let text: string
  try {
    text = readFileSync(join(env.repoDir, row.compose_file), 'utf8')
  } catch {
    return undefined
  }
  const lines = text.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^\\s{1,4}${escape(service)}:\\s*$`).test(l))
  if (start === -1) return undefined
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
  return lines.slice(start, Math.min(end, start + 60)).join('\n')
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Exported for the tests, like the rest of the bookkeeping here. */
export function recordVerdict(
  row: { image: string; from_tag: string; to_tag: string },
  v: Verdict,
): void {
  const { policy } = loadPolicy()
  getDb()
    .prepare(
      `INSERT INTO verdicts (image, from_tag, to_tag, summary, severity, breaking_changes,
                             migration_steps, recommendation, confidence, sources, model,
                             cost_usd, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
       ON CONFLICT(image, from_tag, to_tag) DO UPDATE SET
         summary = excluded.summary, severity = excluded.severity,
         breaking_changes = excluded.breaking_changes,
         migration_steps = excluded.migration_steps,
         recommendation = excluded.recommendation, confidence = excluded.confidence,
         sources = excluded.sources, model = excluded.model, error = NULL,
         next_attempt_at = NULL, rerun_requested_at = NULL,
         created_at = excluded.created_at`,
    )
    .run(
      row.image,
      row.from_tag,
      row.to_tag,
      v.summary,
      v.severity,
      JSON.stringify(v.breaking_changes),
      JSON.stringify(v.migration_steps),
      v.recommendation,
      v.confidence,
      JSON.stringify(v.sources),
      policy.claude.model,
      new Date().toISOString(),
    )
}

/**
 * When to try a failed analysis again: 15 minutes, then four times that each attempt,
 * capped at a day. Most failures are a rate limit or a flaky fetch and clear on the
 * second try; the rest are permanent, and the cap is what stops them costing a call an
 * hour forever.
 */
export function nextAttemptAt(attempts: number, now = Date.now()): string {
  const backoffMs = Math.min(15 * 60_000 * 4 ** Math.max(0, attempts - 1), 24 * 60 * 60_000)
  return new Date(now + backoffMs).toISOString()
}

export function recordFailure(
  row: { image: string; from_tag: string; to_tag: string },
  error: string,
): void {
  const db = getDb()
  const prior = db
    .prepare(
      `SELECT attempts, error, recommendation FROM verdicts
       WHERE image = ? AND from_tag = ? AND to_tag = ?`,
    )
    .get(row.image, row.from_tag, row.to_tag) as
    | { attempts: number; error: string | null; recommendation: string | null }
    | undefined

  // A re-read that failed. The verdict it was meant to replace is still the best reading
  // there is, so it stays -- writing the error over it would make the gate see "no
  // verdict", fall back to static policy, and merge what the verdict was holding.
  if (prior && prior.error === null && prior.recommendation !== null) {
    db.prepare(
      `UPDATE verdicts SET rerun_requested_at = NULL WHERE image = ? AND from_tag = ? AND to_tag = ?`,
    ).run(row.image, row.from_tag, row.to_tag)
    logEvent({
      level: 'warn',
      kind: 'analysis',
      message: 'could not read the changelog again; the previous verdict stands',
      detail: `${row.image} ${row.from_tag} -> ${row.to_tag}: ${error.slice(0, 140)}`,
    })
    return
  }

  const attempts = (prior?.attempts ?? 0) + 1

  db.prepare(
    `INSERT INTO verdicts (image, from_tag, to_tag, error, created_at, attempts, next_attempt_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(image, from_tag, to_tag) DO UPDATE SET
         error = excluded.error, created_at = excluded.created_at,
         attempts = excluded.attempts, next_attempt_at = excluded.next_attempt_at`,
  ).run(
    row.image,
    row.from_tag,
    row.to_tag,
    error.slice(0, 400),
    new Date().toISOString(),
    attempts,
    nextAttemptAt(attempts),
  )
  logEvent({
    level: 'warn',
    kind: 'analysis',
    message: 'changelog analysis failed',
    detail: `${row.image} ${row.from_tag} -> ${row.to_tag} (attempt ${attempts}): ${error.slice(0, 140)}`,
  })
}

/**
 * Splice an already-judged verdict into whatever open pull requests now carry this bump.
 *
 * The pass above only visits pairs with no verdict at all, and only a fresh analysis
 * writes one into a pull request. So a pull request that has just been retargeted onto a
 * bump some other stack already had judged would otherwise keep "analysis has not run
 * yet" in its body for as long as it stayed open. Reusing the cache like this is the
 * point of keying verdicts by (image, from, to) rather than by pull request.
 *
 * Returns whether there was one to apply. `only` narrows it to a single pull request --
 * a retarget knows exactly which one just started carrying this bump, and applying it to
 * every pull request that shares the bump would re-announce siblings that were told about
 * it when their own verdict landed.
 */
export async function applyCachedVerdict(
  row: { image: string; from_tag: string; to_tag: string },
  only?: number,
): Promise<boolean> {
  const v = getDb()
    .prepare(
      `SELECT summary, severity, breaking_changes, migration_steps, recommendation, confidence,
              sources
         FROM verdicts
        WHERE image = ? AND from_tag = ? AND to_tag = ? AND error IS NULL`,
    )
    .get(row.image, row.from_tag, row.to_tag) as
    | {
        summary: string | null
        severity: string | null
        breaking_changes: string | null
        migration_steps: string | null
        recommendation: string | null
        confidence: string | null
        sources: string | null
      }
    | undefined
  if (!v?.recommendation) return false

  const list = (s: string | null): string[] => {
    try {
      const parsed = JSON.parse(s ?? '[]')
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  await applyToPrs(
    row,
    {
      summary: v.summary ?? '',
      severity: (v.severity ?? 'none') as Verdict['severity'],
      breaking_changes: list(v.breaking_changes),
      migration_steps: list(v.migration_steps),
      recommendation: v.recommendation as Verdict['recommendation'],
      confidence: (v.confidence ?? 'low') as Verdict['confidence'],
      sources: list(v.sources),
    },
    only,
  )
  return true
}

/** Write the verdict into every open PR carrying this update, and adjust its labels. */
async function applyToPrs(
  row: { image: string; from_tag: string; to_tag: string },
  v: Verdict,
  only?: number,
): Promise<void> {
  const prs = (
    getDb()
      .prepare(
        // Ordered so the pull request named in the digest below is a stable choice rather
        // than whichever row the query planner happened to return first.
        `SELECT DISTINCT p.number FROM prs p
       JOIN pr_updates pu ON pu.pr_id = p.id
       JOIN updates u ON u.id = pu.update_id
       WHERE p.state = 'open' AND u.image = ? AND u.from_tag = ? AND u.to_tag = ?
       ORDER BY p.number`,
      )
      .all(row.image, row.from_tag, row.to_tag) as { number: number }[]
  ).filter((p) => only === undefined || p.number === only)

  const [owner, repo] = env.githubRepo.split('/') as [string, string]
  const { policy } = loadPolicy()
  const demoted =
    policy.claude.block_on.includes(v.recommendation as 'block' | 'caution') ||
    (v.recommendation === 'approve' && rank(v.confidence) < rank(policy.claude.min_confidence))
  // Labels this verdict does not earn. A re-read that changed its mind used to leave the
  // old `claude-block` on the pull request forever, contradicting the body right below it.
  const stale = [
    ...(v.recommendation === 'block' ? [] : ['claude-block']),
    ...(demoted && v.recommendation !== 'block' ? [] : ['claude-hold']),
  ]

  for (const pr of prs) {
    try {
      const current = (await gh().rest.pulls.get({ owner, repo, pull_number: pr.number })).data.body ?? ''
      const rendered = render(v)
      const body =
        current.includes(START) && current.includes(END)
          ? current.slice(0, current.indexOf(START) + START.length) +
            `\n${rendered}\n` +
            current.slice(current.indexOf(END))
          : `${current}\n\n${START}\n${rendered}\n${END}`

      await gh().rest.pulls.update({ owner, repo, pull_number: pr.number, body })
      for (const name of ['needs-analysis', ...stale]) {
        await gh().rest.issues.removeLabel({ owner, repo, issue_number: pr.number, name }).catch(() => {})
      }
      if (v.recommendation === 'block') {
        await gh().rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels: ['claude-block'] })
      } else if (demoted) {
        await gh().rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels: ['claude-hold'] })
      }

      logEvent({
        level: v.recommendation === 'block' ? 'warn' : 'info',
        kind: 'analysis',
        message: `#${pr.number} analysed: ${v.recommendation} (${v.confidence} confidence)`,
        detail: v.summary.slice(0, 160),
      })
    } catch (err) {
      logEvent({
        level: 'warn',
        kind: 'analysis',
        message: `could not update #${pr.number} with its verdict`,
        detail: (err as Error).message.slice(0, 160),
      })
    }
  }

  // Routine, not an alert: a hold means an update is *not* being applied, so nothing is
  // broken and nothing is waiting on a fast reaction. It belongs in the summary of what
  // shipshape decided, alongside what it opened and merged.
  const held = prs.length > 0 ? heldSummary(prs[0]!.number, row.to_tag, v, policy.claude.min_confidence) : null
  if (held) {
    await routine({
      category: 'held',
      summary: held,
      detail: `${row.image} ${row.from_tag} -> ${row.to_tag}\n\n${v.summary}`,
      url: `https://github.com/${env.githubRepo}/pull/${prs[0]!.number}`,
    })
  }
}

/**
 * The digest line for a verdict that holds a merge, or null when it does not hold one.
 *
 * It used to fire for `block` only, and always say "breaking changes" -- so a block that
 * listed none was announced as breaking, and a `caution`, which holds a merge exactly as
 * firmly, never reached "waiting on you" at all. Which verdicts hold is asked of the gate.
 */
export function heldSummary(
  prNumber: number,
  toTag: string,
  v: Pick<Verdict, 'recommendation' | 'confidence'>,
  minConfidence: Confidence,
): string | null {
  if (!verdictHolds(v.recommendation, v.confidence, minConfidence)) return null
  switch (v.recommendation) {
    case 'block':
      return `#${prNumber} held — breaking changes in ${toTag}`
    case 'caution':
      return `#${prNumber} held — worth a read before ${toTag}`
    default:
      return `#${prNumber} held — approved, but only at ${v.confidence} confidence`
  }
}

function rank(c: string): number {
  return c === 'high' ? 2 : c === 'medium' ? 1 : 0
}

const ICON: Record<string, string> = { approve: '✅', caution: '⚠️', block: '⛔' }

function render(v: Verdict): string {
  const lines = [
    `### Changelog analysis`,
    ``,
    `${ICON[v.recommendation] ?? ''} **${v.recommendation}** · severity \`${v.severity}\` · confidence \`${v.confidence}\``,
    ``,
    v.summary,
  ]
  if (v.breaking_changes.length > 0) {
    lines.push('', '**Breaking changes**', ...v.breaking_changes.map((b) => `- ${b}`))
  }
  if (v.migration_steps.length > 0) {
    lines.push('', '**Required steps**', ...v.migration_steps.map((s) => `- ${s}`))
  }
  if (v.sources.length > 0) {
    lines.push('', '<details><summary>Sources</summary>', '', ...v.sources.map((s) => `- ${s}`), '</details>')
  }
  lines.push('', `<sub>Written by \`${loadPolicy().policy.claude.model}\`. Release notes are untrusted input; this verdict can withhold a merge but never cause one.</sub>`)
  return lines.join('\n')
}
