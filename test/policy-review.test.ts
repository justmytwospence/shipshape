import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PolicySchema, retiredKeys, validatePolicyText } from '../src/config.ts'
import { readerOn, reviewMode } from '../src/policy.ts'

/**
 * The policy file got smaller: `claude:` became `review:`, and keys that only existed for
 * WUD or that nothing enforced went away. An old file must still load. v2 goes further:
 * it retires the pull-request keys too (`merge`, `prs`, `revise`, `defaults`), and loads
 * them without error rather than refusing a file that used to be valid.
 */

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

test('retired keys load, whatever their old values were', () => {
  // Nothing an old file said is refused any more: v2 ignores what it no longer reads, and
  // the scan says so once (retiredKeys), rather than failing to load.
  for (const doc of [
    'prs:\n  enabled: true\n  scope: full\n',
    'prs:\n  enabled: false\n',
    'prs:\n  scope: coexist\n',
    'sync:\n  blackout: []\n',
    'sync:\n  blackout: ["01:00-02:00"]\n',
    'model_tier:\n  mode: shadow\n',
    'claude:\n  min_confidence: low\n',
    'claude:\n  min_confidence: high\n',
    'merge_method: rebase\ndefaults:\n  patch: attended\nrevise:\n  mode: act\n',
  ]) {
    assert.deepEqual(validatePolicyText(doc), { ok: true }, doc)
  }
})

test('retiredKeys names what a file still carries that nothing reads', () => {
  const doc = 'merge_method: squash\nmerge:\n  cooldown_days: 7\nnotify:\n  routine: off\n  sinks: []\nsync:\n  push_main: true\n'
  assert.deepEqual(retiredKeys(doc), ['merge_method', 'merge', 'notify.routine'])
  assert.deepEqual(retiredKeys('ship:\n  cooldown_days: 7\n'), [])
})

test('propose.mode manual reads as off', () => {
  assert.equal(PolicySchema.parse({ propose: { mode: 'manual' } }).propose.mode, 'off')
})
