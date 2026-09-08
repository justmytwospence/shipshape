import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canAutoMerge, shouldOpenPr } from '../src/policy.ts'
import { classifyChecks } from '../src/gitops/automerge.ts'

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

/**
 * "A check is red" and "this token may not look" are different facts, and conflating
 * them deadlocked the lab: a fine-grained token scoped to Contents + Pull requests gets
 * 403 from the checks API, every auto-merge refused forever, and nothing said why.
 */

const run = (conclusion: string | null, name = 'ci') => ({ conclusion, name })

test('a red check blocks, and its name is the reason', () => {
  assert.deepEqual(classifyChecks(200, [run('failure', 'build')]), { kind: 'red', name: 'build' })
  assert.deepEqual(classifyChecks(200, [run('timed_out', 'e2e')]), { kind: 'red', name: 'e2e' })
})

test('anything not red is clear, including still-running and skipped', () => {
  assert.deepEqual(classifyChecks(200, []), { kind: 'clear' })
  for (const c of [null, 'success', 'neutral', 'skipped', 'cancelled', 'action_required']) {
    assert.deepEqual(classifyChecks(200, [run(c)]), { kind: 'clear' }, String(c))
  }
  // A red one anywhere in the list still wins.
  assert.equal(classifyChecks(200, [run('success'), run('failure', 'lint')]).kind, 'red')
})

test('403 and 404 mean the token cannot look, not that something is red', () => {
  // This is the whole bug. Treating it as red is a permanent block on a repository with
  // no CI, which is exactly where the token has no reason to carry Checks: read.
  for (const status of [403, 404]) {
    const v = classifyChecks(status, [])
    assert.equal(v.kind, 'not-visible', String(status))
    assert.match(v.kind === 'not-visible' ? v.why : '', new RegExp(String(status)))
  }
})

test('a server error or a network failure still fails closed', () => {
  // Here "unknown" is honest: a check may be red and we could not see it.
  assert.equal(classifyChecks(500, []).kind, 'unknown')
  assert.equal(classifyChecks(502, []).kind, 'unknown')
  // No status at all is a network problem, not a permission one.
  assert.equal(classifyChecks(null, [], 'ECONNRESET').kind, 'unknown')
})

test('the two failure modes are never confused for one another', () => {
  // The regression that matters: if these ever collapse back into one branch, a repo
  // with no CI stops merging and says nothing.
  assert.notEqual(classifyChecks(403, []).kind, classifyChecks(500, []).kind)
  assert.notEqual(classifyChecks(403, []).kind, classifyChecks(200, [run('failure')]).kind)
})
