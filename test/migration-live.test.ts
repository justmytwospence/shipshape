import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The newest migrations against a copy of the real database, when there is one to hand.
 *
 * Skipped everywhere it cannot find one, so this is not a test anybody else's checkout
 * fails on -- but a schema change is exactly the thing a fresh-database test cannot
 * vouch for. `SHIPSHAPE_LIVE_DB` points at an *online backup* (`.backup`), never at the
 * live file: that one is WAL and a container is writing to it.
 */

const LIVE = process.env.SHIPSHAPE_LIVE_DB ?? ''
const have = !!LIVE && existsSync(LIVE)

let dir: string
let db: typeof import('../src/db/index.ts')

before(async () => {
  if (!have) return
  dir = mkdtempSync(join(tmpdir(), 'shipshape-live-'))
  copyFileSync(LIVE, join(dir, 'shipshape.db'))
  process.env.DATA_DIR = dir
  delete process.env.REPO_DIR
  db = await import('../src/db/index.ts')
})

after(() => {
  if (have && dir) rmSync(dir, { recursive: true, force: true })
})

test('v1 is gone from a database with real history in it', (t) => {
  if (!have) return t.skip('set SHIPSHAPE_LIVE_DB to an online backup to run this')
  const d = db.getDb()
  const cols = (table: string) =>
    (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
  const tables = (d.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name)

  for (const gone of ['prompts', 'model_tier_decisions', 'digest_items', 'digest_due', 'instructions']) {
    assert.ok(!tables.includes(gone), gone)
  }
  for (const gone of ['kind', 'user_owned', 'scope_sha', 'hold_reason', 'hold_at']) assert.ok(!cols('prs').includes(gone), `prs.${gone}`)
  assert.ok(cols('images').includes('review_label'))
  assert.ok(cols('images').includes('legacy_labels'))
  for (const gone of ['claude_label', 'policy_label', 'archive_pre']) assert.ok(!cols('images').includes(gone), `images.${gone}`)
  assert.ok(!cols('proposals').includes('instruction_id'))

  const count = (sql: string) => (d.prepare(sql).get() as { c: number }).c
  assert.equal(count(`SELECT COUNT(*) c FROM events WHERE kind = 'pr'`), 0)
  assert.equal(count(`SELECT COUNT(*) c FROM updates WHERE state = 'pr_open'`), 0)
  // The existing rows are still there and still readable -- a table rebuilt wrong would
  // show up here rather than at 3am.
  assert.ok(count(`SELECT COUNT(*) c FROM updates`) > 0, 'the copy should carry real history')
  assert.equal(d.prepare(`PRAGMA foreign_key_check`).all().length, 0)
  assert.equal((d.prepare(`PRAGMA integrity_check`).get() as { integrity_check: string }).integrity_check, 'ok')
})

test('the resolution cache learns when to look again', (t) => {
  if (!have) return t.skip('set SHIPSHAPE_LIVE_DB to an online backup to run this')
  const d = db.getDb()
  const cols = (d.prepare(`PRAGMA table_info(resolutions)`).all() as { name: string }[]).map((c) => c.name)
  for (const c of ['confidence', 'checked_at', 'next_check_at', 'attempts', 'error', 'resolver_version', 'evidence', 'packaging_repo']) {
    assert.ok(cols.includes(c), c)
  }
  // Every none written before this could not tell a failure from an absence, so every one
  // is due for another look -- none may be left permanent.
  const stuck = (d.prepare(`SELECT COUNT(*) c FROM resolutions WHERE tier = 'none' AND next_check_at IS NULL`).get() as { c: number }).c
  assert.equal(stuck, 0)
  const unmarked = (d.prepare(`SELECT COUNT(*) c FROM resolutions WHERE tier != 'none' AND confidence IS NULL`).get() as { c: number }).c
  assert.equal(unmarked, 0)
})

test('verdicts gain their evidence, and none from before is read again for lack of it', (t) => {
  if (!have) return t.skip('set SHIPSHAPE_LIVE_DB to an online backup to run this')
  const d = db.getDb()
  const cols = (d.prepare(`PRAGMA table_info(verdicts)`).all() as { name: string }[]).map((c) => c.name)
  assert.ok(cols.includes('evidence'))
  assert.ok((d.prepare(`SELECT COUNT(*) c FROM verdicts`).get() as { c: number }).c > 0, 'the copy should carry real verdicts')
  // A verdict with no evidence is not an incomplete one: deploying this must not re-offer
  // every review ever written for a second, paid reading.
  const flagged = (
    d.prepare(`SELECT COUNT(*) c FROM verdicts WHERE json_extract(evidence, '$.incomplete') = 1`).get() as { c: number }
  ).c
  assert.equal(flagged, 0)
})
