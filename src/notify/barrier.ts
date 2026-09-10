import { getDb } from '../db.ts'

/**
 * When the digest may go out.
 *
 * The digest is supposed to describe a night that is over, and the obvious way to arrange
 * that -- wait a while at 08:00 for anything in flight -- is not an arrangement at all.
 * It samples shared state from a timer running beside the work, so what it sees depends
 * on where the interleave happens to fall. The specific hole: a pull request merged by
 * `runAutoMerge` is not queued for deploy until the *next* tick's `pollPrs` notices the
 * merge, so for a whole poll interval there is nothing pending to see. A waiter looking
 * for pending deploys walks straight through the gap it exists to cover.
 *
 * So the decision moves into the loop. The pull-request tick is one sequential chain --
 * poll, deploy, open, analyse, propose, revise, merge -- and a question answered at the
 * end of it cannot be racing with it, because nothing else is running. The tick knows
 * what it just did; the timer could only guess.
 *
 * This module holds the other half: the fact that a digest is owed. Owed from the moment
 * the schedule fires, until it is sent -- and in the database rather than in a closure,
 * because a restart at 08:03 would otherwise drop the morning's summary into tomorrow's,
 * which is the failure the whole change is about.
 */

/**
 * How long a digest will wait for the work to finish.
 *
 * A full open -> analyse -> merge -> deploy chain takes about five ticks, so this is
 * several times the expected wait. It is a bound, not a target: a wedged deploy delays
 * the digest and must never cancel it.
 */
export const MAX_WAIT_MS = 20 * 60_000

interface Due {
  dueAt: string
  deadline: string
}

/**
 * Record that the schedule has fired.
 *
 * Idempotent on purpose: a second fire while one is still owed keeps the first deadline,
 * so a digest that is waiting cannot have its clock reset by the next occurrence.
 */
export function requestDigest(now = new Date()): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO digest_due (id, due_at, deadline) VALUES (1, ?, ?)`,
    )
    .run(now.toISOString(), new Date(now.getTime() + MAX_WAIT_MS).toISOString())
}

/** Is a digest waiting to go out? Used to hold the poll loop on its fast cadence. */
export function digestOwed(): boolean {
  return owed() !== null
}

function owed(): Due | null {
  return (getDb()
    .prepare(`SELECT due_at AS dueAt, deadline FROM digest_due WHERE id = 1`)
    .get() ?? null) as Due | null
}

/** Give up on a pending request without sending it. */
export function clearDigestRequest(): void {
  getDb().prepare(`DELETE FROM digest_due WHERE id = 1`).run()
}

export type Slot =
  | { send: false }
  | { send: true; reason: 'quiet' | 'deadline'; waitedMs: number }

/**
 * Decide, and take the claim in the same breath.
 *
 * `quiet` is the caller's answer to "did this tick leave anything unfinished" -- it is
 * the tick's own knowledge, not an observation of it. The row is deleted before the
 * caller sends, so the decision is taken exactly once whatever happens to the transport:
 * `flush` already claims its batch atomically and already treats a failed send as a
 * missed digest rather than something to retry.
 */
export function claimDigestSlot(quiet: boolean, now = new Date()): Slot {
  const due = owed()
  if (!due) return { send: false }

  const waitedMs = now.getTime() - Date.parse(due.dueAt)
  const expired = now.getTime() >= Date.parse(due.deadline)
  if (!quiet && !expired) return { send: false }

  clearDigestRequest()
  return { send: true, reason: quiet ? 'quiet' : 'deadline', waitedMs }
}
