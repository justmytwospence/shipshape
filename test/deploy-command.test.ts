import { test } from 'node:test'
import assert from 'node:assert/strict'
import { manualCommand, failureState, type DeployTarget } from '../src/deploy/run.ts'
import { PolicySchema } from '../src/config.ts'

/**
 * The command an operator pastes, and what a failed deploy left behind.
 *
 * Both were built by string concatenation at the call site, and both were wrong in ways
 * that only showed up in the cases that mattered: the pasted command named a compose
 * file the root stack does not have, and the alert claimed the service was still running
 * when rm-first had already removed it.
 */

const target = (over: Partial<DeployTarget> = {}): DeployTarget => ({
  stack: 'jellyfin',
  services: ['jellyfin'],
  strategy: 'up',
  ...over,
})

test('the pasted command matches what the automatic path would run', () => {
  assert.equal(
    manualCommand(target()),
    'docker compose -f jellyfin/docker-compose.yaml up -d jellyfin',
  )
})

test('the root stack gets no -f, because that is the invocation that fails', () => {
  // `-f root/docker-compose.yaml` is not a path, and even the real root file scoped with
  // -f loses the networks it defines: "refers to undefined network".
  const cmd = manualCommand(target({ stack: 'root', services: ['pihole'] }))
  assert.equal(cmd, 'docker compose up -d pihole')
  assert.ok(!cmd.includes('-f'))
})

test('a service is never listed twice', () => {
  const cmd = manualCommand(target({ services: ['n8n', 'n8n'] }))
  assert.equal(cmd.match(/n8n/g)?.length, 1)
})

test('rm-first is two commands, removal first', () => {
  const lines = manualCommand(target({ strategy: 'rm-first' })).split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0]!, /compose -f jellyfin\/docker-compose\.yaml rm -sf jellyfin/)
  assert.match(lines[1]!, /up -d jellyfin/)
})

test('a failed up after rm-first says the service is down', () => {
  // The dangerous case: the old container is already gone. Saying "running whatever it
  // was" here told the operator the opposite of the truth.
  const s = failureState({ ok: false, phase: 'up', reason: 'compose failed' }, 'rm-first')
  assert.match(s, /DOWN/)
})

test('a failed plain up says the old container is still there', () => {
  const s = failureState({ ok: false, phase: 'up', reason: 'compose failed' }, 'up')
  assert.match(s, /running whatever it was/)
  assert.ok(!s.includes('DOWN'))
})

test('a refusal says nothing was attempted', () => {
  const s = failureState({ ok: false, phase: 'refused', reason: 'excluded stack' }, 'up')
  assert.match(s, /Nothing was attempted/)
})

test('the old pair of knobs folds into one switch, conservatively', () => {
  // `merge.auto` and `deploy.mode` asked one question twice and could disagree. The
  // reading is: nothing runs unattended unless the file said so in both places.
  const paused = (p: Record<string, unknown>) => PolicySchema.parse(p).paused

  assert.equal(paused({}), true, 'a file that says nothing is paused')
  assert.equal(paused({ merge: { auto: false }, deploy: { mode: 'manual' } }), true)
  assert.equal(paused({ merge: { auto: true }, deploy: { mode: 'manual' } }), true)
  assert.equal(paused({ merge: { auto: false }, deploy: { mode: 'auto' } }), true)
  assert.equal(paused({ merge: { auto: true }, deploy: { mode: 'auto' } }), false)
  // `off` was only ever a third name for manual, and still is.
  assert.equal(paused({ merge: { auto: true }, deploy: { mode: 'off' } }), true)
  // An explicit switch always wins over whatever the old keys said.
  assert.equal(paused({ paused: false, merge: { auto: false } }), false)
  assert.equal(paused({ paused: true, merge: { auto: true }, deploy: { mode: 'auto' } }), true)
})

test('the superseded keys are gone from the policy every consumer sees', () => {
  // Left in place they would read plausibly and mean nothing, which is worse than a
  // compile error.
  const p = PolicySchema.parse({ merge: { auto: true }, deploy: { mode: 'auto' } })
  assert.ok(!('auto' in p.merge))
  assert.ok(!('mode' in p.deploy))
  assert.equal(p.merge.max_per_run, 3, 'the keys that still mean something survive')
  assert.equal(p.deploy.soak_s, 1800)
})

test('the verify window defaults long, and the old spelling still sets it', () => {
  // Returns as soon as every signal is good, so only a bad deploy pays the wait -- which
  // is what lets it be long enough for a service that migrates on first start.
  assert.equal(PolicySchema.parse({}).deploy.verify_window_s, 300)
  assert.equal(
    PolicySchema.parse({ deploy: { health_window_s: 90 } }).deploy.verify_window_s,
    90,
  )
})
