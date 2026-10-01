import { test } from 'node:test'
import assert from 'node:assert/strict'
import { costOf } from '../src/analyze/pricing.ts'
import { supportsDynamicFiltering, toolChoiceFor, worstCaseFetchTokens } from '../src/analyze/tools.ts'

const usage = (o: Partial<Record<string, number>> = {}) =>
  ({
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...o,
  }) as never

test('published rates, not remembered ones', () => {
  // These numbers were wrong once — $15/$75 for Opus, guessed rather than checked —
  // and over-reported spend threefold. A wrong number here is worse than none.
  const m = (model: string, i: number, o: number) =>
    costOf(usage({ input_tokens: i, output_tokens: o }), model).cost

  assert.equal(m('claude-opus-5', 1e6, 0), 5)
  assert.equal(m('claude-opus-5', 0, 1e6), 25)
  assert.equal(m('claude-haiku-4-5-20251001', 1e6, 0), 1)
  assert.equal(m('claude-sonnet-5', 0, 1e6), 15)
  assert.equal(m('claude-fable-5', 1e6, 0), 10)
  // 5.5 is cheaper than 5, and the bare `claude-opus-` prefix would price it as 5.
  assert.equal(m('anthropic/claude-opus-5.5', 1e6, 0), 4)
  assert.equal(m('claude-opus-5-5', 0, 1e6), 20)
  assert.equal(m('anthropic/claude-sonnet-5.5', 1e6, 0), 2)
})

test('an unknown model bills at the highest known rate', () => {
  // Under-counting is the failure that actually costs money: the budget stops nothing.
  const unknown = costOf(usage({ input_tokens: 1e6 }), 'claude-something-new').cost
  const dearest = costOf(usage({ input_tokens: 1e6 }), 'claude-fable-5').cost
  assert.equal(unknown, dearest)
})

test('cache tokens are billed, and billed at their own rates', () => {
  // They are NOT part of input_tokens — ignoring them under-counts every cached call,
  // which is the call you make most often.
  const read = costOf(usage({ cache_read_input_tokens: 1e6 }), 'claude-opus-5').cost
  const write = costOf(usage({ cache_creation_input_tokens: 1e6 }), 'claude-opus-5').cost
  assert.equal(read, 5 * 0.1)
  assert.equal(write, 5 * 1.25)
  // Which is the whole point: reading is an order of magnitude cheaper than paying full price.
  assert.ok(read < costOf(usage({ input_tokens: 1e6 }), 'claude-opus-5').cost / 5)
})

test('searches are billed per request, on top of tokens', () => {
  const u = { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 5 } }
  assert.equal(costOf(u as never, 'claude-opus-5').cost, 5 * 0.01)
})

test('the 2026 tool revisions are only offered to models that have them', () => {
  assert.equal(supportsDynamicFiltering('claude-opus-5'), true)
  assert.equal(supportsDynamicFiltering('claude-sonnet-5'), true)
  // The model every stage now runs on, spelled the way OpenRouter spells it.
  assert.equal(supportsDynamicFiltering('anthropic/claude-opus-5.5'), true)
  // Sending these to Haiku is an error, not a downgrade.
  assert.equal(supportsDynamicFiltering('claude-haiku-4-5-20251001'), false)
})

test('the fetch budget states its own worst case', () => {
  // What a call can cost is fetches x content, not anything about the prompt.
  assert.equal(worstCaseFetchTokens({ searches: 4, fetches: 5, content_tokens: 12_000 }), 60_000)
})

test('a gateway on the operator\'s own key reports the provider charge separately', () => {
  // OpenRouter BYOK: `cost` is only its own fee, and the provider's charge is upstream.
  // Reading `cost` alone recorded every Opus draft at $0 from 2026-09-29 on.
  const byok = {
    input_tokens: 2811,
    output_tokens: 47,
    cost: 0,
    is_byok: true,
    cost_details: { upstream_inference_cost: 0.012184 },
  }
  assert.equal(costOf(byok as never, 'anthropic/claude-opus-5.5').cost, 0.012184)
  // A BYOK answer that does not say what upstream charged falls back to the table.
  const silent = { input_tokens: 1e6, output_tokens: 0, cost: 0, is_byok: true }
  assert.equal(costOf(silent as never, 'anthropic/claude-opus-5.5').cost, 4)
  // Not BYOK: `cost` is the whole charge, as before.
  assert.equal(costOf({ input_tokens: 1e6, output_tokens: 0, cost: 0.5 } as never, 'anthropic/claude-opus-5.5').cost, 0.5)
})

test('models that refuse a forced tool choice are asked, not forced', () => {
  assert.deepEqual(toolChoiceFor('anthropic/claude-opus-5.5'), { type: 'auto' })
  assert.deepEqual(toolChoiceFor('claude-sonnet-5-5'), { type: 'auto' })
  assert.deepEqual(toolChoiceFor('anthropic/claude-opus-5'), { type: 'any' })
  assert.deepEqual(toolChoiceFor('anthropic/claude-haiku-4.5'), { type: 'any' })
})
