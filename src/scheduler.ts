import { Cron } from 'croner'
import { configured, env, loadPolicy } from './config.ts'
import { getDb, logEvent } from './db.ts'
import { runReviewPass } from './analyze/run.ts'
import { runProposePass } from './propose/run.ts'
import { drainDeployQueue, hasDueRechecks, hasPendingDeploys, runRechecks } from './deploy/queue.ts'
import { runShipPass } from './gitops/ship.ts'
import { runCutover } from './gitops/cutover.ts'
import { runScan } from './scan.ts'
import { checkGitHubAuth } from './health/github-auth.ts'
import { retryPendingIncidents } from './notify/index.ts'
import { syncDecisionCards } from './notify/decisions.ts'
import { checkAnalysisBudget } from './health/analysis-budget.ts'
import { createTicker, type Ticker } from './loop/ticker.ts'
import { logRetired, retireOvertaken } from './updates/overtaken.ts'
import { startSecurityLoop } from './security/loop.ts'

/**
 * Nightly scan scheduling.
 *
 * The cron string is re-read from policy.yaml on every fire, so editing the schedule
 * takes effect without restarting the container -- consistent with the rest of the
 * config, which is tracked in the watched repository rather than baked into the image.
 */

let job: Cron | null = null
let currentExpression = ''

/** The main loop's heartbeat. Null until the loop is running. */
let loop: Ticker | null = null

/** Wake the loop now: a verb was pressed and the next thing to do should not wait out the idle interval. */
export function wakeLoop(): void {
  loop?.wake()
}

export function startScheduler(): void {
  const setup = configured()
  if (!setup.ok) {
    // Nothing can run without knowing which repository to watch. Say so once, plainly,
    // and let the web UI carry the instructions.
    logEvent({
      level: 'warn',
      kind: 'system',
      message: 'not configured yet — scanning and pull requests are standing by',
      detail: setup.missing.map((m) => m.name).join(', '),
    })
    return
  }
  // Updates stranded before merges retired what they overtook. From here on the merge path
  // does it; this clears what came before. A failure here must not stop anything starting.
  try {
    logRetired(retireOvertaken())
  } catch (err) {
    logEvent({ level: 'warn', kind: 'system', message: 'could not retire overtaken updates', detail: (err as Error).message })
  }
  schedule()
  startLoop()
  // Security incidents against what runs here, on its own clock (src/security/loop.ts).
  // Off unless policy.yaml turns it on; the loop checks on every tick.
  startSecurityLoop()
}

/** Busy while anything is in flight, so a deploy or a ship is not left waiting out the idle interval. */
export function loopIntervalMs(): number {
  const { policy } = loadPolicy()
  const open = (getDb().prepare(`SELECT COUNT(*) c FROM updates WHERE state = 'detected'`).get() as { c: number }).c > 0
  const busy = open || hasPendingDeploys() || hasDueRechecks()
  return (busy ? policy.sync.poll_active_s : policy.sync.poll_idle_s) * 1000
}

/**
 * The main loop: review what was detected, ship what is ready, deploy what shipped.
 *
 * Self-rescheduling rather than a fixed interval, because the cadence depends on whether
 * anything is in flight -- a minute while work is pending, ten when idle.
 */
function startLoop(): void {
  const tick = async (): Promise<void> => {
    try {
      // First, and whatever else this tick does. A dead credential stops shipshape
      // working, which is a fault rather than a choice, and the state it reports is
      // exactly what the operator would otherwise have to infer from a silent backlog.
      await checkGitHubAuth()
      // One-time: close the pull requests v1 left open (src/gitops/cutover.ts).
      await runCutover()
      // Incidents the router could not take earlier: at least once, latest state wins.
      await retryPendingIncidents()
      // One card per decision waiting on you, kept in line with the Inbox. Never allowed
      // to stop the tick: a card is a convenience, the Inbox is the record.
      await syncDecisionCards().catch((err) =>
        logEvent({ level: 'warn', kind: 'system', message: 'decision cards not synced', detail: (err as Error).message }),
      )
      // Asked on the tick rather than where the budget is spent, so the question has an
      // answer even when nothing is being analysed.
      await checkAnalysisBudget()
      // Deploys first: a ship queues one, and one slow verify window must not hide the others.
      await drainDeployQueue()
      await runRechecks()
      // Review before shipping: an update waits (briefly) for its reading.
      await runReviewPass()
      // After analysis, because a change is only drafted once a verdict says the update
      // needs more than its tag.
      await runProposePass()
      // Last, so what was detected this cycle has had its verdict and any draft.
      const result = await runShipPass()
      if (result.paused) {
        logEvent({ level: 'info', kind: 'pr', message: 'ship pass skipped', detail: result.paused })
      }
    } catch (err) {
      logEvent({ level: 'error', kind: 'pr', message: 'main loop failed', detail: (err as Error).message })
    }
  }

  loop = createTicker(tick, loopIntervalMs)
  // Give the first scan a moment before touching git.
  loop.start(20_000)
}

function schedule(): void {
  const { policy } = loadPolicy()
  currentExpression = policy.scan.cron
  job?.stop()
  job = new Cron(currentExpression, { timezone: env.tz }, fire)
  logEvent({
    level: 'info',
    kind: 'system',
    message: 'scan scheduled',
    detail: `${currentExpression} (${env.tz}); next ${job.nextRun()?.toISOString() ?? 'unknown'}`,
  })
}

async function fire(): Promise<void> {
  const { policy } = loadPolicy()

  // Pick up a schedule edit without a restart.
  if (policy.scan.cron !== currentExpression) {
    schedule()
    return
  }

  await runScanSafely('cron')
}

/**
 * What the clocks are about to do.
 *
 * The schedules were only ever visible as "last scan 9h ago", which answers a different
 * question from the one an operator actually asks -- whether to wait or press the button.
 * croner knows the answer; nothing exported it.
 */
export function scheduleInfo(): {
  scan: { cron: string; nextAt: string | null; deferred: boolean }
  loop: { nextTickAt: string | null }
} {
  const { policy } = loadPolicy()
  return {
    scan: {
      cron: policy.scan.cron,
      nextAt: job?.nextRun()?.toISOString() ?? null,
      deferred: false,
    },
    loop: { nextTickAt: loop?.nextAt() ?? null },
  }
}

/** Rebuild the cron job, so a schedule edited in the UI applies immediately. */
export function rescheduleScan(): void {
  schedule()
}

/** Entry point for the UI button. */
export async function runScanNow(): Promise<ReturnType<typeof runScan>> {
  return runScan('manual')
}

async function runScanSafely(trigger: 'cron' | 'manual'): Promise<void> {
  try {
    await runScan(trigger)
  } catch (err) {
    logEvent({
      level: 'error',
      kind: 'scan',
      message: 'scan failed',
      detail: (err as Error).message,
    })
  }
}

