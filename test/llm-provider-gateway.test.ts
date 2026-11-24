import { test } from 'node:test'
import assert from 'node:assert/strict'

/** An install that pointed LLM_BASE_URL at a gateway with only an OpenRouter key keeps working. */

process.env.LLM_BASE_URL = 'http://gw.invalid'
process.env.OPENROUTER_API_KEY = 'sk-or-test'
delete process.env.LLM_API_KEY
delete process.env.ANTHROPIC_API_KEY

const { llmClient, llmProvider } = await import('../src/analyze/client.ts')
const { mockFetch, assertAllMocked, json } = await import('./helpers/http.ts')

test('an OpenRouter key with LLM_BASE_URL keeps reaching that gateway', async (t) => {
  assert.equal(llmProvider(), 'custom')
  const h = mockFetch(t, [
    {
      url: 'http://gw.invalid/v1/messages',
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
  await llmClient(0).messages.create({ model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] })
  assert.equal(h.calls[0]!.headers.get('authorization'), 'Bearer sk-or-test')
  assertAllMocked(h)
})
