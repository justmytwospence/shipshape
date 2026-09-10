import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTicker, FALLBACK_INTERVAL_MS, type Ticker } from '../src/loop/ticker.ts'

/**
 * The loop's heartbeat, on its own.
 *
 * Worth testing in isolation because both of its guarantees fail silently. A tick that
 * fails to arm the next one stops shipshape without an error -- the thing that would
 * have logged it is the thing that stopped. And a wake that re-arms on top of a running
 * tick starts a second one, which the loop's ordering assumes cannot happen: two passes
 * both seeing the same pull request as open is how a stack gets deployed twice.
 *
 * Real timers rather than mocked ones, because what is being asserted is the interaction
 * between a timer and an await, and mocking half of that pair tests the mock. But every
 * wait is on a *condition* with a generous ceiling, never on a wall-clock duration: the
 * suite runs its files concurrently, so "three ticks should fit in 40ms" is a test that
 * fails on a busy machine and proves nothing on an idle one.
 */

const TIMEOUT_MS = 5_000

async function waitFor(what: string, ok: () => boolean): Promise<void> {
  const until = Date.now() + TIMEOUT_MS
  while (Date.now() < until) {
    if (ok()) return
    await new Promise((r) => setTimeout(r, 2))
  }
  assert.fail(`timed out waiting for ${what}`)
}

/** How far out the next tick is armed, in ms. */
const armedIn = (t: Ticker): number => Date.parse(t.nextAt()!) - Date.now()

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

test('it keeps rescheduling itself', async () => {
  let runs = 0
  const t = createTicker(async () => {
    runs++
  }, () => 1)
  t.start(0)
  await waitFor('several ticks', () => runs >= 3)
  t.stop()
})

test('a tick that throws still arms the next one', async () => {
  // The failure this exists to prevent: one bad tick and shipshape never runs again,
  // with nothing in the log because logging is one of the things that stopped.
  let runs = 0
  const t = createTicker(async () => {
    runs++
    throw new Error('boom')
  }, () => 1)
  t.start(0)
  await waitFor('the loop to survive its own failures', () => runs >= 3)
  t.stop()
})

test('an interval that throws falls back rather than stopping', async () => {
  let runs = 0
  const t = createTicker(
    async () => {
      runs++
    },
    () => {
      throw new Error('policy unreadable')
    },
  )
  t.start(0)
  // Armed on the fallback, so the loop is still alive and will try again.
  await waitFor('a fallback arming', () => runs === 1 && armedIn(t) > FALLBACK_INTERVAL_MS - 5_000)
  t.stop()
})

test('an interval that answers nonsense does not spin', async () => {
  // NaN, negative or Infinity would otherwise arm at zero and run flat out.
  for (const bad of [NaN, -1, Infinity]) {
    let runs = 0
    const t = createTicker(async () => {
      runs++
    }, () => bad)
    t.start(0)
    await waitFor(`a fallback arming for ${bad}`, () => runs >= 1 && t.nextAt() !== null)
    const armed = armedIn(t)
    t.stop()
    assert.ok(armed > FALLBACK_INTERVAL_MS - 5_000, `interval ${bad} armed in ${armed}ms`)
  }
})

test('waking an idle ticker runs it now, not at the interval', async () => {
  // The reason this exists: 08:00's digest must not wait out a ten-minute idle cadence
  // just because the timer for it was armed at 07:52.
  let runs = 0
  const t = createTicker(async () => {
    runs++
  }, () => 60_000)
  t.start(60_000)
  assert.equal(runs, 0)

  t.wake()
  await waitFor('the woken tick', () => runs === 1)
  t.stop()
})

test('waking a running ticker does not start a second tick', async () => {
  const gate = deferred()
  let started = 0
  let overlapped = false
  let inside = false

  const t = createTicker(async () => {
    if (inside) overlapped = true
    inside = true
    started++
    if (started === 1) await gate.promise
    inside = false
  }, () => 60_000)

  t.start(0)
  await waitFor('the first tick to be in flight', () => started === 1)

  // Three wakes while it is running. None may start a tick of its own.
  t.wake()
  t.wake()
  t.wake()
  assert.equal(started, 1, 'a wake mid-tick must not start a second one')
  assert.equal(overlapped, false)

  gate.resolve()
  // The wake was honoured on the reschedule rather than dropped. Without that, this
  // waits out the full 60s interval and times out.
  await waitFor('the deferred wake to be honoured', () => started === 2)
  t.stop()
  assert.equal(overlapped, false, 'two ticks ran at once')
})

test('a wake is one-shot: the tick after it goes back to the interval', async () => {
  let runs = 0
  const t = createTicker(async () => {
    runs++
  }, () => 60_000)
  t.start(60_000)

  t.wake()
  // If `woken` were sticky, every subsequent tick would arm at zero and spin.
  await waitFor('the woken tick to rearm on the interval', () => runs === 1 && armedIn(t) > 30_000)
  t.stop()
  assert.equal(runs, 1)
})

test('stop means stop, including from inside a tick', async () => {
  let runs = 0
  const t = createTicker(async () => {
    runs++
    t.stop()
  }, () => 1)
  t.start(0)
  await waitFor('the first and only tick', () => runs === 1 && t.nextAt() === null)
  assert.equal(runs, 1)
})

test('nextAt reports the arming, and nothing before the first start', () => {
  const t = createTicker(async () => {}, () => 60_000)
  assert.equal(t.nextAt(), null)
  t.start(5_000)
  const at = armedIn(t)
  t.stop()
  assert.ok(at > 4_000 && at <= 5_000, `armed in ${at}ms`)
})
