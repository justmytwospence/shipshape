import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PolicySchema } from '../src/config.ts'
import { mergeDeploys, present, spoken, type PresentFacts } from '../src/updates/present.ts'

/**
 * The merge button and its confirmation say what will actually happen.
 *
 * Both were constants: "Merge & deploy" on services whose deploy waits for a button, and a
 * dialog promising a five-minute watch, a thirty-minute soak and an automatic rollback
 * whatever policy.yaml said -- including for pull requests that are reported, not rolled
 * back, when they fail.
 */

const facts = (over: Partial<PresentFacts> = {}): PresentFacts => ({
  stack: 'media',
  service: 'jellyfin',
  fromTag: '1.0.0',
  toTag: '1.1.0',
  pr: { number: 7, scope: 'tag-only' },
  members: [{ stack: 'media', service: 'jellyfin', tier: 'manual' }],
  ...over,
})

const policy = PolicySchema.parse({})

test('a service deployed by hand is merged, not merged and deployed', () => {
  const p = present(['merge-deploy'], facts({ members: [{ stack: 'media', service: 'jellyfin', tier: 'attended' }] }), policy)
  assert.equal(p['merge-deploy']?.label, 'Merge')
  assert.ok(p['merge-deploy']?.steps?.some((s) => /press Deploy/.test(s)))
  assert.ok(!p['merge-deploy']?.steps?.some((s) => /docker compose/.test(s)))
})

test('one member that waits makes the whole group wait', () => {
  const f = facts({
    members: [
      { stack: 'media', service: 'jellyfin', tier: 'manual' },
      { stack: 'media', service: 'db', tier: 'held' },
    ],
  })
  assert.equal(mergeDeploys(f), false)
  const steps = present(['merge-deploy'], f, policy)['merge-deploy']!.steps!
  assert.ok(steps.some((s) => /also updates db/.test(s)))
})

test('the confirmation is written from policy.yaml', () => {
  const tuned = PolicySchema.parse({
    merge_method: 'rebase',
    deploy: { verify_window_s: 120, soak_s: 0, rollback: 'suggest' },
  })
  const p = present(['merge-deploy'], facts(), tuned)['merge-deploy']!
  assert.equal(p.label, 'Merge & deploy')
  assert.equal(p.steps![0], 'rebase #7 onto main')
  assert.ok(p.steps!.includes('watch it for up to 2 minutes'))
  assert.ok(!p.steps!.some((s) => /later before calling it verified/.test(s)), 'no soak when soak_s is 0')
  assert.ok(p.steps!.some((s) => /tell you how to put the old version back/.test(s)))
})

test('a pull request carrying more than a tag is never promised a rollback', () => {
  const p = present(['merge-deploy'], facts({ pr: { number: 7, scope: 'proposed' } }), policy)['merge-deploy']!
  assert.ok(!p.steps!.some((s) => /automatically/.test(s)))
  assert.ok(p.steps!.some((s) => /rather than roll back/.test(s)))
})

test('durations read the way a person says them', () => {
  assert.equal(spoken(30), '30 seconds')
  assert.equal(spoken(300), '5 minutes')
  assert.equal(spoken(1800), '30 minutes')
  assert.equal(spoken(7200), '2 hours')
})
