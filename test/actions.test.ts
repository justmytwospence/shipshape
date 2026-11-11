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

const hold = (kind: 'ask' | 'needs-action' | 'lifeline' | 'unsafe', waivable: boolean) => ({ kind, waivable, text: kind })

test('an update nothing holds offers ship, and the things you might do first', () => {
  // Ship always leads: it is the operator saying yes, which outranks a hold.
  assert.deepEqual(actionsFor(ctx({ hasVerdict: true })), ['ship', 'skip'])
})

test('a decision offers snooze, and always-ship only when every hold can be waived', () => {
  assert.deepEqual(actionsFor(ctx({ hasVerdict: true, holds: [hold('ask', true)] })), ['ship', 'snooze', 'always-ship', 'skip'])
  assert.deepEqual(
    actionsFor(ctx({ hasVerdict: true, holds: [hold('ask', true), hold('lifeline', false)] })),
    ['ship', 'snooze', 'skip'],
    'a hold no rule may waive leaves nothing for always to mean',
  )
  assert.deepEqual(actionsFor(ctx({ hasVerdict: true, holds: [hold('ask', true)], snoozed: true })), ['ship', 'always-ship', 'skip'])
})

test('work to do offers a draft, until one exists', () => {
  const a = actionsFor(ctx({ hasVerdict: true, holds: [hold('needs-action', false)] }))
  assert.deepEqual(a, ['ship', 'snooze', 'rerun-review', 'propose', 'skip'])
  assert.ok(!actionsFor(ctx({ hasVerdict: true, holds: [hold('needs-action', false)], hasProposal: true })).includes('propose'))
})

test('no review, or a failed one, offers to read the changelog', () => {
  assert.ok(actionsFor(ctx({ hasVerdict: false })).includes('rerun-review'))
  assert.ok(actionsFor(ctx({ hasVerdict: true, verdictError: true })).includes('rerun-review'))
  assert.ok(!actionsFor(ctx({ hasVerdict: true })).includes('rerun-review'), 'a verdict that arrived is not re-read on a whim')
})

test('a frozen service asks: ship or skip', () => {
  assert.deepEqual(actionsFor(ctx({ state: 'frozen' })), ['ship', 'skip'])
})

test('a v1 pull request not yet closed by the cutover can only be skipped', () => {
  assert.deepEqual(actionsFor(ctx({ state: 'pr_open' })), ['skip'])
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
    actionsFor(ctx({ state: 'verified', deployStatus: 'verified', mergeCommitSha: 'abc123', hasReaderVerdict: true })),
    ['rollback'],
  )
  assert.deepEqual(actionsFor(ctx({ state: 'verified', deployStatus: 'verified', hasReaderVerdict: true })), [])
})

test('a running version nothing has read offers a reading', () => {
  // The only way to get one for a patch that applied on its own, or one only the screen saw.
  assert.deepEqual(actionsFor(ctx({ state: 'verified', deployStatus: 'verified' })), ['rerun-review'])
  assert.ok(!actionsFor(ctx({ state: 'verified', hasReaderVerdict: true })).includes('rerun-review'))
  assert.ok(!actionsFor(ctx({ state: 'verified', detail: 'rolling' })).includes('rerun-review'))
})

test('a left-stopped update offers Roll back and nothing else', () => {
  // The merge stands and nothing was started: there is no deploy to try again and nothing
  // outstanding to acknowledge, only the version itself to take back.
  assert.deepEqual(
    actionsFor(ctx({ state: 'left-stopped', deployStatus: 'left-stopped', mergeCommitSha: 'abc123' })),
    ['rollback'],
  )
  assert.deepEqual(actionsFor(ctx({ state: 'left-stopped', deployStatus: 'left-stopped' })), [])
})

test('a rolling tag left stopped still offers Redeploy', () => {
  // Its move is in no file and the scan's baseline has already advanced: without the button,
  // nothing would ever offer this digest again.
  assert.deepEqual(
    actionsFor(ctx({ state: 'left-stopped', detail: 'rolling', deployStatus: 'left-stopped' })),
    ['redeploy'],
  )
})

test('a service that went degraded after the soak can be acknowledged', () => {
  const a = actionsFor(ctx({ state: 'deployed', deployStatus: 'degraded', mergeCommitSha: 'x', hasReaderVerdict: true }))
  assert.deepEqual(a, ['rollback', 'ack'])
  const seen = actionsFor(
    ctx({ state: 'deployed', deployStatus: 'degraded', mergeCommitSha: 'x', ackedAt: 'now', hasReaderVerdict: true }),
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
    ctx({ state: 'frozen' }),
    ctx({ state: 'pr_open', prScope: 'tag-only' }),
    ctx({ state: 'merged', deployStatus: 'ready' }),
    ctx({ state: 'merged', deployStatus: 'failed' }),
    ctx({ state: 'deploying' }),
    ctx({ state: 'deployed', deployStatus: 'degraded', mergeCommitSha: 'x' }),
    ctx({ state: 'verified', deployStatus: 'verified', mergeCommitSha: 'x' }),
    ctx({ state: 'left-stopped', deployStatus: 'left-stopped', mergeCommitSha: 'x' }),
    ctx({ state: 'left-stopped', detail: 'rolling', deployStatus: 'left-stopped' }),
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

test('a refused verb explains itself in a sentence', () => {
  // A stale page or a double tap gets an answer, never a 404 that htmx would drop.
  assert.match(refusalFor('deploy', ctx({ state: 'pr_open' })), /nothing is waiting to be deployed/)
  assert.match(refusalFor('rollback', ctx({ state: 'verified' })), /nothing to revert/)
  assert.match(refusalFor('retry', ctx({ state: 'failed', atFromTag: false })), /still in the tree/)
  assert.match(refusalFor('ship', ctx({ state: 'verified' })), /nothing to ship/)
  assert.match(refusalFor('always-ship', ctx({ holds: [hold('lifeline', false)] })), /cannot be waived/)
  assert.match(refusalFor('snooze', ctx({ snoozed: true })), /already snoozed/)
})
