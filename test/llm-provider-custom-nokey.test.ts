import { test } from 'node:test'
import assert from 'node:assert/strict'

/** A custom endpoint with no key of its own is sent no credential at all. */

process.env.LLM_BASE_URL = 'http://ollama.invalid:11434'
process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
process.env.ANTHROPIC_AUTH_TOKEN = 'tok'
delete process.env.LLM_API_KEY
delete process.env.OPENROUTER_API_KEY

const { llmClient, llmConfigured } = await import('../src/analyze/client.ts')
const { mockFetch, assertAllMocked, json } = await import('./helpers/http.ts')

test('with no key, a custom endpoint is sent no credential at all', async (t) => {
  const h = mockFetch(t, [
    {
      url: 'http://ollama.invalid:11434/v1/messages',
      reply: () =>
        json({
          id: 'm',
          type: 'message',
          role: 'assistant',
          model: 'x',
          content: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
    },
  ])
  await llmClient(0).messages.create({ model: 'qwen3', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] })
  assert.equal(h.calls[0]!.headers.get('authorization'), null)
  assert.equal(h.calls[0]!.headers.get('x-api-key'), null)
  assert.equal(llmConfigured(), true)
  assertAllMocked(h)
  delete process.env.ANTHROPIC_AUTH_TOKEN
})
