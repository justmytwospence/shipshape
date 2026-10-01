import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The screen's place in the pipeline: who it lets the reader skip, what it may write,
 * what its adapter believes, and that a failure always falls back to what happened before
 * the screen existed.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'shipshape-cascade-'))
process.env.OPENROUTER_API_KEY = 'test-key'
delete process.env.ANTHROPIC_API_KEY
delete process.env.REPO_DIR

const { getDb } = await import('../src/db.ts')
const { readerWanted, isAudit, recordFailure } = await import('../src/analyze/run.ts')
const { applyScreen } = await import('../src/analyze/screen/run.ts')
const { askJev, jevFamilyOk, refusalOf } = await import('../src/analyze/jev.ts')

beforeEach(() => getDb().exec(`DELETE FROM verdicts; DELETE FROM llm_calls; DELETE FROM budgets;`))

// --------------------------------------------------------------- who gets read

const row = (o: Partial<Parameters<typeof readerWanted>[0]> = {}) => ({
  rerun: 0,
  has_pr: 1,
  magnitude: 'minor',
  update_id: 7,
  carriers: [{ stack: 's', service: 'x' }],
  ...o,
})
const on = (o: Partial<Parameters<typeof readerWanted>[1]> = {}) => ({
  screenMode: 'on' as const,
  screen: { decision: 'routine', error: null },
  screenCanRun: true,
  required: false,
  ...o,
})

test('off and shadow read what they always read', () => {
  for (const screenMode of ['off', 'shadow'] as const) {
    assert.equal(readerWanted(row({ has_pr: 0 }), on({ screenMode })), true, screenMode)
    assert.equal(readerWanted(row(), on({ screenMode })), true, screenMode)
  }
})

test('on: a routine screen spares the reader, unless something says read it anyway', () => {
  assert.equal(readerWanted(row(), on()), false)
  assert.equal(readerWanted(row({ magnitude: 'major' }), on()), true, 'majors are always read')
  assert.equal(readerWanted(row(), on({ required: true })), true, 'a fail-closed service is always read')
  assert.equal(readerWanted(row({ update_id: 30 }), on()), true, 'one in ten is audited')
  assert.equal(readerWanted(row({ rerun: 1, has_pr: 0 }), on()), true, 'a button press always is')
  assert.equal(isAudit(30), true)
  assert.equal(isAudit(31), false)
})

test('on: anything the screen did not call routine is read', () => {
  for (const decision of ['finding', 'escalate', 'no-notes']) {
    assert.equal(readerWanted(row(), on({ screen: { decision, error: null } })), true, decision)
  }
})

test('on: a failed or unreachable screen falls back to reading', () => {
  assert.equal(readerWanted(row(), on({ screen: { decision: null, error: '404' } })), true)
  assert.equal(readerWanted(row(), on({ screen: null, screenCanRun: false })), true)
  // ...but a screen that can run and has not yet is waited for: it runs first each tick.
  assert.equal(readerWanted(row(), on({ screen: null })), false)
})

test('on: nobody reads what nobody will read', () => {
  assert.equal(readerWanted(row({ has_pr: 0 }), on({ screen: { decision: 'finding', error: null } })), false)
  assert.equal(readerWanted(row({ magnitude: 'digest' }), on({ screen: { decision: 'finding', error: null } })), false)
})

// --------------------------------------------------------------- what it writes

const bump = { image: 'img/a', from_tag: '1.0.0', to_tag: '1.0.1' }
const result = (decision: 'routine' | 'finding' | 'escalate') => ({
  decision,
  reason: 'r',
  flags: null,
  actionable: [],
  notable: [],
  confidence: decision === 'routine' ? ('high' as const) : null,
})
const verdict = () =>
  getDb().prepare(`SELECT recommendation, confidence, source, provisional, error, next_attempt_at FROM verdicts`).get() as
    | Record<string, unknown>
    | undefined

test('routine writes an approval; a finding writes a provisional caution; escalate writes nothing', () => {
  assert.equal(applyScreen(bump, result('routine'), [], 'typesafe/jev-1.13', []), true)
  assert.deepEqual(
    { ...verdict() },
    { recommendation: 'approve', confidence: 'high', source: 'screen', provisional: 0, error: null, next_attempt_at: null },
  )
  getDb().exec(`DELETE FROM verdicts`)
  applyScreen(bump, result('finding'), [], 'typesafe/jev-1.13', [])
  assert.equal(verdict()!.recommendation, 'caution')
  assert.equal(verdict()!.provisional, 1)
  getDb().exec(`DELETE FROM verdicts`)
  assert.equal(applyScreen(bump, result('escalate'), [], 'typesafe/jev-1.13', []), false)
  assert.equal(verdict(), undefined)
})

