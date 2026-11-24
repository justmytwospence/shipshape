import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

/**
 * Migration 034 removes v1: its tables, its columns and its states. On a fresh database it
 * acts on nothing; on one that still holds v1 rows it rewrites them rather than losing them.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-migrate-034-'))
process.env.DATA_DIR = dir
delete process.env.REPO_DIR

const { getDb, __migrationsForTest } = await import('../src/db/index.ts')

after(() => rmSync(dir, { recursive: true, force: true }))

type Db = InstanceType<typeof Database>
const cols = (d: Db, table: string) => (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
const tables = (d: Db) => (d.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name)

test('a fresh database migrates through 034 with v1 gone', () => {
  const d = getDb()
  for (const gone of ['prompts', 'model_tier_decisions', 'digest_items', 'digest_due', 'instructions']) {
    assert.ok(!tables(d).includes(gone), gone)
  }
  for (const gone of ['kind', 'user_owned', 'scope_sha', 'hold_reason', 'hold_at']) assert.ok(!cols(d, 'prs').includes(gone), `prs.${gone}`)
  assert.ok(cols(d, 'images').includes('review_label'))
  assert.ok(cols(d, 'images').includes('legacy_labels'))
  for (const gone of ['claude_label', 'policy_label', 'archive_pre']) assert.ok(!cols(d, 'images').includes(gone), `images.${gone}`)
  assert.ok(!cols(d, 'proposals').includes('instruction_id'))
  assert.ok(!cols(d, 'security_fixes').includes('commented'))
  assert.ok(d.prepare(`SELECT 1 FROM _migrations WHERE id = '034-drop-v1'`).get())
  assert.equal(d.prepare(`PRAGMA foreign_key_check`).all().length, 0)
})

test('034 rewrites what a v1 row left behind', () => {
  const d = new Database(join(dir, 'v1.db'))
  d.pragma('foreign_keys = ON')
  const at = __migrationsForTest.findIndex((m) => m.id === '034-drop-v1')
  assert.ok(at > 0)
  for (const m of __migrationsForTest.slice(0, at)) d.exec(m.sql)

  const now = '2026-01-01T00:00:00Z'
  const update = Number(
    d
      .prepare(
        `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state, detected_at, updated_at)
         VALUES ('media', 'jellyfin', 'jellyfin/jellyfin', '10.9.11', '10.10.3', 'minor', 'manual', 'pr_open', ?, ?)`,
      )
      .run(now, now).lastInsertRowid,
  )
  const pr = Number(
    d
      .prepare(
        `INSERT INTO prs (number, branch, head_sha_pushed, state, scope, kind, created_at)
         VALUES (41, 'shipshape/media--jellyfin', 'x', 'open', 'modified', 'github', ?)`,
      )
      .run(now).lastInsertRowid,
  )
  d.prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`).run(pr, update)
  const proposal = Number(
    d
      .prepare(
        `INSERT INTO proposals (pr_id, update_id, ops, notes, summary, changed, model, created_at, instruction_id)
         VALUES (?, ?, '[]', '[]', 'kept', '[]', 'm', ?, NULL)`,
      )
      .run(pr, update, now).lastInsertRowid,
  )
  const odd = Number(
    d
      .prepare(
        `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state, detected_at, updated_at)
         VALUES ('media', 'other', 'x/y', '1', '2', 'minor', 'model', 'merged', ?, ?)`,
      )
      .run(now, now).lastInsertRowid,
  )
  d.prepare(`INSERT INTO events (at, level, kind, message) VALUES (?, 'info', 'pr', 'opened #41')`).run(now)
  d.prepare(
    `INSERT INTO images (stack, service, compose_file, image_ref, registry, repository, policy_label, claude_label, last_seen_at)
     VALUES ('media', 'jellyfin', 'media/docker-compose.yaml', 'jellyfin/jellyfin:10.9.11', 'docker.io', 'jellyfin/jellyfin', 'manual', 'required', ?)`,
  ).run(now)

  d.exec(__migrationsForTest[at]!.sql)

  const u = d.prepare(`SELECT state, tier FROM updates WHERE id = ?`).get(update) as { state: string; tier: string }
  assert.deepEqual(u, { state: 'detected', tier: 'ask' })
  assert.equal((d.prepare(`SELECT tier FROM updates WHERE id = ?`).get(odd) as { tier: string }).tier, 'ask')
  const p = d.prepare(`SELECT state, scope FROM prs WHERE id = ?`).get(pr) as { state: string; scope: string }
  assert.deepEqual(p, { state: 'closed', scope: 'proposed' })
  assert.equal((d.prepare(`SELECT summary FROM proposals WHERE id = ?`).get(proposal) as { summary: string }).summary, 'kept')
  assert.equal((d.prepare(`SELECT kind FROM events`).get() as { kind: string }).kind, 'ship')
  const img = d.prepare(`SELECT legacy_labels, review_label FROM images`).get() as { legacy_labels: string; review_label: string }
  assert.deepEqual(img, { legacy_labels: 'shipshape.policy: manual', review_label: 'required' })
  assert.equal(d.prepare(`PRAGMA foreign_key_check`).all().length, 0)
  d.close()
})
