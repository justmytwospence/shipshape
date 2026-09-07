import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claimable, parseContext } from '../src/revise/run.ts'

/**
 * Who may pick an instruction up, and when shipshape stops trying.
 *
 * The claim is taken before the model call rather than after it, because the auto-merge
 * interlock reads `working` as "still holding" -- so the row has to say someone is on it
 * for the whole time the model is thinking. That makes the expiry load-bearing in the
 * other direction: a claim that could never go stale would wedge a pull request forever
 * the first time the process died mid-handle, with `holdReason` refusing the merge and
 * nobody ever coming back for it.
 */

const now = Date.parse('2026-09-07T12:00:00Z')
const ago = (ms: number) => new Date(now - ms).toISOString()
const MINUTE = 60_000

test('a new instruction is taken', () => {
  assert.deepEqual(claimable({ status: 'new', attempts: 0, claimed_at: null }, now), { take: true })
})

test('one already being worked on is left alone', () => {
  const r = claimable({ status: 'working', attempts: 1, claimed_at: ago(2 * MINUTE) }, now)
  assert.deepEqual(r, { take: false, give_up: false })
})

test('a claim that went stale is taken again', () => {
  // The crash case. Fifteen minutes is far longer than the 120s model timeout, so this
  // only fires when nothing is actually coming back.
  assert.deepEqual(claimable({ status: 'working', attempts: 1, claimed_at: ago(20 * MINUTE) }, now), {
    take: true,
  })
  assert.deepEqual(claimable({ status: 'working', attempts: 1, claimed_at: null }, now), {
    take: true,
  })
})

test('after two attempts it is put down rather than retried forever', () => {
  // The verdicts lesson: one failing analysis wrote 852 identical log rows before
  // anything counted attempts. give_up means "reply saying so", not "ignore".
  const r = claimable({ status: 'working', attempts: 2, claimed_at: ago(60 * MINUTE) }, now)
  assert.deepEqual(r, { take: false, give_up: true })
  assert.deepEqual(claimable({ status: 'new', attempts: 3, claimed_at: null }, now), {
    take: false,
    give_up: true,
  })
})

test('a finished or foreign row is never taken', () => {
  for (const status of ['done', 'failed', 'ours', 'stale']) {
    assert.deepEqual(
      claimable({ status, attempts: 0, claimed_at: null }, now),
      { take: false, give_up: false },
      status,
    )
  }
})

test('an inline comment keeps the hunk and the thread it belongs to', () => {
  const r = parseContext(JSON.stringify({ diffHunk: '@@ -1 +1 @@\n-a\n+b', inReplyTo: 77 }))
  assert.equal(r.diffHunk, '@@ -1 +1 @@\n-a\n+b')
  // The thread root, so a reply continues the conversation instead of nesting under
  // whichever comment in it happened to be read.
  assert.equal(r.inReplyTo, 77)
})

test('a conversation comment carries no inline context, and neither does a broken one', () => {
  for (const raw of [null, '', 'not json', '{"diffHunk":42}', '{}']) {
    assert.deepEqual(parseContext(raw), { diffHunk: null, inReplyTo: null }, String(raw))
  }
})
