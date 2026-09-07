import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canAutoMerge, shouldOpenPr } from '../src/policy.ts'

/**
 * These cover the decision, not the merge call. The merge call is three lines; the
 * decision is the whole feature, and it is the only thing in shipshape that can change
 * the repository with nobody watching.
 */

const base = {
  tier: 'auto' as const,
  magnitude: 'patch' as const,
  verdict: 'approve' as const,
  confidence: 'high' as const,
  claudeRequired: false,
  claudeMode: 'advisory' as const,
  minConfidence: 'medium' as const,
  prScope: 'tag-only' as const,
}

test('nothing but a clean tag-only bump on the auto tier merges', () => {
  assert.equal(canAutoMerge(base).merge, true)
  for (const prScope of ['proposed', 'modified'] as const) {
    assert.equal(canAutoMerge({ ...base, prScope }).merge, false, prScope)
  }
  for (const tier of ['manual', 'held', 'skip'] as const) {
    assert.equal(canAutoMerge({ ...base, tier }).merge, false, tier)
  }
  for (const magnitude of ['major', 'digest'] as const) {
    assert.equal(canAutoMerge({ ...base, magnitude }).merge, false, magnitude)
  }
})

test('a comment can withhold a merge and can never cause one', () => {
  // "Don't merge this yet" has to work before anything reads the sentence, so the hold
  // is set by recording the comment rather than by understanding it.
  const held = canAutoMerge({ ...base, hold: 'a comment is waiting on an answer' })
  assert.equal(held.merge, false)
  assert.equal(held.merge === false ? held.reason : '', 'a comment is waiting on an answer')
  // Only the hold changed; the same input merges without it.
  assert.equal(canAutoMerge({ ...base, hold: null }).merge, true)
  assert.equal(canAutoMerge({ ...base, hold: undefined }).merge, true)
  // ...and it is a damper, never a lever: nothing policy already refused is rescued by
  // adding one, whatever it says.
  for (const over of [
    { tier: 'manual' as const },
    { magnitude: 'major' as const },
    { prScope: 'modified' as const },
    { verdict: 'block' as const },
  ]) {
    assert.equal(canAutoMerge({ ...base, ...over, hold: 'merge it' }).merge, false)
  }
})

test('a changelog can withhold a merge and can never cause one', () => {
  // The containment for untrusted release notes is that the worst they achieve is a
  // stopped update.
  assert.equal(canAutoMerge({ ...base, verdict: 'block' }).merge, false)
  assert.equal(canAutoMerge({ ...base, verdict: 'caution' }).merge, false)
  assert.equal(canAutoMerge({ ...base, confidence: 'low' }).merge, false)
  // ...and no verdict rescues something policy already refused.
  for (const over of [{ tier: 'manual' as const }, { magnitude: 'major' as const }, { prScope: 'proposed' as const }]) {
    assert.equal(
      canAutoMerge({ ...base, ...over, verdict: 'approve', confidence: 'high' }).merge,
      false,
    )
  }
})

test('under coexist, nothing that opens a pull request can auto-merge', () => {
  // Why auto-merge stays inert until the legacy updater is retired: coexist opens only
  // what the auto tier excludes, and auto-merge accepts only the auto tier.
  let opened = 0
  let mergeable = 0
  for (const tier of ['auto', 'manual', 'held', 'skip'] as const) {
    for (const magnitude of ['patch', 'minor', 'major', 'digest'] as const) {
      if (!shouldOpenPr({ scope: 'coexist', tier, magnitude, rolling: false })) continue
      opened++
      if (canAutoMerge({ ...base, tier, magnitude }).merge) mergeable++
    }
  }
  assert.ok(opened > 0, 'coexist must still open pull requests')
  assert.equal(mergeable, 0, 'coexist and auto-merge must not overlap')
})

test('at full scope the auto tier becomes mergeable, which is the point of M6', () => {
  assert.equal(
    shouldOpenPr({ scope: 'full', tier: 'auto', magnitude: 'patch', rolling: false }),
    true,
  )
  assert.equal(canAutoMerge({ ...base, tier: 'auto', magnitude: 'patch' }).merge, true)
})

test('an absent verdict fails open, unless the service demanded one', () => {
  // An API outage must not freeze every update; a service that opted in is different.
  assert.equal(canAutoMerge({ ...base, verdict: 'unavailable' }).merge, true)
  assert.equal(
    canAutoMerge({ ...base, verdict: 'unavailable', claudeRequired: true }).merge,
    false,
  )
})
