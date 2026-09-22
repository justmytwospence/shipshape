import { loadPolicy } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { monthlySpend } from '../analyze/claude.ts'
import { notify } from '../notify/index.ts'

/**
 * Saying so when the analysis budget runs out.
 *
 * Written from a specific silence, and the same shape as the one `github-auth.ts` exists
 * for. The monthly cap was reached on 2026-08-27 and again on 2026-09-14. Both times
 * analysis simply stopped: the container stayed green, scanning carried on, pull requests
 * went on opening -- and auto-merge went on merging them, with no changelog read. Of the
 * 40 pull requests merged between 2026-09-14 and 2026-09-21, 39 carried no review at all.
 *
 * The reason nothing was said is worth keeping written down, because it is not an
 * oversight anyone would spot by reading either half on its own. The only line that ever
 * mentioned the budget lived in `recordCost`, which runs *after* a model call. Once
 * `budgetExhausted()` starts refusing to make calls, `recordCost` never runs again -- so
 * the warning fires exactly once, on the call that crossed the line, and then the
 * condition it was warning about persists for the rest of the month in total silence.
 * A message that stops being sent precisely because the thing it reports got worse is
 * the failure mode, not the volume.
 *
 * So the question is asked directly, on a timer, rather than as a side effect of spending:
 * is the budget spent right now? That has an answer whether or not anything is being
 * analysed, which is exactly what the old warning did not.
 *
 * What this module does NOT do is change whether anything merges. The gate's fail-open on
 * an absent verdict is deliberate and is argued in `policy.ts`; a provider outage must not
 * freeze every update. Budget exhaustion is a weaker case for fail-open than an outage --
 * it is self-inflicted, knowable in advance, and lasts until the 1st -- but the fix for
 * "nobody knew" is to tell somebody, not to quietly invert a documented safety decision
 * underneath them. `shipshape.claude: required` remains the per-service way to say
 * "rather stall than merge unread".
 */

/** How long a standing exhaustion waits before saying it again. */
const REMIND_MS = 24 * 60 * 60 * 1000

export interface BudgetReading {
  exhausted: boolean
  spent: number
  budget: number
}

/**
 * Where the month stands, as a pure function of the two numbers.
 *
 * `budget <= 0` is not exhaustion: zero or negative reads as "no ceiling configured", and
 * alerting that an unset budget has been exceeded on every tick of every install that
 * never set one is how this channel would get muted.
 */
export function classifyBudget(spent: number, budget: number): BudgetReading {
  return { exhausted: budget > 0 && spent >= budget, spent, budget }
}

/**
 * When analysis starts again on its own.
 *
 * `monthlySpend` returns 0 whenever the recorded window is not the current month, so the
 * stop clears at midnight on the 1st with nothing to reset and no job to run. That makes
 * the date a fact worth putting in the message: the operator can decide to wait rather
 * than having to guess whether waiting works.
 */
export function resumesOn(now = new Date()): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return next.toISOString().slice(0, 10)
}

/**
 * How many pull requests merged unread since a given moment.
 *
 * The number is the point of the message. "Analysis is paused" is a status; "17 updates
 * have merged unread since Tuesday, and counting" is the same fact in the terms the
 * operator actually cares about, and it grows every day the condition stands -- so the
 * daily reminder says something new each time rather than repeating itself.
 */
export function mergedUnreviewedSince(since: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(DISTINCT p.number) AS n
         FROM prs p
         JOIN pr_updates pu ON pu.pr_id = p.id
         JOIN updates u ON u.id = pu.update_id
        WHERE p.state = 'merged' AND p.merged_at >= ?
          AND NOT EXISTS (
            SELECT 1 FROM verdicts v
             WHERE v.image = u.image AND v.from_tag = u.from_tag AND v.to_tag = u.to_tag
               AND v.error IS NULL AND v.recommendation IS NOT NULL
          )`,
    )
    .get(since) as { n: number } | undefined
  return row?.n ?? 0
}

let spent: { since: string; lastAlertAt: number } | null = null

/** For the Status page, so a budget line can say what it currently means. */
export function budgetHealth(): { ok: boolean; since?: string; unreviewed?: number } {
  if (!spent) return { ok: true }
  return { ok: false, since: spent.since, unreviewed: mergedUnreviewedSince(spent.since) }
}

/**
 * Record that the budget is spent, and say so -- once, then daily while it lasts.
 *
 * An alert rather than a digest item, for the reason alerts exist: what is wrong is
 * happening now and goes on happening. Every merge made between this message and the next
 * one is a merge nobody read the changelog for, so holding it until 08:00 costs a night of
 * exactly the thing the tool is for.
 */
export async function noteBudgetSpent(reading: BudgetReading): Promise<void> {
  const now = Date.now()
  if (spent && now - spent.lastAlertAt < REMIND_MS) return
  const fresh = !spent
  const since = spent?.since ?? new Date(now).toISOString()
  spent = { since, lastAlertAt: now }

  const unreviewed = mergedUnreviewedSince(since)
  logEvent({
    level: 'warn',
    kind: 'analysis',
    message: 'monthly analysis budget is spent',
    detail: `$${reading.spent.toFixed(2)} of $${reading.budget} — nothing is being reviewed`,
  })
  await notify({
    title: 'shipshape: the analysis budget is spent',
    body: [
      `$${reading.spent.toFixed(2)} of $${reading.budget} used this month.`,
      '',
      'Changelog reviews, drafted config changes and replies to your comments are all',
      'suspended. Scanning and pull requests carry on -- and so does auto-merge, so',
      'anything it merges while this lasts is merged without the changelog being read.',
      unreviewed > 0
        ? `${unreviewed} pull request${unreviewed === 1 ? ' has' : 's have'} merged unread since ${since.slice(0, 10)}.`
        : '',
      '',
      `It resumes on its own on ${resumesOn()}. To restart it now, raise`,
      '`claude.monthly_budget_usd` in shipshape/config/policy.yaml, or on the Settings page.',
      fresh ? '' : `Still spent since ${since.slice(0, 10)}.`,
    ]
      .filter(Boolean)
      .join('\n'),
    priority: 4,
    tags: ['warning'],
  })
}

/** Clear a standing exhaustion, and say that too -- silence is how the last one lasted. */
export async function noteBudgetAvailable(): Promise<void> {
  if (!spent) return
  const since = spent.since
  const unreviewed = mergedUnreviewedSince(since)
  spent = null
  logEvent({ level: 'info', kind: 'analysis', message: 'analysis budget is available again' })
  await notify({
    title: 'shipshape: analysis is running again',
    body: [
      `The budget had been spent since ${since.slice(0, 10)}.`,
      unreviewed > 0
        ? `${unreviewed} pull request${unreviewed === 1 ? '' : 's'} merged unread while it lasted; minor and major updates are re-read after the fact, patches are not.`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
    priority: 3,
    tags: ['white_check_mark'],
  })
}

/**
 * Read the budget and alert on the transition. Safe to call every tick.
 *
 * Skipped entirely when analysis is switched off or unconfigured: a budget that nothing is
 * spending cannot run out, and an install that has not opted into analysis has not asked
 * for anything to be watched.
 */
export async function checkAnalysisBudget(): Promise<BudgetReading | null> {
  const { policy } = loadPolicy()
  if (policy.claude.mode === 'off') return null
  const reading = classifyBudget(monthlySpend(), policy.claude.monthly_budget_usd)
  if (reading.exhausted) await noteBudgetSpent(reading)
  else await noteBudgetAvailable()
  return reading
}

/** Test seam: the module holds one standing condition, and tests need it reset. */
export function resetBudgetHealth(): void {
  spent = null
}
