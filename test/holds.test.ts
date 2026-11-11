import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PolicySchema, type Rule } from '../src/config.ts'
import {
  applyRules,
  blocking,
  holdsFor,
  ruleMatches,
  shipStatus,
  type HoldInput,
  type HoldVerdict,
  type ShipInput,
} from '../src/policy.ts'

/**
 * An update ships on its own unless a concrete hold says a person is needed. These are the
 * holds, what lifts them, and the order shipStatus asks its questions in.
 */

const verdict = (over: Partial<HoldVerdict> = {}): HoldVerdict => ({
  recommendation: 'approve',
  confidence: 'high',
  breaking: [],
  steps: [],
  irreversible: false,
  notesInRange: 3,
  ...over,
})

const input = (over: Partial<HoldInput> = {}): HoldInput => ({
  cls: 'normal',
  magnitude: 'patch',
  verdict: verdict(),
  verdictState: 'present',
  required: false,
  hasSnapshot: true,
  restoreError: null,
  securityFix: false,
  ...over,
})

const kinds = (i: Partial<HoldInput>) => holdsFor(input(i)).map((h) => h.kind)

test('a clean approval on a normal service has nothing holding it', () => {
  assert.deepEqual(kinds({}), [])
})

test('caution with empty lists holds nothing: only listed work and an unsafe verdict do', () => {
  assert.deepEqual(kinds({ verdict: verdict({ recommendation: 'caution', confidence: 'medium' }) }), [])
})

test('lifeline always asks, and is not waivable', () => {
  const [h] = holdsFor(input({ cls: 'lifeline' }))
  assert.equal(h!.kind, 'lifeline')
  assert.equal(h!.waivable, false)
})

test('ask always asks, and a rule may waive it', () => {
  const [h] = holdsFor(input({ cls: 'ask' }))
  assert.equal(h!.kind, 'ask')
  assert.equal(h!.waivable, true)
})

test('block is unsafe and names what breaks; neither is waivable', () => {
  const h = holdsFor(input({ verdict: verdict({ recommendation: 'block', breaking: ['the config file moved'] }) }))
  assert.deepEqual(h.map((x) => x.kind), ['unsafe'])
  assert.equal(h[0]!.text, 'Unsafe: the config file moved')
  assert.equal(h[0]!.waivable, false)
})

test('a step to take is work, and an approval that lists a breaking change is work too', () => {
  const steps = holdsFor(input({ verdict: verdict({ steps: ['rename X to Y'] }) }))
  assert.deepEqual(steps.map((x) => [x.kind, x.text, x.waivable]), [['needs-action', 'Needs: rename X to Y', false]])
  const breaking = holdsFor(input({ verdict: verdict({ breaking: ['Y removed'] }) }))
  assert.deepEqual(breaking.map((x) => x.kind), ['needs-action'])
})

test('no evidence holds a major, a stateful service, or a fail-closed one -- and nothing else', () => {
  const none = { notesInRange: 0 }
  assert.deepEqual(kinds({ magnitude: 'major', verdict: verdict(none) }), ['no-evidence'])
  assert.deepEqual(kinds({ cls: 'stateful', verdict: verdict(none) }), ['no-evidence'])
  assert.deepEqual(kinds({ required: true, verdict: verdict(none) }), ['no-evidence'])
  assert.deepEqual(kinds({ magnitude: 'patch', verdict: verdict(none) }), [], 'a patch with no notes ships: rollback covers it')
  assert.deepEqual(kinds({ magnitude: 'minor', verdict: verdict({ confidence: 'low' }) }), [])
  assert.deepEqual(kinds({ magnitude: 'major', verdict: verdict({ confidence: 'low' }) }), ['no-evidence'])
})

test('a review that could not run is no evidence on a major', () => {
  assert.deepEqual(kinds({ magnitude: 'major', verdict: null, verdictState: 'unavailable' }), ['no-evidence'])
  assert.deepEqual(kinds({ magnitude: 'patch', verdict: null, verdictState: 'unavailable' }), [])
})

