import { test } from 'node:test'
import assert from 'node:assert/strict'

const { baseModel } = await import('../src/analyze/client.ts')
const { supportsDynamicFiltering } = await import('../src/analyze/tools.ts')
const { costOf } = await import('../src/analyze/pricing.ts')

/**
 * Routing a model call through a gateway, without the two silent downgrades.
 *
 * OpenRouter speaks the Anthropic Messages API natively, so the SDK, the tools and the
 * forced `tool_choice` all carry over. What changes is the spelling of the model id:
 * `anthropic/claude-haiku-4.5` rather than `claude-haiku-4-5-20251001`. Two pieces of
 * logic match the family by prefix, and both fail *open in the expensive direction* if
 * the vendor segment is left on -- the web tools drop to the revision without dynamic
 * filtering, and the pricing table falls through to its most expensive row. Neither
 * raises anything; the first shows up as a bigger context window and the second as a
 * budget that stops early.
 */

test('a routing prefix is stripped down to the family', () => {
  assert.equal(baseModel('anthropic/claude-opus-5'), 'claude-opus-5')
  assert.equal(baseModel('anthropic/claude-haiku-4.5'), 'claude-haiku-4.5')
  // Already bare: unchanged, so talking to Anthropic directly is untouched.
  assert.equal(baseModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5-20251001')
})

test('the modern tool revisions survive the prefix', () => {
  // The bug this guards: `'anthropic/claude-opus-5'.startsWith('claude-opus-5')` is
  // false, so every drafted config change would have used the older web tools.
  assert.equal(supportsDynamicFiltering('anthropic/claude-opus-5'), true)
  assert.equal(supportsDynamicFiltering('claude-opus-5'), true)
  // Haiku genuinely does not support them, prefix or not -- sending them is an error.
  assert.equal(supportsDynamicFiltering('anthropic/claude-haiku-4.5'), false)
  assert.equal(supportsDynamicFiltering('claude-haiku-4-5-20251001'), false)
})

const usage = (over: Record<string, unknown> = {}) =>
  ({
    input_tokens: 1_000_000,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...over,
  }) as never

test('a prefixed model prices as its family, not as the fallback row', () => {
  // Haiku input is $1/M. The fallback row is $10/M -- a 10x over-count that would stop
  // analysis a tenth of the way into the month.
  assert.equal(costOf(usage(), 'anthropic/claude-haiku-4.5').cost, 1)
  assert.equal(costOf(usage(), 'claude-haiku-4-5-20251001').cost, 1)
})

test('what the gateway says it charged beats what the table computes', () => {
  // The same model can route via Bedrock at rates that are not Anthropic's list price,
  // so a reported cost is the true one.
  assert.equal(costOf(usage({ cost: 0.001183 }), 'anthropic/claude-haiku-4.5').cost, 0.001183)
  // Zero is a real answer (a free or fully-cached call), not a missing one.
  assert.equal(costOf(usage({ cost: 0 }), 'anthropic/claude-haiku-4.5').cost, 0)
  // Nonsense falls back rather than poisoning the ledger.
  assert.equal(costOf(usage({ cost: -1 }), 'anthropic/claude-haiku-4.5').cost, 1)
  assert.equal(costOf(usage({ cost: 'free' }), 'anthropic/claude-haiku-4.5').cost, 1)
})

test('token counts are reported as themselves whoever served the call', () => {
  const c = costOf(usage({ cost: 0.5, output_tokens: 42 }), 'anthropic/claude-opus-5')
  assert.equal(c.input, 1_000_000)
  assert.equal(c.output, 42)
})
