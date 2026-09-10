import { Cron } from 'croner'
import { configured, env, inBlackout, loadPolicy } from './config.ts'
import { logEvent } from './db.ts'
import { runAnalysisPass } from './analyze/run.ts'
import { runProposePass } from './propose/run.ts'
import { runAutoMerge } from './gitops/automerge.ts'
import { pollIntervalMs, pollPrs } from './gitops/poll.ts'
import { drainDeployQueue, hasPendingDeploys, runRechecks } from './deploy/queue.ts'
import { runPrPass } from './gitops/pr.ts'
import { runScan } from './scan.ts'
import { flush as flushDigest, lastItemId, prune as pruneDigest } from './notify/digest.ts'
import { claimDigestSlot, digestOwed, MAX_WAIT_MS, requestDigest } from './notify/barrier.ts'
import { checkGitHubAuth } from './health/github-auth.ts'
import { ingestInstructions } from './revise/ingest.ts'
import { runInstructionPass } from './revise/run.ts'
import { createTicker, type Ticker } from './loop/ticker.ts'

/**
 * Nightly scan scheduling.
 *
 * The cron string is re-read from policy.yaml on every fire, so editing the schedule
 * takes effect without restarting the container -- consistent with the rest of the
 * config, which is tracked in the watched repository rather than baked into the image.
 */

let job: Cron | null = null
let currentExpression = ''
let deferTimer: NodeJS.Timeout | null = null

let digestJob: Cron | null = null
let digestExpression = ''

/** When the deferred scan is due, for the UI to show. */
let deferredScanAt: string | null = null

/**
 * The pull-request loop's heartbeat. Null until the loop is running.
 *
 * Exposed at module scope for one caller: the digest schedule. The loop is what sends
 * the digest now, and on a quiet morning the loop is on its ten-minute idle cadence with
 * a timer already armed -- so 08:00's summary would go out at some point before 08:10
 * for no reason at all. Recomputing the interval is not enough; the timer that is
 * already ticking has to be replaced, which is what `wake` does.
 */
let prLoop: Ticker | null = null

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
  schedule()
  scheduleDigest()
  startPrLoop()
}

/**
 * The digest clock, separate from the scan's.
 *
 * They are different questions -- "when should shipshape go and look" and "when do you
 * want to hear about it" -- and tying them together would mean an operator who scans
 * hourly gets hourly pushes. The default sits a few hours after the default scan so a
 * night's work has landed before the summary goes out.
 */
function scheduleDigest(): void {
  const { policy } = loadPolicy()
  digestExpression = policy.notify.cron
  digestJob?.stop()
  digestJob = new Cron(digestExpression, { timezone: env.tz }, () => {
    const { policy: now } = loadPolicy()
    // Pick up a schedule edit without a restart, the same way the scan does.
    if (now.notify.cron !== digestExpression) {
      scheduleDigest()
      return
    }
    if (now.notify.routine !== 'digest') return
    // The clock says the digest is owed; the pull-request loop decides when it goes out.
    // See notify/barrier.ts -- sending from here would mean sampling shared state from a
    // timer running beside the work, which is the arrangement this replaced.
    requestDigest()
    // ...but the loop has to be asked, or 08:00's digest waits out whatever remains of a
    // ten-minute idle interval before anything looks at it.
    prLoop?.wake()
  })
}

/**
 * Send the digest, if one is owed and this tick left nothing unfinished.
 *
 * Called at the end of every tick, inside the loop rather than beside it. `worked` is
 * the tick's own account of itself; `hasPendingDeploys` covers work queued but not yet
 * carried out. Together they are the whole definition of quiet, and both are read at the
 * one point in the cycle where nothing else is running.
 *
 * The summary is meant to describe a night that is over. A merge at 07:58 whose deploy
 * is still running at 08:00 used to be reported as "merged", with the deploy landing in
 * *tomorrow's* digest -- one event split across two mornings. Now the digest waits for
 * the chain to finish, then describes the outcome.
 *
 * Everything here is guarded: it runs from the tick's `finally`, and a throw would stop
 * the loop rescheduling itself.
 */
async function settleDigest(worked: boolean): Promise<void> {
  try {
    if (!digestOwed()) return
    const slot = claimDigestSlot(!worked && !hasPendingDeploys())
    if (!slot.send) return

    if (slot.reason === 'deadline') {
      logEvent({
        level: 'info',
        kind: 'system',
        message: 'digest sent with work still in flight',
        detail: `waited ${Math.round(MAX_WAIT_MS / 60_000)}m; the rest will appear in the next digest`,
      })
    }
    await flushDigest('cron')
    pruneDigest()
  } catch (err) {
    logEvent({
      level: 'warn',
      kind: 'system',
      message: 'could not send the digest',
      detail: (err as Error).message,
    })
  }
}

/** Rebuild the digest job, so a schedule edited in the UI applies immediately. */
export function rescheduleDigest(): void {
  scheduleDigest()
}

/**
 * The pull-request loop: notice merges, then open whatever is newly eligible.
 *
 * Self-rescheduling rather than a fixed interval, because the cadence depends on
 * whether anything is open -- a minute while PRs are in flight, ten when idle.
 */
