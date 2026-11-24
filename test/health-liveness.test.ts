import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The healthcheck's answer: alive, or 503 when the database or the main loop is stuck. */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-health-'))
process.env.DATA_DIR = dir
delete process.env.REPO_DIR

const { health } = await import('../src/health/liveness.ts')
const { version } = await import('../src/web/version.ts')
const { getDb } = await import('../src/db.ts')

after(() => rmSync(dir, { recursive: true, force: true }))

test('health answers ok and the version', () => {
  assert.deepEqual(health(), { status: 200, body: { ok: true, version: version() } })
})

test('health is 503 when the database cannot be read', () => {
  assert.deepEqual(health({ dbOk: () => false, stalled: () => false }), {
    status: 503,
    body: { ok: false, version: version() },
  })
})

test('health is 503 when the loop has stalled, and Activity says so', () => {
  const r = health({ dbOk: () => true, stalled: () => true })
  assert.equal(r.status, 503)
  const ev = getDb().prepare(`SELECT level FROM events WHERE message = 'main loop stalled'`).get() as { level: string }
  assert.equal(ev.level, 'error')
})

test('health says nothing about why', () => {
  const r = health({ dbOk: () => false, stalled: () => true })
  assert.deepEqual(Object.keys(r.body).sort(), ['ok', 'version'])
})
