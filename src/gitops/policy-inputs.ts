import type { Policy } from '../config.ts'
import { getDb } from '../db.ts'
import { budgetExhausted } from '../analyze/claude.ts'
import { llmConfigured } from '../analyze/client.ts'
import { reviewMode } from '../policy.ts'
import { parseImageRef } from '../images/ref.ts'

/**
 * The facts the ship decision reads that are not in `policy.ts`: how old a release is,
 * and what a review that has not arrived yet should be taken to mean. Kept apart from
 * the pure engine because both need the database.
 */

/**
 * When a release was published: the registry's own date where it gave one, else when
 * shipshape first saw the tag, else when the update was detected. Exported for the tests.
 */
export function releasedAt(r: { image: string; to_tag: string; detected_at: string }): string {
  const ref = parseImageRef(r.image)
  const tag = r.to_tag.split('@')[0]!
  const row = getDb()
    .prepare(`SELECT published_at, first_seen_at FROM tags_seen WHERE registry = ? AND repository = ? AND tag = ?`)
    .get(ref.registry, ref.repository, tag) as { published_at: string | null; first_seen_at: string } | undefined
  // A digest move re-publishes an existing tag: the tag's date says nothing about the new
  // image, so its age is counted from when the move was seen.
  if (r.to_tag.includes('@')) return r.detected_at
  return row?.published_at ?? row?.first_seen_at ?? r.detected_at
}

/**
 * The cooldown that applies to one update: `ship.cooldown_days`, shortened to
 * `security.fix_cooldown_days` for a verified fix, and none for a fix to a critical or
 * exploited incident. Exported for the tests.
 */
export function cooldownFor(
  r: { image: string; to_tag: string; detected_at: string },
  fix: { critical: boolean } | null,
  policy: Policy,
  now = Date.now(),
): { ageMs: number; requiredMs: number } {
  const days = fix ? (fix.critical ? 0 : policy.security.fix_cooldown_days) : policy.ship.cooldown_days
  const at = Date.parse(releasedAt(r))
  return { ageMs: Number.isFinite(at) ? now - at : 0, requiredMs: days * 24 * 60 * 60_000 }
}

/**
 * How long an update waits for its first review before it is judged without one.
 *
 * The analysis pass reads three updates a tick, and the ship pass runs at the end of the
 * same tick, so without this the fourth update detected in a scan was judged
 * "unavailable" while its review was still queued. Six hours covers a backlog draining
 * at three a minute and a provider having a bad hour, and is short enough that an outage
 * degrades to "no evidence" rather than freezing every update.
 */
export const REVIEW_WAIT_MS = 6 * 60 * 60_000

/** Whether a review can be expected to arrive at all: it is on, a provider is set, money is left. */
export function reviewExpected(policy: Policy): boolean {
  return reviewMode(policy) !== 'off' && llmConfigured() && !budgetExhausted()
}

export type VerdictState = 'present' | 'pending' | 'unavailable'

/**
 * What the gate should treat one update's review as.
 *
 * A row with an error is a review that was tried and failed: `unavailable`. A provisional
 * row is the screen asking for a full reading: `pending`, for as long as a reading can be
 * expected, because a screen finding must never ship on its own say-so. No row at all is a
 * review that has not been tried -- `pending` while one can still be expected and the wait
 * has not run out, and `unavailable` after that. Exported for the tests.
 */
export function memberVerdict(
  r: {
    verdict_row: string | null
    verdict_error: string | null
    recommendation: string | null
    provisional?: number | null
    detected_at: string
  },
  reviewCanRun: boolean,
  now = Date.now(),
): VerdictState {
  const waiting = (): VerdictState => {
    if (!reviewCanRun) return 'unavailable'
    return now - (Date.parse(r.detected_at) || 0) < REVIEW_WAIT_MS ? 'pending' : 'unavailable'
  }
  if (r.verdict_row !== null) {
    if (r.verdict_error) return 'unavailable'
    if (!r.recommendation) return 'unavailable'
    if (r.provisional === 1) return waiting()
    return 'present'
  }
  return waiting()
}
