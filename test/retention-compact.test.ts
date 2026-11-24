import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

/** A database made before incremental auto-vacuum is converted on the first start, once. */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-compact-'))
process.env.DATA_DIR = dir
delete process.env.REPO_DIR

const { paths } = await import('../src/env.ts')
const { getDb } = await import('../src/db/index.ts')
const { compactOnce } = await import('../src/db/retention.ts')

after(() => rmSync(dir, { recursive: true, force: true }))

test('an old database is compacted once', () => {
  mkdirSync(join(paths.db, '..'), { recursive: true })
  const old = new Database(paths.db)
  // Existing and not incremental, with no schema yet: getDb builds the baseline into it.
  old.exec(`CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`)
  old.close()

  assert.equal(getDb().pragma('auto_vacuum', { simple: true }), 0)
  const first = compactOnce()
  assert.equal(first.compacted, true)
  assert.equal(getDb().pragma('auto_vacuum', { simple: true }), 2)
  assert.equal(compactOnce().compacted, false)
  const said = getDb().prepare(`SELECT message FROM events WHERE kind = 'system' ORDER BY id`).all() as {
    message: string
  }[]
  assert.ok(said.some((e) => e.message === 'database compacted'))
})
