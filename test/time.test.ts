import { test } from 'node:test'
import assert from 'node:assert/strict'

/** Days and clocks are the server's, whatever zone the test machine is in. */

process.env.TZ = 'America/New_York'
const { dayKey, clockText, validZone } = await import('../src/web/time.ts')

test("a day is the server's day", () => {
  assert.equal(dayKey('2026-01-01T03:00:00.000Z'), '2025-12-31')
})

test("a clock is the server's clock", () => {
  assert.equal(clockText('2026-01-01T03:00:00.000Z'), '22:00')
})

test('a zone Intl does not know falls back to UTC', () => {
  assert.equal(validZone('Nowhere/Atlantis'), 'UTC')
})
