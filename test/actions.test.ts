import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  actionsFor,
  isTransient,
  primaryVerb,
  refusalFor,
  type ActionContext,
} from '../src/updates/actions.ts'

const ctx = (o: Partial<ActionContext>): ActionContext => ({ state: 'detected', ...o })

test('an update waiting on a human offers the merge, and the things you might do first', () => {
  const a = actionsFor(ctx({ state: 'pr_open', prNumber: 41, prScope: 'tag-only', hasVerdict: true }))
  assert.deepEqual(a, ['merge-deploy', 'propose', 'skip'])
})

test('a pull request with no verdict offers to read the changelog again', () => {
  assert.ok(actionsFor(ctx({ state: 'pr_open', prNumber: 41, hasVerdict: false })).includes('rerun-review'))
  assert.ok(
    actionsFor(ctx({ state: 'pr_open', prNumber: 41, hasVerdict: true, verdictError: true })).includes(
      'rerun-review',
    ),
  )
  assert.ok(
    !actionsFor(ctx({ state: 'pr_open', prNumber: 41, hasVerdict: true })).includes('rerun-review'),
    'a verdict that approved is not re-read on a whim',
  )
  assert.ok(
    actionsFor(ctx({ state: 'pr_open', prNumber: 41, hasVerdict: true, verdictHolds: true })).includes(
      'rerun-review',
    ),
    'a verdict that is holding the merge is the one worth disputing',
  )
})

test('a branch someone has pushed to is not one shipshape drafts onto', () => {
  const mine = actionsFor(ctx({ state: 'pr_open', prNumber: 7, prScope: 'tag-only', userOwned: true }))
  assert.ok(!mine.includes('propose'))
  const already = actionsFor(
    ctx({ state: 'pr_open', prNumber: 7, prScope: 'proposed', hasProposal: true }),
  )
  assert.ok(!already.includes('propose'))
})

test('the on-request rung asks, it does not merge', () => {
  assert.deepEqual(actionsFor(ctx({ state: 'held' })), ['open-pr', 'skip'])
})

test('a rolling tag can only be adopted or dismissed', () => {
  // There is nothing to change in git: the tag already points somewhere new.
  assert.deepEqual(actionsFor(ctx({ state: 'detected', detail: 'rolling' })), ['redeploy', 'skip'])
})

test('a merge that is waiting offers the button; one that failed offers another go', () => {
  assert.deepEqual(actionsFor(ctx({ state: 'merged', deployStatus: 'ready' })), ['deploy'])
  assert.deepEqual(actionsFor(ctx({ state: 'merged', deployStatus: 'pending' })), ['deploy'])
  assert.deepEqual(actionsFor(ctx({ state: 'merged', deployStatus: 'failed' })), ['retry'])
  assert.deepEqual(actionsFor(ctx({ state: 'merged', deployStatus: 'error' })), ['retry'])
})

test('a deploy in flight offers nothing at all', () => {
  assert.deepEqual(actionsFor(ctx({ state: 'deploying', deployStatus: 'running' })), [])
  assert.ok(isTransient(ctx({ state: 'deploying' })))
  assert.ok(!isTransient(ctx({ state: 'verified', deployStatus: 'verified' })))
})

test('rolling back needs a commit to revert', () => {
  assert.deepEqual(
    actionsFor(ctx({ state: 'verified', deployStatus: 'verified', mergeCommitSha: 'abc123' })),
    ['rollback'],
  )
  assert.deepEqual(actionsFor(ctx({ state: 'verified', deployStatus: 'verified' })), [])
})

test('a service that went degraded after the soak can be acknowledged', () => {
  const a = actionsFor(ctx({ state: 'deployed', deployStatus: 'degraded', mergeCommitSha: 'x' }))
  assert.deepEqual(a, ['rollback', 'ack'])
  const seen = actionsFor(
    ctx({ state: 'deployed', deployStatus: 'degraded', mergeCommitSha: 'x', ackedAt: 'now' }),
  )
  assert.deepEqual(seen, ['rollback'])
})

test('a rolled-back update can be re-landed only while the tree is back where it started', () => {
  assert.ok(actionsFor(ctx({ state: 'failed', atFromTag: true })).includes('retry'))
  assert.ok(
    !actionsFor(ctx({ state: 'failed', atFromTag: false })).includes('retry'),
    'the change is still in the tree; re-landing it would mean something else',
  )
})

test('a dismissal is reversible, a supersession is not', () => {
  assert.deepEqual(actionsFor(ctx({ state: 'skipped' })), ['retry'])
  assert.deepEqual(actionsFor(ctx({ state: 'superseded' })), [])
})

test('every state names exactly one button, and names it first', () => {
  const cases: ActionContext[] = [
    ctx({ state: 'detected' }),
    ctx({ state: 'detected', detail: 'rolling' }),
    ctx({ state: 'held' }),
    ctx({ state: 'pr_open', prNumber: 1, prScope: 'tag-only' }),
    ctx({ state: 'merged', deployStatus: 'ready' }),
    ctx({ state: 'merged', deployStatus: 'failed' }),
    ctx({ state: 'deploying' }),
    ctx({ state: 'deployed', deployStatus: 'degraded', mergeCommitSha: 'x' }),
    ctx({ state: 'verified', deployStatus: 'verified', mergeCommitSha: 'x' }),
    ctx({ state: 'failed' }),
    ctx({ state: 'skipped' }),
    ctx({ state: 'superseded' }),
  ]
  for (const c of cases) {
    const verbs = actionsFor(c)
    const primary = primaryVerb(verbs)
    if (primary) {
      assert.equal(primary, verbs[0], `${c.state}: the button must lead the list`)
    }
  }
})

test('a failed review is what the button asks about, even with a merge available', () => {
  // Merging is still possible -- the review is advisory -- but the salient thing is that
  // nobody has read the changelog yet.
  const verbs = actionsFor(ctx({ state: 'pr_open', prNumber: 9, hasVerdict: true, verdictError: true }))
  assert.equal(primaryVerb(verbs), 'rerun-review')
  assert.ok(verbs.includes('merge-deploy'))
})

test('a refused verb explains itself in a sentence', () => {
  // A stale page or a double tap gets an answer, never a 404 that htmx would drop.
  assert.match(refusalFor('deploy', ctx({ state: 'pr_open' })), /nothing is waiting to be deployed/)
  assert.match(refusalFor('rollback', ctx({ state: 'verified' })), /nothing to revert/)
  assert.match(refusalFor('retry', ctx({ state: 'failed', atFromTag: false })), /still in the tree/)
  assert.match(refusalFor('merge-deploy', ctx({ state: 'held' })), /no pull request/)
})
