import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeGate, mergeLabel, type MergeFacts } from '../src/gitops/merge-gate.ts'

/**
 * What the merge button may refuse, and what it may only mention.
 *
 * The distinction is the whole design. `decide()` answers "may this merge happen with
 * nobody watching", and nearly every clause in it is deferring to a person who is not
 * there. Here that person is clicking. So the gate keeps only what a click cannot make
 * true, and everything else becomes a sentence they can read and overrule.
 */

const facts = (over: Partial<MergeFacts> = {}): MergeFacts => ({
  prNumber: 7,
  prState: 'open',
  liveMembers: 1,
  totalMembers: 1,
  scope: 'tag-only',
  userOwned: false,
  recommendation: null,
  mergeable: null,
  checksFailing: false,
  ...over,
})

// ------------------------------------------------------------------ blocked

test('nothing to merge without an open pull request', () => {
  assert.equal(mergeGate(facts({ prState: 'merged' })).allowed, false)
  assert.equal(mergeGate(facts({ prNumber: null, prState: null })).allowed, false)
})

test('a superseded update cannot be merged, by anyone', () => {
  // The one refusal that is not about attendance: its successor rewrites the same line
  // from the same base, so merging this lands a version nothing tracks. Intent does not
  // change that, so there is no override and no "anyway".
  const g = mergeGate(facts({ liveMembers: 0, totalMembers: 1 }))
  assert.equal(g.allowed, false)
  assert.match(g.blocked!, /superseded/)
  assert.equal(mergeGate(facts({ liveMembers: 0, totalMembers: 1 }), { force: true }).allowed, false)
})

test('a partially superseded group is still mergeable', () => {
  assert.equal(mergeGate(facts({ liveMembers: 1, totalMembers: 2 })).allowed, true)
})

test('GitHub saying no is final', () => {
  const g = mergeGate(facts({ mergeable: false }))
  assert.equal(g.allowed, false)
  assert.match(g.blocked!, /cannot be merged/)
})

// ------------------------------------------------------- warn, then allow

test('a blocking verdict is said out loud and then overruleable', () => {
  // The review is a one-directional damper: it may hold a merge for a human. A human
  // holding it is the thing it was waiting for.
  const g = mergeGate(facts({ recommendation: 'block' }))
  assert.equal(g.allowed, true)
  assert.equal(g.warnings.length, 1)
  assert.match(g.warnings[0]!, /block/)
  assert.equal(mergeLabel(7, g), 'Merge #7 anyway')
})

test('caution warns too', () => {
  assert.equal(mergeGate(facts({ recommendation: 'caution' })).warnings.length, 1)
})

test('an approving verdict says nothing at all', () => {
  const g = mergeGate(facts({ recommendation: 'approve' }))
  assert.deepEqual(g.warnings, [])
  assert.equal(mergeLabel(7, g), 'Merge #7')
})

test('a pull request carrying more than a tag says the rollback will not fire', () => {
  // The consequence is not obvious and is the one that matters: rollback only ever
  // suggests a revert for a non-tag-only pull request, so a bad deploy stays bad.
  for (const scope of ['proposed', 'modified']) {
    const g = mergeGate(facts({ scope }))
    assert.equal(g.allowed, true)
    assert.match(g.warnings.join(' '), /rolled back/)
  }
})

test('a branch you pushed to is flagged, because the diff may not be shipshape\'s', () => {
  assert.match(mergeGate(facts({ userOwned: true })).warnings.join(' '), /pushed to this branch/)
})

test('warnings accumulate and all are shown', () => {
  const g = mergeGate(facts({ recommendation: 'block', scope: 'proposed', userOwned: true }))
  assert.equal(g.warnings.length, 3)
  assert.equal(g.allowed, true)
})

// --------------------------------------------------------- the one two-step

test('a failing check arms the button rather than merging', () => {
  // The only second click in the design. Not because a person may not overrule a red
  // check, but because unlike a verdict pill it is not already on screen.
  const g = mergeGate(facts({ checksFailing: true }))
  assert.equal(g.allowed, true)
  assert.equal(g.needsForce, true)
  assert.match(g.warnings.join(' '), /check is failing/)
})

test('the second click goes through', () => {
  const g = mergeGate(facts({ checksFailing: true }), { force: true })
  assert.equal(g.allowed, true)
  assert.equal(g.needsForce, false)
})

test('force does not unblock a fact', () => {
  // force is scoped to the check gate alone; it is not a master key.
  assert.equal(mergeGate(facts({ mergeable: false }), { force: true }).allowed, false)
  assert.equal(mergeGate(facts({ prState: 'closed' }), { force: true }).allowed, false)
})

// ------------------------------------------------------------------- silent

test('the ordinary case is silent', () => {
  // manual rung, major magnitude, merge.auto off -- none of these are the gate's
  // business. Every one of them is a reason auto-merge would refuse, and every one is
  // satisfied by somebody clicking. A warning on the common path is noise.
  const g = mergeGate(facts())
  assert.equal(g.allowed, true)
  assert.deepEqual(g.warnings, [])
  assert.equal(g.needsForce, false)
  assert.equal(mergeLabel(7, g), 'Merge #7')
})
