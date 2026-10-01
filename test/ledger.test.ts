import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Every call that may have been billed reaches the ledger and the budget.
 *
 * It used to record only calls that returned the answer they were asked for. A review
 * that came back without a verdict, or a call that timed out after the provider had
 * started charging, cost money and left no row -- a budget that cannot see a call it paid
 * for under-counts in the direction that overspends.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'shipshape-ledger-'))
delete process.env.REPO_DIR

const { getDb } = await import('../src/db.ts')
const { PolicySchema } = await import('../src/config.ts')
const { recordCost, recordUnanswered, recordSpend, monthlySpend, isTimeout } = await import(
  '../src/analyze/claude.ts'
)

const policy = PolicySchema.parse({})

beforeEach(() => getDb().exec(`DELETE FROM llm_calls; DELETE FROM budgets;`))

const usage = (input: number, output: number) =>
  ({ input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }) as never

test('a call that returned no answer is still recorded and still counted', () => {
  recordCost(usage(1e6, 0), policy, 'anthropic/claude-opus-5.5', 'verdict', {
    image: 'img/a',
    fromTag: '1',
    toTag: '2',
    outcome: 'no-answer',
    requestId: 'gen-1',
  })
  const row = getDb().prepare(`SELECT * FROM llm_calls`).get() as Record<string, unknown>
  assert.equal(row.outcome, 'no-answer')
  assert.equal(row.image, 'img/a')
  assert.equal(row.request_id, 'gen-1')
  assert.equal(row.cost_estimated, 0)
  assert.equal(monthlySpend(), 4)
})

test('a timeout is recorded at an estimate of its prompt, and says it is an estimate', () => {
  recordUnanswered(policy, 'anthropic/claude-opus-5.5', 'proposal', 4_000_000)
  const row = getDb().prepare(`SELECT * FROM llm_calls`).get() as Record<string, unknown>
  assert.equal(row.outcome, 'timeout')
  assert.equal(row.cost_estimated, 1)
  assert.equal(row.input_tokens, 1_000_000)
  assert.equal(monthlySpend(), 4)
})

test('spend reported by another provider lands in the same budget', () => {
  recordSpend(policy, 'typesafe/jev-1.13', 'screen', 0.0004, { input: 9000, output: 50 }, { provider: 'openrouter' })
  recordCost(usage(1e6, 0), policy, 'anthropic/claude-opus-5.5', 'verdict')
  assert.ok(Math.abs(monthlySpend() - 4.0004) < 1e-9)
  const purposes = (getDb().prepare(`SELECT purpose FROM llm_calls ORDER BY id`).all() as { purpose: string }[]).map(
    (r) => r.purpose,
  )
  assert.deepEqual(purposes, ['screen', 'verdict'])
})

test('only the client giving up counts as a timeout', () => {
  assert.equal(isTimeout({ name: 'APIConnectionTimeoutError', message: 'Request timed out.' }), true)
  assert.equal(isTimeout(new Error('Request timed out.')), true)
  assert.equal(isTimeout(new Error('429 rate limited')), false)
})
