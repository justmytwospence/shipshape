import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The checklist's reason for "reviews are off" agrees with the gate, case for case. */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-review-state-'))
process.env.DATA_DIR = dir
delete process.env.REPO_DIR
delete process.env.ANTHROPIC_API_KEY
delete process.env.OPENROUTER_API_KEY
delete process.env.LLM_BASE_URL

const { PolicySchema } = await import('../src/policy-schema.ts')
const { reviewOffReason } = await import('../src/analyze/review-state.ts')
const { reviewExpected } = await import('../src/gitops/policy-inputs.ts')

after(() => rmSync(dir, { recursive: true, force: true }))

const policy = (review: Record<string, unknown>) => PolicySchema.parse({ review })

test('with no provider, reviews are off and say why', () => {
  assert.equal(reviewOffReason(policy({})), 'no model provider is set')
})

test('reviewOffReason is null exactly when a review is expected', () => {
  for (const key of [undefined, 'sk-ant-test']) {
    if (key) process.env.ANTHROPIC_API_KEY = key
    else delete process.env.ANTHROPIC_API_KEY
    for (const review of [{}, { model: 'off' }, { model: 'off', screen: 'on' }, { model: '' }]) {
      const p = policy(review)
      assert.equal(reviewOffReason(p) === null, reviewExpected(p), JSON.stringify({ key: !!key, review }))
    }
  }
  delete process.env.ANTHROPIC_API_KEY
})