test('the screen never writes over a reader', () => {
  getDb()
    .prepare(
      `INSERT INTO verdicts (image, from_tag, to_tag, recommendation, confidence, created_at, source)
       VALUES ('img/a', '1.0.0', '1.0.1', 'block', 'high', ?, 'reader')`,
    )
    .run(new Date().toISOString())
  assert.equal(applyScreen(bump, result('routine'), [], 'm', []), false)
  assert.equal(verdict()!.recommendation, 'block')
})

test('a reader that fails over a screen verdict leaves it standing and backs off', () => {
  applyScreen(bump, result('finding'), [], 'm', [])
  recordFailure(bump, 'overloaded')
  const v = verdict()!
  assert.equal(v.recommendation, 'caution', 'the hold stands')
  assert.equal(v.error, null)
  assert.ok(v.next_attempt_at, 'and the reader waits rather than retrying every tick')
})

// --------------------------------------------------------------- the adapter

const ok = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const decisions = (model = 'typesafe/jev-1.13-20260917') => ({
  id: 'gen-dec-1',
  model,
  answers: { q: { type: 'noul', noul: 0.9 } },
  usage: { input_tokens: 500, output_tokens: 10, cost: 0.00002 },
})

test('an answer is recorded in the ledger with what the gateway charged', async () => {
  const r = await askJev({ s: 1 }, { q: { type: 'noul', instructions: 'x' } }, {
    purpose: 'screen',
    fetchImpl: (async () => ok(decisions())) as typeof fetch,
  })
  assert.equal(r.ok, true)
  const row = getDb().prepare(`SELECT purpose, provider, cost_usd, request_id FROM llm_calls`).get() as Record<string, unknown>
  assert.deepEqual({ ...row }, { purpose: 'screen', provider: 'openrouter', cost_usd: 0.00002, request_id: 'gen-dec-1' })
})

test('a rate limit is retried once; a refusal is not retried at all', async () => {
  let calls = 0
  const flaky = (async () => (++calls === 1 ? ok({}, 429, { 'retry-after': '0' }) : ok(decisions()))) as typeof fetch
  assert.equal((await askJev({}, { q: { type: 'noul', instructions: 'x' } }, { purpose: 'screen', fetchImpl: flaky })).ok, true)
  assert.equal(calls, 2)

  calls = 0
  const refused = (async () => {
    calls++
    return ok({ error: { message: 'provider not allowed by guardrail' } }, 404)
  }) as typeof fetch
  const r = await askJev({}, { q: { type: 'noul', instructions: 'x' } }, { purpose: 'screen', fetchImpl: refused })
  assert.equal(r.ok, false)
  assert.equal(calls, 1)
  assert.match(r.ok ? '' : r.error, /guardrail/)
})

test('an answer from a model the thresholds were not tuned on is not believed', async () => {
  assert.equal(jevFamilyOk('typesafe/jev-1.13-20260917'), true)
  assert.equal(jevFamilyOk('typesafe/jev-2.0'), false)
  const r = await askJev({}, { q: { type: 'noul', instructions: 'x' } }, {
    purpose: 'screen',
    fetchImpl: (async () => ok(decisions('typesafe/jev-2.0'))) as typeof fetch,
  })
  assert.equal(r.ok, false)
})

test('an answer missing a question is not a whole answer', async () => {
  const r = await askJev({}, { q: { type: 'noul', instructions: 'x' }, other: { type: 'noul', instructions: 'y' } }, {
    purpose: 'screen',
    fetchImpl: (async () => ok(decisions())) as typeof fetch,
  })
  assert.equal(r.ok, false)
})

test('a gateway refusal reads as a sentence that says where to fix it', () => {
  const body = JSON.stringify({
    error: {
      message: '0 endpoints out of 1 requested are available matching your guardrail restrictions',
      code: 404,
      metadata: {
        ineligibility_reasons: [
          { reason: 'provider-not-allowed-by-guardrail', configure_url: 'https://openrouter.ai/workspaces/default/guardrails' },
        ],
      },
    },
  })
  assert.equal(
    refusalOf(body),
    'provider not allowed by guardrail -- change it at https://openrouter.ai/workspaces/default/guardrails',
  )
  assert.equal(refusalOf('plain text'), 'plain text')
})