function startPrLoop(): void {
  const tick = async (): Promise<void> => {
    // Whether this tick left anything unfinished, for the digest barrier below.
    let worked = false
    // The digest watermark as the tick began. Zero if it could not be read, which makes
    // any existing item read as new -- the conservative direction, since a tick wrongly
    // called busy delays the digest where one wrongly called quiet truncates it.
    let before = 0
    try {
      before = lastItemId()
      const { policy } = loadPolicy()
      // Outside the gate below on purpose. A dead credential is worth saying whether or
      // not the engine is parked or the hour is quiet -- those stop shipshape acting,
      // which is a choice, where this stops it working, which is a fault. It is also the
      // only check that runs when `prs.enabled` is false, and the state it reports is
      // exactly what the operator would otherwise have to infer from a silent backlog.
      await checkGitHubAuth()
      // Outside the gate, for the same reason the auth probe is: this is a GitHub read
      // that touches no git and no host, and the blackout exists to keep shipshape away
      // from another updater's file writes. Inside it, a comment left at 01:00 would go
      // unrecorded for 105 minutes -- and an unrecorded comment is one that does not
      // hold the merge, which is the one thing this must never fail to do.
      await ingestInstructions()
      if (policy.prs.enabled && !inBlackout(policy)) {
        await pollPrs()
        // After polling, so every merge this tick noticed is queued before any of them
        // is acted on, and one slow verify window cannot hide the others.
        const drained = await drainDeployQueue()
        await runRechecks()
        const result = await runPrPass()
        // Analysis runs after PR creation, not before: a pull request must appear
        // whether or not the model is reachable.
        await runAnalysisPass()
        // After analysis, because a proposal is only drafted once a verdict says the
        // update needs more than its tag.
        await runProposePass()
        // After drafting, so a comment about the drafted changes is answered against the
        // branch as it actually stands. Its hold is already in force either way -- that
        // was decided by ingestion, above the gate, before any of this ran.
        await runInstructionPass()
        // Last, so a pull request opened this cycle has had its verdict and any
        // proposal before anything considers merging it.
        const merge = await runAutoMerge()
        // Two of the three questions the barrier asks; the watermark is the third, and
        // it is asked below so that it covers the whole tick rather than this block.
        // `drained.ran` catches a deploy that finished without recording a digest line
        // -- a rollback, say, which sets `ran` before it branches on the outcome. And
        // `merge.merged` catches the gap that made a timer unworkable in the first
        // place: a merge is not queued for deploy until the *next* tick's `pollPrs`
        // notices it, so at this instant there is nothing pending to see and the tick is
        // nowhere near finished.
        worked = drained.ran > 0 || merge.merged > 0
        if (result.paused) {
          logEvent({
            level: 'info',
            kind: 'pr',
            message: 'pull request pass skipped',
            detail: result.paused,
          })
        }
      }
    } catch (err) {
      // A tick that failed part way through is not a quiet one: whatever it was doing is
      // unfinished, and the digest should wait for the retry rather than report a
      // half-done night as the outcome.
      worked = true
      logEvent({
        level: 'error',
        kind: 'pr',
        message: 'pull request loop failed',
        detail: (err as Error).message,
      })
    } finally {
      // The watermark is read here so it spans the whole tick, including the passes that
      // run above the blackout gate. A throw is contained by the ticker, which arms the
      // next tick whatever happens in this one.
      await settleDigest(worked || lastItemId() > before)
    }
  }

  prLoop = createTicker(tick, pollIntervalMs)
  // Give the first scan a moment before touching git.
  prLoop.start(20_000)
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

  // Scans only read registries, so a blackout does not strictly bind them -- but the
  // window exists to keep shipshape away from WUD's nightly rewrite, and an operator who
  // moves the cron into it should get the protection anyway.
  if (inBlackout(policy)) {
    const delayMs = msUntilBlackoutEnds(policy.sync.blackout) + 60_000 + Math.random() * 60_000
    logEvent({
      level: 'info',
      kind: 'scan',
      message: 'scan deferred: inside blackout window',
      detail: `retrying in ${Math.round(delayMs / 60_000)}m`,
    })
    if (deferTimer) clearTimeout(deferTimer)
    deferredScanAt = new Date(Date.now() + delayMs).toISOString()
    deferTimer = setTimeout(() => void fire(), delayMs)
    return
  }

  deferredScanAt = null
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
  digest: { cron: string; nextAt: string | null; owed: boolean }
  prLoop: { nextTickAt: string | null }
} {
  const { policy } = loadPolicy()
  return {
    scan: {
      cron: policy.scan.cron,
      // A deferral is the honest answer while one is pending: the cron says 03:00, the
      // blackout says not yet.
      nextAt: deferredScanAt ?? job?.nextRun()?.toISOString() ?? null,
      deferred: deferredScanAt !== null,
    },
    digest: {
      cron: policy.notify.cron,
      nextAt: policy.notify.routine === 'digest' ? (digestJob?.nextRun()?.toISOString() ?? null) : null,
      // The same honesty the scan's deferral gets: between the schedule firing and the
      // loop finding a quiet tick, "next digest: in 23 hours" is the wrong answer.
      owed: digestOwed(),
    },
    prLoop: { nextTickAt: prLoop?.nextAt() ?? null },
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

/** Milliseconds until the end of whichever configured window contains "now". */
function msUntilBlackoutEnds(windows: string[]): number {
  const now = new Date()
  const mins = now.getHours() * 60 + now.getMinutes()
  let best = 15 * 60_000
  for (const w of windows) {
    const [from, to] = w.split('-') as [string, string]
    const [fh, fm] = from.split(':').map(Number) as [number, number]
    const [th, tm] = to.split(':').map(Number) as [number, number]
    const start = fh * 60 + fm
    const end = th * 60 + tm
    const inside = start <= end ? mins >= start && mins < end : mins >= start || mins < end
    if (!inside) continue
    const untilMins = end >= mins ? end - mins : 24 * 60 - mins + end
    best = Math.max(best, untilMins * 60_000)
  }
  return best
}