test('a one-way migration holds, and says a restore point is taken when one can be', () => {
  const [a] = holdsFor(input({ verdict: verdict({ irreversible: true }), hasSnapshot: true }))
  assert.equal(a!.kind, 'irreversible')
  assert.match(a!.text, /a restore point is taken first/)
  const [b] = holdsFor(input({ verdict: verdict({ irreversible: true }), hasSnapshot: false }))
  assert.doesNotMatch(b!.text, /restore point/)
})

test('a stateful service needs a restore point: no snapshot, or one that failed, holds it', () => {
  assert.deepEqual(kinds({ cls: 'stateful', hasSnapshot: false }), ['no-restore-point'])
  const failed = holdsFor(input({ cls: 'stateful', restoreError: 'the dump was empty' }))
  assert.deepEqual(failed.map((h) => [h.kind, h.text]), [['no-restore-point', 'the dump was empty']])
  assert.deepEqual(kinds({ cls: 'stateful' }), [])
  assert.deepEqual(kinds({ cls: 'normal', hasSnapshot: false }), [], 'only stateful services need one')
})

test('a verified security fix lifts ask and no-evidence, and nothing that is a real warning', () => {
  const fix = { securityFix: true }
  assert.deepEqual(kinds({ ...fix, cls: 'ask' }), [])
  assert.deepEqual(kinds({ ...fix, magnitude: 'major', verdict: verdict({ notesInRange: 0 }) }), [])
  assert.deepEqual(kinds({ ...fix, cls: 'lifeline' }), ['lifeline'])
  assert.deepEqual(kinds({ ...fix, verdict: verdict({ recommendation: 'block', breaking: ['x'] }) }), ['unsafe'])
  assert.deepEqual(kinds({ ...fix, verdict: verdict({ steps: ['do x'] }) }), ['needs-action'])
})

// ---------------------------------------------------------------------------- rules

const rule = (over: Partial<Rule> & { match: Rule['match'] }): Rule => ({
  id: 'r1',
  waive: ['ask'],
  because: '',
  ...over,
})
const target = { image: 'ghcr.io/agentgateway/agentgateway:v1.6.0', stack: 'strava-mcp', service: 'strava-mcp-auth', baseBuild: false }

test('a rule matches by image repository, stack, service or base build; every key it names must match', () => {
  assert.equal(ruleMatches(rule({ match: { image: 'ghcr.io/agentgateway/agentgateway' } }), target), true)
  assert.equal(ruleMatches(rule({ match: { image: 'ghcr.io/agentgateway/other' } }), target), false)
  assert.equal(ruleMatches(rule({ match: { stack: 'strava-mcp', service: 'strava-mcp-auth' } }), target), true)
  assert.equal(ruleMatches(rule({ match: { stack: 'strava-mcp', service: 'other' } }), target), false)
  assert.equal(ruleMatches(rule({ match: { base_build: true } }), target), false)
  assert.equal(ruleMatches(rule({ match: { base_build: true } }), { ...target, baseBuild: true }), true)
  assert.equal(ruleMatches(rule({ match: { image: 'ghcr.io/agentgateway/agentgateway', stack: 'nope' } }), target), false)
})

test('applyRules waives only the waivable kinds a matching rule names', () => {
  const holds = holdsFor(input({ cls: 'ask', magnitude: 'major', verdict: verdict({ notesInRange: 0, steps: ['x'] }) }))
  assert.deepEqual(holds.map((h) => h.kind), ['ask', 'needs-action', 'no-evidence'])
  const out = applyRules(holds, [rule({ id: 'r7', waive: ['ask', 'no-evidence'], match: { image: 'ghcr.io/agentgateway/agentgateway' } })], target)
  assert.deepEqual(out.map((h) => [h.kind, h.waivedBy ?? null]), [['ask', 'r7'], ['needs-action', null], ['no-evidence', 'r7']])
  assert.deepEqual(blocking(out).map((h) => h.kind), ['needs-action'])
})

test('a rule can never waive what is not waivable, even if it says so', () => {
  const holds = holdsFor(input({ cls: 'lifeline' }))
  const out = applyRules(holds, [{ id: 'r1', match: { image: 'ghcr.io/agentgateway/agentgateway' }, waive: ['ask'], because: '' }], target)
  assert.deepEqual(blocking(out).map((h) => h.kind), ['lifeline'])
})

