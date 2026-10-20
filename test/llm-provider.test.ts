import { test } from 'node:test'
import assert from 'node:assert/strict'

// Both keys set, as in production since 2026-10-20: Messages go to Anthropic (the Max
// plan's API credits), Jev keeps the OpenRouter key, and neither key crosses over.
process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
process.env.OPENROUTER_API_KEY = 'sk-or-test'

const { llmProvider, decisionsKey, modelsEndpoint } = await import('../src/analyze/client.ts')
const { DEFAULT_MODEL } = await import('../src/config.ts')

test('with both keys, Messages go to Anthropic and Jev stays on OpenRouter', () => {
  assert.equal(llmProvider(), 'anthropic')
  assert.equal(decisionsKey(), 'sk-or-test')
  assert.equal(DEFAULT_MODEL, 'claude-opus-5-5')
  const m = modelsEndpoint()
  assert.match(m!.url, /api\.anthropic\.com/)
  assert.equal(m!.headers['x-api-key'], 'sk-ant-test')
  assert.equal(m!.headers.authorization, undefined)
})
