import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PolicySchema, validatePolicyText } from '../src/config.ts'
import { readerOn, reviewMode, tierFor } from '../src/policy.ts'

/**
 * The policy file got smaller: `claude:` became `review:`, and keys that only existed for
 * WUD or that nothing enforced went away. An old file must still load -- and a retired
 * key whose old value would have *restricted* shipshape must be refused rather than
 * dropped, because dropping it would quietly widen what shipshape does.
 */

const defaults = { patch: 'auto', minor: 'auto', major: 'manual', digest: 'manual' } as const

test('review: is the new block, with Opus and a $40 budget by default', () => {
  const p = PolicySchema.parse({})
  assert.equal(p.review.screen, 'off')
  assert.match(p.review.model, /claude-opus-5[.-]5/)
  assert.equal(p.review.monthly_budget_usd, 40)
  assert.ok(!('claude' in p), 'the old block is not in the parsed policy')
})

test('an old claude: block is folded in, key by key', () => {
  const p = PolicySchema.parse({
    claude: {
      mode: 'advisory',
      model: 'anthropic/claude-haiku-4.5',
      code_model: 'anthropic/claude-opus-5',
      monthly_budget_usd: 12,
      block_on: ['block', 'caution'],
      min_confidence: 'medium',
      web: { searches: 2 },
    },
  })
  assert.equal(p.review.model, 'anthropic/claude-haiku-4.5')
  assert.equal(p.review.code_model, 'anthropic/claude-opus-5')
  assert.equal(p.review.monthly_budget_usd, 12)
  // review: wins where both say something.
  const both = PolicySchema.parse({ claude: { model: 'a' }, review: { model: 'b' } })
  assert.equal(both.review.model, 'b')
})

test('claude.mode: off turns both stages off', () => {
  const p = PolicySchema.parse({ claude: { mode: 'off' } })
  assert.equal(readerOn(p), false)
  assert.equal(p.review.screen, 'off')
  assert.equal(reviewMode(p), 'off')
})

test('a screen that decides keeps the gate advisory with the reader off', () => {
  const p = PolicySchema.parse({ review: { screen: 'on', model: 'off' } })
  assert.equal(reviewMode(p), 'advisory')
})

test('retired keys load at the values that changed nothing', () => {
  for (const doc of [
    'prs:\n  enabled: true\n  scope: full\n',
    'sync:\n  blackout: []\n',
    'model_tier:\n  mode: shadow\n',
    'claude:\n  min_confidence: low\n',
  ]) {
    assert.deepEqual(validatePolicyText(doc), { ok: true }, doc)
  }
})

test('a retired key whose value restricted shipshape is refused, not dropped', () => {
  for (const doc of [
    'prs:\n  enabled: false\n',
    'prs:\n  scope: coexist\n',
    'sync:\n  blackout: ["01:00-02:00"]\n',
    'claude:\n  min_confidence: high\n',
  ]) {
    const r = validatePolicyText(doc)
    assert.equal(r.ok, false, doc)
  }
})

test('defaults accept attended', () => {
  const p = PolicySchema.parse({ defaults: { patch: 'attended' } })
  assert.equal(p.defaults.patch, 'attended')
  assert.equal(tierFor({ magnitude: 'patch', policyLabel: null, prLabel: null, defaults: p.defaults }), 'attended')
})

test('propose.mode manual reads as off', () => {
  assert.equal(PolicySchema.parse({ propose: { mode: 'manual' } }).propose.mode, 'off')
})

test('shipshape.policy: model is read as manual, which is what shadow mode returned', () => {
  assert.equal(tierFor({ magnitude: 'patch', policyLabel: 'model', prLabel: null, defaults }), 'manual')
})

test('shipshape.pr: on-request still holds a service', () => {
  // The label is deprecated in favour of shipshape.policy: on-request, and still read:
  // ignoring a label that restricts a service would widen what shipshape does to it.
  assert.equal(tierFor({ magnitude: 'patch', policyLabel: 'manual', prLabel: 'on-request', defaults }), 'held')
})
