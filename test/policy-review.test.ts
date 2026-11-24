import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validatePolicyText } from '../src/config.ts'
import { PolicySchema, retiredKeys } from '../src/policy-schema.ts'
import { readerOn, reviewMode } from '../src/policy.ts'

/**
 * The policy file got smaller: `claude:` became `review:`, and keys that only existed for
 * WUD, for pull requests, or that nothing enforced went away. A file that still carries
 * one is refused, naming the keys and the converter.
 */

test('review: has its defaults', () => {
  const p = PolicySchema.parse({})
  assert.equal(p.review.screen, 'off')
  assert.match(p.review.model, /claude-sonnet-5[.-]5/)
  assert.match(p.review.code_model, /claude-opus-5[.-]5/)
  assert.equal(p.review.monthly_budget_usd, 15)
  assert.equal(p.review.web, 'auto')
  assert.ok(!('claude' in p), 'the old block is not in the parsed policy')
})

test('a screen that decides keeps the gate advisory with the reader off', () => {
  const p = PolicySchema.parse({ review: { screen: 'on', model: 'off' } })
  assert.equal(reviewMode(p), 'advisory')
  assert.equal(readerOn(p), false)
})

test('retiredKeys names what a file still carries that nothing reads', () => {
  const doc = 'merge_method: squash\nmerge:\n  cooldown_days: 7\nnotify:\n  routine: off\n  sinks: []\nsync:\n  push_main: true\n'
  assert.deepEqual(retiredKeys(doc), ['merge_method', 'merge', 'notify.routine'])
  assert.deepEqual(retiredKeys('ship:\n  cooldown_days: 7\n'), [])
})

test('a file with retired keys is refused, naming them and the converter', () => {
  const r = validatePolicyText('merge:\n  auto: true\n')
  assert.equal(r.ok, false)
  assert.match(r.ok ? '' : r.error, /merge/)
  assert.match(r.ok ? '' : r.error, /convert-v1/)
})

test('propose.mode manual is no longer accepted', () => {
  assert.equal(validatePolicyText('propose:\n  mode: manual\n').ok, false)
})
