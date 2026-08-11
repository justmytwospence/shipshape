import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'shipshape-test-'))

const { rollbackPlan, revertCommand } = await import('../src/deploy/rollback.ts')
const { getDb } = await import('../src/db.ts')
const { failedTarget } = await import('../src/scan.ts')
const { PolicySchema } = await import('../src/config.ts')
import type { Verdict } from '../src/deploy/verify.ts'

/**
 * The two safety properties around undoing a deploy.
 *
 * One: it fires only on evidence solid enough to justify rewriting main unattended.
 * Two: once it has fired, the version it undid is never offered again on its own --
 * without which the next scan would re-detect the same upgrade, re-deploy it, and roll
 * it back again, forever.
 */

const failed: Verdict = {
  kind: 'failed',
  findings: [{ service: 'svc', severity: 'hard', code: 'crash-loop', detail: 'restart loop' }],
  detail: 'svc: restart loop',
}

const base = {
  mode: 'auto' as const,
  scope: 'tag-only',
  mergeSha: 'abc1234',
  mergeMethod: 'squash',
  verdict: failed,
}

test('a clean tag-only failure rolls back on its own', () => {
  assert.equal(rollbackPlan(base)?.action, 'auto')
})

test('a pull request carrying more than an image line is never reverted unattended', () => {
  // Drafted config changes, or a branch somebody pushed to. Reverting that would throw
  // away work nobody asked shipshape to undo.
  const p = rollbackPlan({ ...base, scope: 'proposed' })
  assert.equal(p?.action, 'suggest')
  assert.match(p!.reason, /more than an image line/)
})

test('without a recorded merge commit there is nothing safe to revert', () => {
  assert.equal(rollbackPlan({ ...base, mergeSha: null })?.action, 'suggest')
})

test('suggest mode asks rather than acts', () => {
  assert.equal(rollbackPlan({ ...base, mode: 'suggest' })?.action, 'suggest')
})

test('off means off', () => {
  assert.equal(rollbackPlan({ ...base, mode: 'off' }), null)
})

test('a blind verifier never triggers a rollback', () => {
  // An `error` verdict means shipshape could not see the containers. Undoing a deploy
  // on that basis is acting on ignorance, and is the one thing worse than not acting.
  const blind: Verdict = { kind: 'error', detail: 'could not read container state' }
  assert.equal(rollbackPlan({ ...base, verdict: blind }), null)
})

test('a passing or merely degraded deploy is left alone', () => {
  assert.equal(rollbackPlan({ ...base, verdict: { kind: 'passed', detail: 'ok' } }), null)
  assert.equal(
    rollbackPlan({ ...base, verdict: { kind: 'degraded', findings: [], detail: 'slow' } }),
    null,
  )
})

test('a true merge commit needs its mainline named', () => {
  assert.deepEqual(revertCommand('abc', 'merge'), ['revert', '--no-edit', '-m', '1', 'abc'])
  assert.deepEqual(revertCommand('abc', 'squash'), ['revert', '--no-edit', 'abc'])
})

test('rollback defaults to acting, and the key exists to turn it down', () => {
  assert.equal(PolicySchema.parse({}).deploy.rollback, 'auto')
  assert.equal(PolicySchema.parse({ deploy: { rollback: 'suggest' } }).deploy.rollback, 'suggest')
})

// ---------------------------------------------------------------- the tombstone

function update(state: string, toTag: string, detail: string | null = null): number {
  const now = new Date().toISOString()
  const info = getDb()
    .prepare(
      `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state,
                            detail, detected_at, updated_at)
       VALUES ('demo','svc','app:1.0','1.0',?,'minor','auto',?,?,?,?)`,
    )
    .run(toTag, state, detail, now, now)
  return Number(info.lastInsertRowid)
}

beforeEach(() => getDb().exec(`DELETE FROM updates;`))

test('a rolled-back version is remembered as failed', () => {
  update('failed', '2.0', 'crash loop')
  const dead = failedTarget('demo', 'svc', '1.0', '2.0')
  assert.ok(dead)
  assert.equal(dead!.detail, 'crash loop')
})

test('a newer version is not blocked by the failed one', () => {
  // The memory is per-target, not per-service: the point is to stop repeating one
  // specific broken upgrade, not to stop upgrading the service ever again.
  update('failed', '2.0')
  assert.equal(failedTarget('demo', 'svc', '1.0', '2.1'), null)
})

test('a live update is not mistaken for a tombstone', () => {
  update('detected', '2.0')
  assert.equal(failedTarget('demo', 'svc', '1.0', '2.0'), null)
})

test('the tombstone is scoped to its own service', () => {
  update('failed', '2.0')
  assert.equal(failedTarget('demo', 'other', '1.0', '2.0'), null)
})
