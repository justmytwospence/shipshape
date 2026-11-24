import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A custom Anthropic-compatible endpoint serves every model call, with its own key. */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-llm-custom-'))
process.env.DATA_DIR = dir
process.env.POLICY_FILE = join(dir, 'policy.yaml')
process.env.LLM_BASE_URL = 'http://llm.invalid:4000'
process.env.LLM_API_KEY = 'lk'
process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
process.env.OPENROUTER_API_KEY = 'sk-or-test'
after(() => rmSync(dir, { recursive: true, force: true }))

const { llmClient, llmProvider, decisionsKey, modelsEndpoint } = await import('../src/analyze/client.ts')
const { DEFAULT_READER_MODEL, DEFAULT_CODE_MODEL, MODEL_DEFAULTS, PolicySchema } = await import(
  '../src/policy-schema.ts'
)
const { readerOn } = await import('../src/policy.ts')
const { listModels } = await import('../src/analyze/models.ts')
const { recordCost, recordSpend, budgetExhausted } = await import('../src/analyze/claude.ts')
const { toolChoiceFor, systemPrompt, webEnabled } = await import('../src/analyze/tools.ts')
const { getDb } = await import('../src/db/index.ts')
const { mockFetch, assertAllMocked, json } = await import('./helpers/http.ts')

const message = () =>
  json({
    id: 'm',
    type: 'message',
    role: 'assistant',
    model: 'x',
    content: [],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  })

test('a custom endpoint wins, and is sent only its own key', async (t) => {
  assert.equal(llmProvider(), 'custom')
  const h = mockFetch(t, [{ url: 'http://llm.invalid:4000/v1/messages', reply: message }])
  await llmClient(0).messages.create({ model: 'qwen3', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] })
  assert.equal(h.calls[0]!.headers.get('authorization'), 'Bearer lk')
  assert.equal(h.calls[0]!.headers.get('x-api-key'), null)
  assertAllMocked(h)
})

test('the screen keeps the OpenRouter key', () => {
  assert.equal(decisionsKey(), 'sk-or-test')
})

test('a custom endpoint has no default model, and no model means no reader', () => {
  assert.deepEqual(MODEL_DEFAULTS.custom, { reader: '', code: '' })
  assert.equal(DEFAULT_READER_MODEL, '')
  assert.equal(DEFAULT_CODE_MODEL, '')
  assert.equal(readerOn(PolicySchema.parse({})), false)
  assert.equal(readerOn(PolicySchema.parse({ review: { model: 'qwen3' } })), true)
})

test('models are listed from the custom endpoint, unfiltered', async (t) => {
  assert.deepEqual(modelsEndpoint(), {
    url: 'http://llm.invalid:4000/v1/models',
    headers: { authorization: 'Bearer lk' },
  })
  const h = mockFetch(t, [
    {
      url: 'http://llm.invalid:4000/v1/models',
      reply: () => json({ data: [{ id: 'qwen3:32b' }, { id: 'claude-x' }] }),
    },
  ])
  assert.deepEqual(await listModels(), ['qwen3:32b', 'claude-x'])
  assertAllMocked(h)
})

test('calls to it cost nothing, warn about nothing and never spend the budget', () => {
  writeFileSync(process.env.POLICY_FILE!, 'review:\n  monthly_budget_usd: 0.01\n')
  const policy = PolicySchema.parse({ review: { monthly_budget_usd: 0.01 } })
  recordCost({ input_tokens: 1e6, output_tokens: 1e6 } as never, policy, 'qwen3:32b')
  const row = getDb().prepare(`SELECT cost_usd, provider FROM llm_calls ORDER BY id DESC LIMIT 1`).get() as {
    cost_usd: number
    provider: string
  }
  assert.deepEqual([row.cost_usd, row.provider], [0, 'custom'])
  assert.equal(getDb().prepare(`SELECT 1 FROM events WHERE message LIKE 'no pricing known%'`).get(), undefined)
  recordSpend(policy, 'typesafe/jev-1.13', 'screen', 0.5, { input: 1, output: 1 })
  assert.equal(budgetExhausted(), false)
})

test('tool choice is never forced, the system prompt is not cached, and web tools stay off', () => {
  assert.deepEqual(toolChoiceFor('claude-opus-5'), { type: 'auto' })
  assert.equal(systemPrompt('s'), 's')
  assert.equal(webEnabled(PolicySchema.parse({})), false)
})
