import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { env, loadPolicy } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { analyze, budgetExhausted, type ReviewedVerdict, type Verdict } from './claude.ts'
import { readerOn } from '../policy.ts'
import { notify } from '../notify/index.ts'
import { jevConfigured } from './jev.ts'
import { deploymentOf, type DeploymentEntry } from './screen/state.ts'
import {
  SCREEN_MONTHLY_CEILING_USD,
  runScreenPass,
  screenFor,
  screenSpendThisMonth,
  type ScreenRun,
} from './screen/run.ts'
import { backoffUntil } from '../backoff.ts'
import { llmConfigured } from './client.ts'

/**
 * Reading the changelog of every update that wants a verdict.
 *
 * Analysis is decoupled from shipping on purpose: an update waits (briefly, see
 * REVIEW_WAIT_MS) for its review but never depends on the model being reachable. The
 * verdict is stored, keyed by (image, from, to), and read by the hold logic (src/policy.ts)
 * wherever it is needed; nothing is written anywhere else.
 */

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
  /** 1 when something is waiting on this verdict: an update about to ship, or a legacy open PR. */
  has_pr: number
  /** 1 when someone asked for the existing verdict to be read again. */
  rerun: number
  detected_at: string
  /** The first update carrying this bump, most deserving first. */
  update_id: number
  magnitude: string
  /**
   * Every service carrying this exact bump. A verdict is keyed by (image, from, to) and
   * shared, so it has to be judged against all of them -- a rename that reaches one
   * stack's configuration is the review's business even when another stack asked first.
   */
  carriers: { stack: string; service: string }[]
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
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT u.id AS update_id, u.image, u.from_tag, u.to_tag, u.stack, u.service,
              u.detected_at, u.magnitude,
              CASE WHEN u.state = 'detected' AND COALESCE(u.detail, '') != 'rolling' THEN 1
                   WHEN EXISTS (
                SELECT 1 FROM pr_updates pu JOIN prs p ON p.id = pu.pr_id
                WHERE pu.update_id = u.id AND p.state = 'open'
              ) THEN 1 ELSE 0 END AS has_pr,
              CASE WHEN u.review_requested_at IS NOT NULL OR EXISTS (
                SELECT 1 FROM verdicts v
                WHERE v.image = u.image AND v.from_tag = u.from_tag AND v.to_tag = u.to_tag
                  AND v.rerun_requested_at IS NOT NULL
              ) THEN 1 ELSE 0 END AS rerun
       FROM updates u
       WHERE (
         -- Somebody pressed Read the changelog: whatever the update is, it is read.
         u.review_requested_at IS NOT NULL
         -- v2: an update about to ship, or waiting on a decision, wants its reading first.
         OR (u.state = 'detected' AND COALESCE(u.detail, '') != 'rolling')
         OR EXISTS (
           SELECT 1 FROM pr_updates pu JOIN prs p ON p.id = pu.pr_id
           WHERE pu.update_id = u.id AND p.state = 'open'
         )
         -- The backfill: what applied without anyone deciding. It used to take every
         -- minor and major in the window, and most of them had never run anywhere.
         --
         -- superseded is one word for several situations, and only some of them mean the
         -- version was never on the host. The one that is pure waste is newer target:
         -- the update was still waiting when a newer tag appeared, so its successor was
         -- written from the SAME from_tag and is read over a range that contains this one
         -- whole. Reading 1.18.30 -> 2.0.11 passes through the notes for 2.0.4 on the way,
         -- so a separate verdict buys the same prose attributed to a row nobody can act
         -- on. 162 rows are that, against 66 minor and major in any 30-day window, and it
         -- is most of the bill: 89 of the 204 verdicts ever written, about $8.17 of
         -- $25.05. When the budget was raised on 2026-09-21 the first thing the headroom
         -- bought was six dead opencode versions, 2.0.2 through 2.0.9, each read in full
         -- beside the 2.0.11 that could actually be deployed.
         --
         -- Two of the others did reach the compose file, and they are kept:
         --
         --   caught-up -- it applied out of band, so the scan found the file already
         --   past it. There is no successor row at all, so nothing else will ever carry
         --   this range. This is the backfill's own reason for existing, and the class is
         --   not hypothetical: paperless 2.20.15 -> 3.1.3 is a major that ran here.
         --
         --   a merged pull request -- the tag landed, and a later merge passed it. Its
         --   successor starts from THIS row's to_tag, so the successor's range begins
         --   where this one ended and covers none of it. Asked as a fact about a merged
         --   pull request rather than by matching the detail string, because that is what
         --   the retirement path requires by construction.
         --
         -- IS NOT rather than != so that a null state would still be offered rather than
         -- silently dropped: NULL != 'superseded' evaluates to NULL, which is not true, and
         -- the row would vanish from the backfill for a reason nobody would go looking for.
         -- The column is NOT NULL today; an operator that does not lean on that is free.
         --
         -- Worth keeping right, because a superseded row offers no verb in the interface:
         -- there is no button that asks for the review later, so a skip here is permanent.
         OR (u.magnitude IN ('minor', 'major') AND u.detected_at >= ?
             AND (
               u.state IS NOT 'superseded'
               OR u.detail = 'caught-up'
               OR EXISTS (
                 SELECT 1 FROM pr_updates pu JOIN prs p ON p.id = pu.pr_id
                 WHERE pu.update_id = u.id AND p.state = 'merged'
               )
             ))
       )
       -- A verdict that arrived is done, unless someone asked for it to be read again --
       -- or its notes could not all be fetched (a rate limit, an outage), in which case it
       -- is read again after an hour, three times at most. The old verdict stays in force
       -- meanwhile, exactly as with a requested re-read.
       -- Only a reader's verdict counts: one the screen wrote is a placeholder the reader
       -- may still be due to replace.
       AND NOT EXISTS (
         SELECT 1 FROM verdicts v
         WHERE v.image = u.image AND v.from_tag = u.from_tag AND v.to_tag = u.to_tag
           AND v.error IS NULL AND v.rerun_requested_at IS NULL
           AND u.review_requested_at IS NULL
           AND COALESCE(v.source, 'reader') = 'reader'
           AND NOT (
             json_extract(v.evidence, '$.incomplete') = 1
             AND COALESCE(json_extract(v.evidence, '$.attempt'), 1) <= ${INCOMPLETE_REREADS}
             AND COALESCE(json_extract(v.evidence, '$.readAt'), v.created_at) <= ?
           )
       )
       -- A failure that will fail again is not work. Without this, one unreachable
       -- changelog is retried on every poll cycle for as long as the pull request is
       -- open, which is where 852 identical log lines came from.
       -- (Not only an error row: a reader that failed over a screen's verdict keeps the
       -- screen's verdict in place and waits out the same backoff.)
       AND NOT EXISTS (
         SELECT 1 FROM verdicts v
         WHERE v.image = u.image AND v.from_tag = u.from_tag AND v.to_tag = u.to_tag
           AND v.next_attempt_at IS NOT NULL AND v.next_attempt_at > ?
       )
       -- A requested re-read first: somebody pressed a button and is waiting to see it.
       ORDER BY rerun DESC, has_pr DESC, u.detected_at DESC`,
    )
    .all(
      sinceForUnreviewed(),
      new Date(Date.now() - INCOMPLETE_WAIT_MS).toISOString(),
      new Date().toISOString(),
    ) as Omit<PendingAnalysis, 'carriers'>[]

  // One entry per bump. The query returns one row per service carrying it, so the same
  // range used to be read once per stack in a single pass -- and each copy took one of the
  // pass's three slots. The first row of a group is its most deserving, because of the
  // ordering above, so it supplies the priority and the service whose labels apply.
  const byKey = new Map<string, PendingAnalysis>()
  for (const r of rows) {
    const key = `${r.image}\u0000${r.from_tag}\u0000${r.to_tag}`
    const seen = byKey.get(key)
    if (seen) {
      if (!seen.carriers.some((c) => c.stack === r.stack && c.service === r.service)) {
        seen.carriers.push({ stack: r.stack, service: r.service })
      }
      continue
    }
    byKey.set(key, { ...r, carriers: [{ stack: r.stack, service: r.service }] })
  }
  return [...byKey.values()].slice(0, limit)
}

/** A reading whose notes could not all be fetched is tried again after this long... */
const INCOMPLETE_WAIT_MS = 60 * 60_000
/** ...this many times, and then left as it is. */
const INCOMPLETE_REREADS = 3

/**
 * The review, both stages: the screen first, then the reader on what it leaves.
 *
 * The screen runs whatever the budget says, under its own small ceiling, because it is
 * what decides whether the budget is worth spending at all. A screen verdict written
 * under `review.screen: on` is spliced into its pull requests here, the same way a cached
 * reader verdict is.
 */
export async function runReviewPass(): Promise<{ screen: ScreenRun; reader: AnalysisRun }> {
  const screen = await runScreenPass()
  const reader = await runAnalysisPass()
  return { screen, reader }
}

/**
 * Whether the reader should be paid to read this bump.
 *
 * Everything, as before, unless `review.screen` is `on`. Then: whatever somebody asked to
 * have read; otherwise only bumps with an open pull request -- a person will read what
 * the reader writes -- that are not digests (no notes to read), and that the screen did
 * not call routine. A routine bump is still read if it is a major, if the service is
 * fail-closed, or as one of the sampled audits that keep the screen honest (one update
 * in ten). A bump the screen has not reached yet waits for it, unless the screen cannot
 * run; one the screen failed on goes to the reader, which is what happened before there
 * was a screen.
 *
 * Exported because which updates get paid for is worth testing without a model in reach.
 */
export function readerWanted(
  row: Pick<PendingAnalysis, 'rerun' | 'has_pr' | 'magnitude' | 'update_id' | 'carriers'>,
  o: {
    screenMode: 'off' | 'shadow' | 'on'
    screen: { decision: string | null; error: string | null } | null
    screenCanRun: boolean
    required: boolean
  },
): boolean {
  if (row.rerun) return true
  if (o.screenMode !== 'on') return true
  if (!row.has_pr) return false
  if (row.magnitude === 'digest') return false
  if (!o.screen) return !o.screenCanRun
  if (o.screen.error || !o.screen.decision) return true
  if (o.screen.decision !== 'routine') return true
  return row.magnitude === 'major' || o.required || isAudit(row.update_id)
}

/** One routine update in ten is read anyway, so a screen that drifts is caught. */
export function isAudit(updateId: number): boolean {
  return updateId % 10 === 0
}

/** Analyse up to `limit` updates that want a verdict: open pull requests first. */
export async function runAnalysisPass(limit = 3): Promise<AnalysisRun> {
  const out: AnalysisRun = { analysed: 0, skipped: 0, failed: 0 }
  const { policy } = loadPolicy()
  if (!readerOn(policy) || !llmConfigured()) return out
  if (budgetExhausted()) {
    out.skipped++
    return out
  }

  const db = getDb()
  const screenCanRun = jevConfigured() && screenSpendThisMonth() < SCREEN_MONTHLY_CEILING_USD
  const pending = pendingAnalysis(Number.MAX_SAFE_INTEGER)
    .filter((row) =>
      readerWanted(row, {
        screenMode: policy.review.screen,
        screen: screenFor(row.image, row.from_tag, row.to_tag),
        screenCanRun,
        required: row.carriers.some((c) => requiredReview(c.stack, c.service)),
      }),
    )
    .slice(0, limit)

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
        stack: row.stack,
        service: row.service,
        observedAt: row.detected_at,
        deployment: deploymentFor(row.carriers),
      })
      if ('error' in result) {
        recordFailure(row, result.error)
        out.failed++
        continue
      }
      const screened = screenFor(row.image, row.from_tag, row.to_tag)
      recordVerdict(row, result)
      await auditScreen(row, screened, result)
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

/** How every service carrying the bump is configured, names only. */
function deploymentFor(carriers: { stack: string; service: string }[]): DeploymentEntry[] {
  const file = getDb().prepare(`SELECT compose_file FROM images WHERE stack = ? AND service = ?`)
  return carriers
    .map((c) => {
      const row = file.get(c.stack, c.service) as { compose_file: string } | undefined
      return row ? deploymentOf(env.repoDir, row.compose_file, c.service) : null
    })
    .filter((d): d is DeploymentEntry => d !== null)
}

/** `shipshape.review: required` (or the older `shipshape.claude`), as the last scan recorded it. */
function requiredReview(stack: string, service: string): boolean {
  const row = getDb()
    .prepare(`SELECT claude_label FROM images WHERE stack = ? AND service = ?`)
    .get(stack, service) as { claude_label: string | null } | undefined
  return row?.claude_label?.trim().toLowerCase() === 'required'
}

/**
 * A reader that disagrees with a routine screen is the one thing the audit exists to
 * catch, and it is said out loud at once rather than folded into a digest.
 *
 * Disagreeing means the reader found work: a block, or steps to take. A reader that
 * merely says "read first" where the screen said routine is the screen being terse,
 * not wrong.
 */
async function auditScreen(
  row: { image: string; from_tag: string; to_tag: string; stack: string; service: string },
  screened: { decision: string | null } | null,
  v: Verdict,
): Promise<void> {
  if (screened?.decision !== 'routine') return
  if (v.recommendation !== 'block' && v.migration_steps.length === 0) return
  logEvent({
    level: 'error',
    kind: 'analysis',
    stack: row.stack,
    service: row.service,
    message: `the screen called ${row.stack}/${row.service} ${row.to_tag} routine; the reader found work`,
    detail: (v.migration_steps[0] ?? v.breaking_changes[0] ?? v.summary).slice(0, 200),
  })
  await notify({
    key: `shipshape:screen-miss:${row.service}`,
    status: 'event',
    title: `shipshape: screen missed ${row.service} ${row.to_tag}`,
    body:
      `The screen called ${row.image} ${row.from_tag} -> ${row.to_tag} routine; a full reading found ` +
      `${v.recommendation === 'block' ? 'breaking changes' : 'steps to take'}.\n\n${v.summary}\n\n` +
      'If this is not a one-off, set review.screen back to shadow in policy.yaml.',
    priority: 4,
    tags: ['warning'],
  })
}



/** Exported for the tests, like the rest of the bookkeeping here. */
export function recordVerdict(
  row: { image: string; from_tag: string; to_tag: string },
  v: ReviewedVerdict,
): void {
  const { policy } = loadPolicy()
  const db = getDb()
  const now = new Date().toISOString()
  clearRequest(row)

  // Which incomplete reading this is: the first, or a re-read of one that was also incomplete.
  const prior = db
    .prepare(`SELECT evidence FROM verdicts WHERE image = ? AND from_tag = ? AND to_tag = ?`)
    .get(row.image, row.from_tag, row.to_tag) as { evidence: string | null } | undefined
  let priorAttempt = 0
  try {
    const p = prior?.evidence ? (JSON.parse(prior.evidence) as { incomplete?: boolean; attempt?: number }) : null
    if (p?.incomplete) priorAttempt = p.attempt ?? 1
  } catch {
    priorAttempt = 0
  }
  const evidence = v.evidence
    ? JSON.stringify({ ...v.evidence, readAt: now, attempt: v.evidence.incomplete ? priorAttempt + 1 : 0 })
    : null

  db.prepare(
    `INSERT INTO verdicts (image, from_tag, to_tag, summary, severity, breaking_changes,
                           migration_steps, new_features, recommendation, confidence, sources, model,
                           cost_usd, error, created_at, evidence, source, provisional, irreversible)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 'reader', 0, ?)
     ON CONFLICT(image, from_tag, to_tag) DO UPDATE SET
       source = 'reader', provisional = 0,
       summary = excluded.summary, severity = excluded.severity,
       breaking_changes = excluded.breaking_changes,
       migration_steps = excluded.migration_steps,
       new_features = excluded.new_features,
       recommendation = excluded.recommendation, confidence = excluded.confidence,
       sources = excluded.sources, model = excluded.model, error = NULL,
       next_attempt_at = NULL, rerun_requested_at = NULL,
       created_at = excluded.created_at, evidence = excluded.evidence,
       irreversible = excluded.irreversible`,
  ).run(
    row.image,
    row.from_tag,
    row.to_tag,
    v.summary,
    v.severity,
    JSON.stringify(v.breaking_changes),
    JSON.stringify(v.migration_steps),
    JSON.stringify(v.new_features),
    v.recommendation,
    v.confidence,
    JSON.stringify(v.sources),
    policy.review.model,
    now,
    evidence,
    v.irreversible ? 1 : 0,
  )
}

/** A Read the changelog press has been answered, one way or the other. */
function clearRequest(row: { image: string; from_tag: string; to_tag: string }): void {
  getDb()
    .prepare(`UPDATE updates SET review_requested_at = NULL WHERE image = ? AND from_tag = ? AND to_tag = ?`)
    .run(row.image, row.from_tag, row.to_tag)
}

/**
 * When to try a failed analysis again: 15 minutes, then four times that each attempt,
 * capped at a day. Most failures are a rate limit or a flaky fetch and clear on the
 * second try; the rest are permanent, and the cap is what stops them costing a call an
 * hour forever.
 */
export function nextAttemptAt(attempts: number, now = Date.now()): string {
  return backoffUntil(attempts, { baseMs: 15 * 60_000, capMs: 24 * 60 * 60_000 }, now)
}

export function recordFailure(
  row: { image: string; from_tag: string; to_tag: string },
  error: string,
): void {
  const db = getDb()
  clearRequest(row)
  const prior = db
    .prepare(
      `SELECT attempts, error, recommendation, source FROM verdicts
       WHERE image = ? AND from_tag = ? AND to_tag = ?`,
    )
    .get(row.image, row.from_tag, row.to_tag) as
    | { attempts: number; error: string | null; recommendation: string | null; source: string | null }
    | undefined

  // The reader failed over a verdict the screen wrote. That verdict stays -- a finding
  // keeps holding the merge, a routine approval keeps allowing it -- and the reader waits
  // out a backoff rather than being retried every tick at code-model prices.
  if (prior && prior.error === null && prior.recommendation !== null && prior.source === 'screen') {
    const attempts = prior.attempts + 1
    db.prepare(
      `UPDATE verdicts SET attempts = ?, next_attempt_at = ?, rerun_requested_at = NULL
        WHERE image = ? AND from_tag = ? AND to_tag = ?`,
    ).run(attempts, nextAttemptAt(attempts), row.image, row.from_tag, row.to_tag)
    logEvent({
      level: 'warn',
      kind: 'analysis',
      message: 'the reader could not read the changelog; the screen\'s verdict stands',
      detail: `${row.image} ${row.from_tag} -> ${row.to_tag} (attempt ${attempts}): ${error.slice(0, 140)}`,
    })
    return
  }

  // A re-read that failed. The verdict it was meant to replace is still the best reading
  // there is, so it stays -- writing the error over it would make the gate see "no
  // verdict", fall back to static policy, and merge what the verdict was holding.
  if (prior && prior.error === null && prior.recommendation !== null) {
    // A re-read of incomplete notes that failed counts as one of its tries, and waits its
    // hour again -- or the same failure would be retried on every poll cycle.
    db.prepare(
      `UPDATE verdicts SET rerun_requested_at = NULL,
         evidence = CASE WHEN json_extract(evidence, '$.incomplete') = 1
           THEN json_set(evidence, '$.readAt', ?, '$.attempt', COALESCE(json_extract(evidence, '$.attempt'), 1) + 1)
           ELSE evidence END
       WHERE image = ? AND from_tag = ? AND to_tag = ?`,
    ).run(new Date().toISOString(), row.image, row.from_tag, row.to_tag)
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
