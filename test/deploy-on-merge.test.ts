import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deployWaits } from '../src/gitops/poll.ts'
import { asTier, deployNeedsYou, foldGroupTier, shouldOpenPr, tierFor } from '../src/policy.ts'
import { PolicySchema } from '../src/config.ts'

/**
 * Merging decides; deploying carries the decision out.
 *
 * The two used to be split by `paused`, which asked the wrong question: a merge the
 * operator pressed themselves still produced a deploy that waited for a second press,
 * while the version it had decided on reached the host anyway the next time anything
 * recreated the stack -- with no health check and no rollback. Now every merge deploys and
 * is watched, and the exception is named per service rather than taken globally.
 */

const DEFAULTS = PolicySchema.parse({}).defaults
const svc = (over = {}) => ({
  stack: 'infra',
  service: 'traefik',
  policyLabel: null,
  prLabel: null,
  ...over,
})
const member = (over = {}) => ({ stack: 'infra', service: 'traefik', magnitude: 'minor', ...over })

// ------------------------------------------------------------------ the rung

test('attended is a rung of the one ladder, not a second knob', () => {
  const at = { magnitude: 'minor', policyLabel: 'attended', prLabel: null, defaults: DEFAULTS }
  assert.equal(tierFor(at), 'attended')
  assert.equal(asTier('attended'), 'attended')
})

test('attended still opens a pull request -- that is the point of it', () => {
  // The difference from on-request is that you still get the diff and the changelog
  // review; the difference from manual is only who touches the host.
  assert.equal(shouldOpenPr({ scope: 'full', tier: 'attended', magnitude: 'minor', rolling: false }), true)
  assert.equal(shouldOpenPr({ scope: 'full', tier: 'held', magnitude: 'minor', rolling: false }), false)
})

test('attended never merges on its own', () => {
  // Only `auto` ever does, so a new rung cannot widen reach. Asserted rather than assumed,
  // because a rung that merged itself and then waited to deploy would be the worst of both.
  const t = tierFor({ magnitude: 'patch', policyLabel: 'attended', prLabel: null, defaults: DEFAULTS })
  assert.notEqual(t, 'auto')
})

test('a group is only as attended as its most cautious member', () => {
  assert.equal(foldGroupTier(['auto', 'attended']), 'attended')
  assert.equal(foldGroupTier(['attended', 'manual']), 'attended')
  assert.equal(foldGroupTier(['attended', 'held']), 'held')
})

test('a typo still narrows to manual rather than granting reach', () => {
  assert.equal(tierFor({ magnitude: 'patch', policyLabel: 'attnded', prLabel: null, defaults: DEFAULTS }), 'manual')
})

test('only the two hands-on rungs hold a deploy back', () => {
  assert.deepEqual(
    ['auto', 'manual', 'attended', 'held', 'model', 'skip'].map(deployNeedsYou),
    [false, false, true, true, false, false],
  )
})

// ------------------------------------------------------------------ the gate

test('an ordinary merge deploys itself, and is therefore watched', () => {
  assert.equal(deployWaits([member()], [svc()], DEFAULTS), false)
})

test('a service labelled attended waits for a person', () => {
  assert.equal(deployWaits([member()], [svc({ policyLabel: 'attended' })], DEFAULTS), true)
})

test('on-request waits too -- the datastores live there', () => {
  assert.equal(deployWaits([member()], [svc({ policyLabel: 'on-request' })], DEFAULTS), true)
  assert.equal(deployWaits([member()], [svc({ prLabel: 'on-request' })], DEFAULTS), true)
})

test('one attended member makes the whole invocation wait', () => {
  // `compose up` recreates every service in the target, so the cautious one decides.
  const members = [member(), member({ service: 'whoami' })]
  const scanned = [svc({ policyLabel: 'attended' }), svc({ service: 'whoami' })]
  assert.equal(deployWaits(members, scanned, DEFAULTS), true)
})

test('a service the scan no longer knows about is not assumed safe', () => {
  // No compose entry means no label to read. It falls to the magnitude defaults rather
  // than to "deploy it", and a major there is manual -- which still deploys, but the point
  // is that the lookup miss does not silently answer the question.
  assert.equal(deployWaits([member({ magnitude: 'major' })], [], DEFAULTS), false)
})
