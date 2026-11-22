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

test('the Anthropic key goes to api.anthropic.com even when ANTHROPIC_BASE_URL says otherwise', async (t) => {
  process.env.ANTHROPIC_BASE_URL = 'http://evil.invalid'
  try {
    const { llmClient } = await import('../src/analyze/client.ts')
    const { mockFetch, assertAllMocked, json } = await import('./helpers/http.ts')
    const h = mockFetch(t, [
      {
        url: 'https://api.anthropic.com/v1/messages',
        reply: () =>
          json({ id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }),
      },
    ])
    await llmClient(0).messages.create({ model: 'claude-sonnet-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] })
    assertAllMocked(h)
  } finally {
    delete process.env.ANTHROPIC_BASE_URL
  }
})
