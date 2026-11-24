import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeToken, verifyToken } from '../src/notify/links.ts'

/**
 * Action links in email and ntfy: signed, expiring, and useless on their own -- the page
 * behind them still sits behind the web UI's authentication.
 */

const SECRET = 'a-secret'
const now = Date.parse('2026-11-11T12:00:00Z')

test('a token round-trips to its verb and update', () => {
  const t = makeToken('ship', 42, SECRET, now)
  assert.deepEqual(verifyToken(t, SECRET, now + 1000), { verb: 'ship', updateId: 42 })
})

test('a token signed with another secret is refused', () => {
  assert.equal(verifyToken(makeToken('ship', 42, SECRET, now), 'other', now), null)
})

test('a tampered payload or signature is refused', () => {
  const [payload, mac] = makeToken('snooze', 1, SECRET, now).split('.')
  const forged = Buffer.from(JSON.stringify({ v: 'ship', u: 1, e: now + 1e9 })).toString('base64url')
  assert.equal(verifyToken(`${forged}.${mac}`, SECRET, now), null)
  assert.equal(verifyToken(`${payload}.${mac!.slice(0, -2)}xx`, SECRET, now), null)
  assert.equal(verifyToken(`${payload}`, SECRET, now), null)
  assert.equal(verifyToken('', SECRET, now), null)
  assert.equal(verifyToken('a.b.c', SECRET, now), null)
})

test('a token expires after two weeks', () => {
  const t = makeToken('ship', 7, SECRET, now)
  assert.notEqual(verifyToken(t, SECRET, now + 13 * 86_400_000), null)
  assert.equal(verifyToken(t, SECRET, now + 15 * 86_400_000), null)
})

test('safeHref keeps http(s) and drops everything else', async () => {
  const { safeHref } = await import('../src/links.ts')
  for (const bad of [
    'javascript:alert(1)',
    'javascript://github.com/%0aalert(1)',
    'data:text/html,x',
    'vbscript:x',
    'https://u:p@example.com/',
    '',
    'x'.repeat(3000),
    42,
  ]) {
    assert.equal(safeHref(bad), null, String(bad).slice(0, 40))
  }
  assert.equal(safeHref('https://github.com/a/b'), 'https://github.com/a/b')
  assert.equal(safeHref('http://example.com/x'), 'http://example.com/x')
})
