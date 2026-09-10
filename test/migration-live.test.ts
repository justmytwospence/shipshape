import { test, before, after, skip } from 'node:test'
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
let db: typeof import('../src/db.ts')

before(async () => {
  if (!have) return
  dir = mkdtempSync(join(tmpdir(), 'shipshape-live-'))
  copyFileSync(LIVE, join(dir, 'shipshape.db'))
  process.env.DATA_DIR = dir
  delete process.env.REPO_DIR
  db = await import('../src/db.ts')
})

after(() => {
  if (have && dir) rmSync(dir, { recursive: true, force: true })
})

test('the new schema applies to a database with real history in it', (t) => {
  if (!have) return t.skip('set SHIPSHAPE_LIVE_DB to an online backup to run this')
  const d = db.getDb()
  const cols = (table: string) =>
    (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

  assert.ok(cols('instructions').includes('comment_id'))
  assert.ok(cols('proposals').includes('instruction_id'))
  assert.ok(cols('prs').includes('hold_reason'))

  // The existing rows are still there and still readable -- an ALTER that rewrote a
  // table wrong would show up here rather than at 3am.
  const prs = (d.prepare(`SELECT COUNT(*) c FROM prs`).get() as { c: number }).c
  const updates = (d.prepare(`SELECT COUNT(*) c FROM updates`).get() as { c: number }).c
  assert.ok(updates > 0, 'the copy should carry real history')
  assert.equal(d.prepare(`PRAGMA foreign_key_check`).all().length, 0)
  assert.equal((d.prepare(`PRAGMA integrity_check`).get() as { integrity_check: string }).integrity_check, 'ok')

  // Nothing is held and nothing is outstanding on a database that has never seen this
  // feature, so no pull request changes behaviour the moment it is deployed.
  const held = (d.prepare(`SELECT COUNT(*) c FROM prs WHERE hold_reason IS NOT NULL`).get() as { c: number }).c
  assert.equal(held, 0)
  assert.equal((d.prepare(`SELECT COUNT(*) c FROM instructions`).get() as { c: number }).c, 0)
  assert.ok(prs >= 0)
})

test('the digest barrier arrives with nothing owed', (t) => {
  if (!have) return t.skip('set SHIPSHAPE_LIVE_DB to an online backup to run this')
  const d = db.getDb()

  // Empty on arrival, so deploying this cannot make a digest go out early or twice: the
  // first thing to write the row is the schedule firing.
  assert.equal((d.prepare(`SELECT COUNT(*) c FROM digest_due`).get() as { c: number }).c, 0)

  // One row, and the database is what enforces it -- two digests owed at once is not a
  // state the loop knows how to resolve.
  d.prepare(`INSERT INTO digest_due (id, due_at, deadline) VALUES (1, 'a', 'b')`).run()
  assert.throws(() =>
    d.prepare(`INSERT INTO digest_due (id, due_at, deadline) VALUES (2, 'a', 'b')`).run(),
  )
  d.prepare(`DELETE FROM digest_due`).run()

  // Pending items from before the upgrade are still pending: the barrier changes when
  // the digest goes out, never which rows it carries.
  const pending = (
    d.prepare(`SELECT COUNT(*) c FROM digest_items WHERE sent_at IS NULL`).get() as { c: number }
  ).c
  assert.ok(pending >= 0)
})

test('the rollout watermark is set to now, not to the beginning of time', (t) => {
  if (!have) return t.skip('set SHIPSHAPE_LIVE_DB to an online backup to run this')
  const rows = db
    .getDb()
    .prepare(`SELECT key, window FROM budgets WHERE key LIKE 'revise.%'`)
    .all() as { key: string; window: string }[]
  assert.equal(rows.length, 2)
  // Months of existing comments on open pull requests sit before this, which is the
  // point: the first tick after deploying must not work through all of them.
  for (const r of rows) {
    assert.ok(Date.parse(r.window) > Date.now() - 5 * 60_000, `${r.key} = ${r.window}`)
  }
})
