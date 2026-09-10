import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'shipshape-test-'))

const { getDb } = await import('../src/db.ts')
const { claimPending, lastItemId } = await import('../src/notify/digest.ts')
const { requestDigest, digestOwed, claimDigestSlot, clearDigestRequest, MAX_WAIT_MS } =
  await import('../src/notify/barrier.ts')

/**
 * When the digest goes out, and who gets to send it.
 *
 * Two separate races, both real before this. The batch could be sent twice, because
 * reading it and marking it sent were separated by an await that two callers could sit
 * in at once. And it could be sent too early, because the thing deciding was a timer
 * beside the work rather than the work itself.
 */

function reset(): void {
  getDb().exec(`DELETE FROM digest_items; DELETE FROM digest_due;`)
}

beforeEach(reset)

function item(summary: string): void {
  getDb()
    .prepare(
      `INSERT INTO digest_items (at, category, stack, service, summary, detail, url, sent_at)
       VALUES (datetime('now'), 'opened', NULL, NULL, ?, NULL, NULL, NULL)`,
    )
    .run(summary)
}

test('a claimed batch is gone from the next claim', () => {
  item('a')
  item('b')

  const first = claimPending()
  assert.equal(first.length, 2)

  // The second caller is the Send now button landing while the schedule's flush is still
  // awaiting its transport. It must find nothing: the rows were marked in the same
  // transaction that read them, so there is no interleave that shows them twice.
  assert.deepEqual(claimPending(), [])
})

test('an empty claim is empty, and marks nothing', () => {
  assert.deepEqual(claimPending(), [])
  const marked = getDb()
    .prepare(`SELECT COUNT(*) c FROM digest_items WHERE sent_at IS NOT NULL`)
    .get() as { c: number }
  assert.equal(marked.c, 0)
})

test('items added after a claim belong to the next one', () => {
  item('a')
  claimPending()
  item('b')
  assert.deepEqual(
    claimPending().map((r) => r.summary),
    ['b'],
  )
})

test('the watermark only ever goes up, including across a prune', () => {
  item('a')
  const first = lastItemId()
  assert.ok(first > 0)

  item('b')
  assert.ok(lastItemId() > first)

  // AUTOINCREMENT, so deleting the newest row cannot walk the watermark backwards and
  // make a busy tick look quiet.
  const high = lastItemId()
  getDb().exec(`DELETE FROM digest_items`)
  item('c')
  assert.ok(lastItemId() > high)
})

test('nothing is owed until the schedule fires', () => {
  assert.equal(digestOwed(), false)
  assert.deepEqual(claimDigestSlot(true), { send: false })
})

test('a quiet tick sends, and clears the request', () => {
  requestDigest()
  assert.equal(digestOwed(), true)

  const slot = claimDigestSlot(true)
  assert.equal(slot.send, true)
  assert.equal(slot.send && slot.reason, 'quiet')
  assert.equal(digestOwed(), false)
})

test('a busy tick holds, and keeps holding', () => {
  requestDigest()
  assert.deepEqual(claimDigestSlot(false), { send: false })
  assert.deepEqual(claimDigestSlot(false), { send: false })
  // Still owed: a tick that found work postpones the digest, it does not consume it.
  assert.equal(digestOwed(), true)
})

test('the deadline sends anyway, because a wedged deploy must not cancel the morning', () => {
  const at = new Date('2026-09-10T08:00:00.000Z')
  requestDigest(at)

  const justBefore = new Date(at.getTime() + MAX_WAIT_MS - 1)
  assert.deepEqual(claimDigestSlot(false, justBefore), { send: false })

  const after = new Date(at.getTime() + MAX_WAIT_MS)
  const slot = claimDigestSlot(false, after)
  assert.equal(slot.send, true)
  assert.equal(slot.send && slot.reason, 'deadline')
  assert.equal(slot.send && slot.waitedMs, MAX_WAIT_MS)
})

test('a second fire while one is owed does not reset the deadline', () => {
  const at = new Date('2026-09-10T08:00:00.000Z')
  requestDigest(at)
  // An hour later the schedule comes round again -- or the process restarted and the
  // cron fired on a fresh boot. Either way the digest has been waiting an hour and is
  // long past due; a reset here would mean a stuck deploy could postpone it forever.
  requestDigest(new Date(at.getTime() + 3_600_000))

  const slot = claimDigestSlot(false, new Date(at.getTime() + 3_600_001))
  assert.equal(slot.send, true)
  assert.equal(slot.send && slot.reason, 'deadline')
})

test('a request outlives the process that made it', () => {
  requestDigest()
  // Nothing in this test's memory carries it -- the assertion is that a fresh read of
  // the database still says a digest is owed, which is what a restart at 08:03 does.
  const row = getDb().prepare(`SELECT COUNT(*) c FROM digest_due`).get() as { c: number }
  assert.equal(row.c, 1)
  assert.equal(digestOwed(), true)
})

test('a request can be dropped without sending', () => {
  requestDigest()
  clearDigestRequest()
  assert.equal(digestOwed(), false)
})
