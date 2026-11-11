import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PolicySchema } from '../src/config.ts'
import { present, spoken, type PresentFacts } from '../src/updates/present.ts'

/**
 * The ship button and its confirmation say what will actually happen.
 *
 * A confirmation that describes some other configuration than the one in force is worse
 * than none: it is the sentence read right before acting. So it is derived from the same
 * facts the code that acts reads -- including that a change carrying drafted edits is
 * reported, not rolled back, when it fails.
 */

const facts = (over: Partial<PresentFacts> = {}): PresentFacts => ({
  stack: 'media',
  service: 'jellyfin',
  fromTag: '1.0.0',
  toTag: '1.1.0',
  scope: 'tag-only',
  members: [{ stack: 'media', service: 'jellyfin', cls: 'normal' }],
  restorePoint: false,
  ...over,
})

const policy = PolicySchema.parse({})

test('ship says it is a merge commit, and the deploy that follows', () => {
  const p = present(['ship'], facts(), policy)['ship']!
  assert.equal(p.label, 'Ship')
  assert.equal(p.steps![0], 'merge it into main with a merge commit')
  assert.ok(p.steps!.some((s) => /docker compose/.test(s)))
  assert.ok(p.steps!.some((s) => /automatically/.test(s)))
})

test('the other services a decision covers are named, and a long list is cut', () => {
  const members = [{ stack: 'media', service: 'jellyfin', cls: 'normal' as const }]
  for (let i = 0; i < 6; i++) members.push({ stack: `s${i}`, service: `side${i}`, cls: 'normal' as const })
  const steps = present(['ship'], facts({ members }), policy)['ship']!.steps!
  assert.ok(steps.some((s) => /also updates side0, side1, side2, side3 and 2 more/.test(s)))
})

test('a restore point is promised only when one will be taken', () => {
  const withIt = present(['ship'], facts({ restorePoint: true }), policy)['ship']!.steps!
  const without = present(['ship'], facts(), policy)['ship']!.steps!
  assert.ok(withIt.some((s) => /restore point/.test(s)))
  assert.ok(!without.some((s) => /restore point/.test(s)))
})

test('the confirmation is written from policy.yaml', () => {
  const tuned = PolicySchema.parse({ deploy: { verify_window_s: 120, soak_s: 0, rollback: 'suggest' } })
  const p = present(['ship'], facts(), tuned)['ship']!
  assert.ok(p.steps!.includes('watch it for up to 2 minutes'))
  assert.ok(!p.steps!.some((s) => /later before calling it verified/.test(s)), 'no soak when soak_s is 0')
  assert.ok(p.steps!.some((s) => /tell you how to put the old version back/.test(s)))
})

test('a change carrying more than a tag is never promised a rollback', () => {
  const p = present(['ship'], facts({ scope: 'proposed' }), policy)['ship']!
  assert.ok(!p.steps!.some((s) => /automatically/.test(s)))
  assert.ok(p.steps!.some((s) => /rather than roll back/.test(s)))
})

test('always ship says it writes a rule before it ships', () => {
  const p = present(['always-ship'], facts(), policy)['always-ship']!
  assert.match(p.steps![0]!, /standing rule to policy.yaml/)
  assert.equal(present(['snooze'], facts(), policy)['snooze']!.label, 'Snooze 1 week')
})

test('durations read the way a person says them', () => {
  assert.equal(spoken(30), '30 seconds')
  assert.equal(spoken(300), '5 minutes')
  assert.equal(spoken(1800), '30 minutes')
  assert.equal(spoken(7200), '2 hours')
})
