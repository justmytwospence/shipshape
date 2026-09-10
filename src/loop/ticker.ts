/**
 * A self-rescheduling timer that can be brought forward.
 *
 * The pull-request loop has always rescheduled itself rather than running on a fixed
 * interval, because the right cadence depends on whether anything is in flight -- a
 * minute while pull requests are open, ten when idle. Two things made that worth pulling
 * out into a unit of its own.
 *
 * The first is that something now needs to *interrupt* the wait. The digest is sent by
 * the loop, so on a quiet morning 08:00's summary would sit behind whatever remained of
 * a ten-minute interval. Recomputing the interval does not help: the timer that is
 * already ticking has to be replaced. But a naive `clearTimeout` and re-arm can start a
 * second tick on top of one already running, and the loop's whole shape -- poll, deploy,
 * open, analyse, merge, in that order -- assumes one at a time.
 *
 * The second is that the reschedule is load-bearing in a way that is easy to miss. If a
 * tick ever fails to arm the next one, shipshape stops: no polls, no merges, no deploys,
 * and no error, because the thing that would have logged it is the thing that stopped.
 * So nothing here is allowed to throw, including the interval callback, which reads
 * policy and the database.
 */
export interface Ticker {
  /** Arm the first tick. */
  start(delayMs: number): void
  /** Ask for a tick now, or as soon as the one in flight finishes. */
  wake(): void
  /** When the next tick is due, ISO, or null before the first `start`. */
  nextAt(): string | null
  /** Stop rescheduling. */
  stop(): void
}

/** Used when the interval callback throws or answers nonsense. */
export const FALLBACK_INTERVAL_MS = 60_000

export function createTicker(run: () => Promise<void>, interval: () => number): Ticker {
  let timer: ReturnType<typeof setTimeout> | null = null
  let ticking = false
  let woken = false
  let stopped = false
  let nextAt: string | null = null

  const arm = (waitMs: number): void => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    nextAt = new Date(Date.now() + waitMs).toISOString()
    timer = setTimeout(() => void tick(), waitMs)
    timer.unref?.()
  }

  const nextWait = (): number => {
    try {
      const ms = interval()
      // A NaN or a negative would arm immediately and spin the loop at full speed.
      return Number.isFinite(ms) && ms >= 0 ? ms : FALLBACK_INTERVAL_MS
    } catch {
      return FALLBACK_INTERVAL_MS
    }
  }

  const tick = async (): Promise<void> => {
    ticking = true
    try {
      await run()
    } catch {
      // The caller logs its own failures. Swallowed here so a throw can never reach the
      // reschedule below, which is the only thing keeping the loop alive.
    } finally {
      ticking = false
      // A wake that arrived mid-tick is honoured now rather than dropped, and only
      // once: the tick after a woken one goes back to the normal cadence.
      arm(woken ? 0 : nextWait())
      woken = false
    }
  }

  return {
    start: (delayMs: number): void => arm(delayMs),
    wake: (): void => {
      if (ticking) {
        // Re-arming now would run two ticks at once. The tick in flight reschedules
        // itself to zero when it finishes.
        woken = true
        return
      }
      arm(0)
    },
    nextAt: (): string | null => nextAt,
    stop: (): void => {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      nextAt = null
    },
  }
}