test('the first matching rule that names a hold wins', () => {
  const holds = holdsFor(input({ cls: 'ask' }))
  const out = applyRules(
    holds,
    [
      rule({ id: 'r1', waive: ['no-evidence'], match: { image: 'ghcr.io/agentgateway/agentgateway' } }),
      rule({ id: 'r2', waive: ['ask'], match: { stack: 'strava-mcp' } }),
    ],
    target,
  )
  assert.equal(out[0]!.waivedBy, 'r2')
})

// ---------------------------------------------------------------------------- shipStatus

const ship = (over: Partial<ShipInput> = {}): ShipInput => ({
  ...input(),
  target,
  rules: [],
  approved: false,
  paused: false,
  snoozedUntil: null,
  cooldown: { ageMs: 10 * 86_400_000, requiredMs: 7 * 86_400_000 },
  now: Date.parse('2026-11-11T12:00:00Z'),
  ...over,
})

test('shipStatus: a clean, aged update is ready', () => {
  assert.deepEqual(shipStatus(ship()), { status: 'ready' })
})

test('shipStatus: you saying ship beats holds, cooldown and pause', () => {
  const s = shipStatus(ship({ approved: true, cls: 'lifeline', paused: true, cooldown: { ageMs: 0, requiredMs: 1e9 } }))
  assert.deepEqual(s, { status: 'ready' })
})

test('shipStatus: a review still on its way waits', () => {
  assert.deepEqual(shipStatus(ship({ verdictState: 'pending', verdict: null })), { status: 'waiting', why: 'review pending' })
})

test('shipStatus: blocking holds are a decision, until snoozed', () => {
  const s = shipStatus(ship({ cls: 'ask' }))
  assert.equal(s.status, 'decision')
  const snoozed = shipStatus(ship({ cls: 'ask', snoozedUntil: '2026-11-15T00:00:00Z' }))
  assert.deepEqual(snoozed, { status: 'waiting', why: 'snoozed until 2026-11-15' })
  const over = shipStatus(ship({ cls: 'ask', snoozedUntil: '2026-11-01T00:00:00Z' }))
  assert.equal(over.status, 'decision', 'a snooze that has run out asks again')
})

test('shipStatus: a rule that waives every hold makes it ready', () => {
  const rules = [rule({ waive: ['ask'], match: { image: 'ghcr.io/agentgateway/agentgateway' } })]
  assert.deepEqual(shipStatus(ship({ cls: 'ask', rules })), { status: 'ready' })
})

test('shipStatus: the cooldown waits, then pause waits', () => {
  const young = shipStatus(ship({ cooldown: { ageMs: 2 * 86_400_000, requiredMs: 7 * 86_400_000 } }))
  assert.deepEqual(young, { status: 'waiting', why: 'cooldown: 5 days left' })
  assert.deepEqual(shipStatus(ship({ paused: true })), { status: 'waiting', why: 'paused' })
})

test('the policy schema accepts rules and sinks, and folds the v1 keys', () => {
  const p = PolicySchema.parse({
    rules: [{ id: 'r1', match: { image: 'x/y' }, waive: ['ask'], because: 'b' }],
    notify: { sinks: [{ type: 'ntfy', url: 'https://ntfy.example', topic: 't', events: ['decision'] }] },
  })
  assert.equal(p.rules[0]!.id, 'r1')
  assert.equal(p.notify.sinks[0]!.type, 'ntfy')
  assert.equal(PolicySchema.safeParse({ rules: [{ id: 'r1', match: {}, waive: ['ask'] }] }).success, false, 'an empty match is refused')
  assert.equal(PolicySchema.safeParse({ rules: [{ id: 'r1', match: { image: 'x' }, waive: ['lifeline'] }] }).success, false, 'lifeline is not waivable')

  const v1 = PolicySchema.parse({ merge: { cooldown_days: 3, max_per_run: 5 }, notify: { incidents: 'alerts', email: 'all' } })
  assert.equal(v1.ship.cooldown_days, 3)
  assert.equal(v1.ship.max_per_run, 5)
  assert.deepEqual(v1.notify.sinks.map((s) => s.type), ['webhook', 'email'])
  assert.deepEqual(PolicySchema.parse({ notify: { incidents: 'off' } }).notify.sinks, [])
  assert.equal(PolicySchema.parse({}).ship.cooldown_days, 7)
})
