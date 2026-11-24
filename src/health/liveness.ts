import { getDb } from '../db/index.ts'
import { logEvent } from '../events.ts'
import { loopStalled, scheduleInfo } from '../scheduler.ts'
import { version } from '../version.ts'

/**
 * GET /health, for the container healthcheck: 503 when the database cannot be read or the
 * main loop has stopped doing its job. The body never says why (it answers without
 * sign-in); the reason goes to Activity.
 */
export function health(
  deps: { dbOk?: () => boolean; stalled?: () => boolean } = {},
): { status: 200 | 503; body: { ok: boolean; version: string } } {
  const dbOk =
    deps.dbOk ??
    (() => {
      try {
        getDb().prepare('SELECT 1').get()
        return true
      } catch {
        return false
      }
    })
  const stalled = deps.stalled ?? (() => loopStalled())
  const db = dbOk()
  const stuck = stalled()
  if (db && stuck) {
    logEvent({
      level: 'error',
      kind: 'system',
      message: 'main loop stalled',
      detail: `next tick was due ${scheduleInfo().loop.nextTickAt ?? 'never'}`,
    })
  }
  if (!db || stuck) return { status: 503, body: { ok: false, version: version() } }
  return { status: 200, body: { ok: true, version: version() } }
}
