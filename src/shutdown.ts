import { beginShutdown } from './lifecycle.ts'
import type { logEvent } from './events.ts'

/**
 * Stop on a signal: stop starting things, let what is running finish for a few seconds,
 * then close the database and exit.
 *
 * docker stop sends SIGTERM and kills ten seconds later (`stop_grace_period` changes that),
 * so the deadline sits under that. Whatever the deadline cuts off is safe to cut: an
 * interrupted deploy runs again at the next start, an interrupted ship is reconciled
 * against origin, and SQLite's WAL keeps the database whole.
 */
export function createShutdown(deps: {
  closeListeners: () => Promise<unknown>
  stopScheduler: () => void
  idle: () => Promise<unknown>[]
  inFlight: () => string[]
  closeDb: () => void
  exit: (code: number) => never | void
  log: typeof logEvent
  deadlineMs?: number
}): (signal: string) => Promise<void> {
  const deadlineMs = deps.deadlineMs ?? 8000
  let started = false
  return async (signal) => {
    if (started) {
      console.error(`[system] ${signal} again, exiting now`)
      deps.exit(1)
      return
    }
    started = true
    beginShutdown()
    deps.log({
      level: 'info',
      kind: 'system',
      message: 'shutting down',
      detail: `${signal}; waiting up to ${Math.round(deadlineMs / 1000)}s for work in flight`,
    })
    deps.stopScheduler()
    const listeners = deps.closeListeners()
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = setTimeout(() => resolve('deadline'), deadlineMs)
    })
    const settled = Promise.allSettled([listeners, ...deps.idle()]).then(() => 'idle' as const)
    const outcome = await Promise.race([settled, deadline])
    clearTimeout(timer)
    if (outcome === 'deadline') {
      deps.log({
        level: 'warn',
        kind: 'system',
        message: 'shutdown deadline reached',
        detail: `still running: ${deps.inFlight().join(', ') || 'requests or a git operation'}; interrupted deploys run again at the next start`,
      })
    } else {
      deps.log({ level: 'info', kind: 'system', message: 'shut down cleanly' })
    }
    try {
      deps.closeDb()
    } catch (err) {
      console.error('[system] closing the database failed', err)
    }
    deps.exit(0)
  }
}
