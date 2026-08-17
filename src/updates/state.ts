import { getDb } from '../db.ts'

/**
 * The states an update passes through, in one place.
 *
 * These were a SQL comment and a scatter of string literals across five modules, which is
 * how `analyzed` came to be documented but never written by anything, and how the set of
 * states the scan must refuse to re-offer drifted apart from the set it actually checked.
 * Naming the union is the cheapest way to stop both.
 */
export const UPDATE_STATES = [
  'detected', // seen in a registry, nothing opened yet
  'held', // the on-request rung: listed, waiting to be asked for
  'pr_open', // a pull request exists
  'merged', // merged; the deploy is queued, ready, or already running
  'deploying', // compose is running right now
  'deployed', // up and healthy, inside the soak window
  'verified', // soaked and still healthy -- terminal, success
  'failed', // deployed badly and was put back, or the operator gave up -- terminal
  'skipped', // the operator dismissed it -- terminal
  'superseded', // a newer target replaced it, or its pull request closed -- terminal
] as const

export type UpdateState = (typeof UPDATE_STATES)[number]

/** Rows the worklist shows: something could still happen to them without a deploy. */
export const LIVE_STATES: readonly UpdateState[] = ['detected', 'pr_open', 'held']

/**
 * Tombstones. A rolled-back version must never be offered again on the next scan, and
 * neither must one the operator dismissed -- otherwise "no thanks" lasts until 03:00.
 * Both are per (stack, service, from_tag, to_tag), so a *different* target is unaffected.
 */
export const REFUSED_STATES: readonly UpdateState[] = ['failed', 'skipped']

/** States where the update is mid-flight and the UI should keep asking. */
export const TRANSIENT_STATES: readonly UpdateState[] = ['deploying']

export function isUpdateState(v: string): v is UpdateState {
  return (UPDATE_STATES as readonly string[]).includes(v)
}

/**
 * `IN (...)` for a set of states. These are compile-time constants from the union above,
 * never user input, so inlining them keeps the call sites readable.
 */
export function sqlIn(states: readonly string[]): string {
  return `(${states.map((s) => `'${s}'`).join(', ')})`
}

export function setState(id: number, state: UpdateState, detail?: string | null): void {
  getDb()
    .prepare(`UPDATE updates SET state = ?, detail = ?, updated_at = ? WHERE id = ?`)
    .run(state, detail ?? null, new Date().toISOString(), id)
}
