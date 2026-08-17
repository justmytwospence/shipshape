import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  UPDATE_STATES,
  LIVE_STATES,
  REFUSED_STATES,
  isUpdateState,
  sqlIn,
} from '../src/updates/state.ts'
import { nextAttemptAt } from '../src/analyze/run.ts'

test('the live set is the one the worklist and the scan already used', () => {
  // The string this replaced, verbatim, so the refactor cannot have widened it.
  assert.equal(sqlIn(LIVE_STATES), `('detected', 'pr_open', 'held')`)
})

test('every named subset is drawn from the union', () => {
  for (const s of [...LIVE_STATES, ...REFUSED_STATES]) {
    assert.ok(isUpdateState(s), `${s} is a real state`)
  }
})

test('a refused target is one the scan must not offer again', () => {
  // Rolled back, or dismissed by hand. Both mean "not this version".
  assert.deepEqual([...REFUSED_STATES].sort(), ['failed', 'skipped'])
  for (const s of REFUSED_STATES) {
    assert.ok(!LIVE_STATES.includes(s), `${s} is terminal, never live`)
  }
})

test('analyzed is gone', () => {
  // It was documented in the schema for months and written by nothing.
  assert.ok(!(UPDATE_STATES as readonly string[]).includes('analyzed'))
})

test('a failed analysis backs off, and stops backing off at a day', () => {
  const t0 = Date.UTC(2026, 0, 1)
  const after = (n: number) => Date.parse(nextAttemptAt(n, t0)) - t0
  assert.equal(after(1), 15 * 60_000, 'first retry in 15 minutes')
  assert.equal(after(2), 60 * 60_000)
  assert.equal(after(3), 4 * 60 * 60_000)
  assert.equal(after(4), 16 * 60 * 60_000)
  assert.equal(after(5), 24 * 60 * 60_000, 'capped at a day')
  assert.equal(after(99), 24 * 60 * 60_000, 'and stays there')
})
