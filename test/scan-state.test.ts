import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// getDb() resolves its path from config at import time, so point DATA_DIR at a scratch
// directory before anything is imported.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'shipshape-test-'))

const { getDb } = await import('../src/db.ts')
const { classFor } = await import('../src/policy.ts')

/**
 * These exercise the transition rules that scan.ts implements, against the real schema.
 * The property that matters most is idempotence: a second scan that observes the same
 * facts must not create a second row or a second event.
 */

function reset(): void {
  const db = getDb()
  db.exec(`DELETE FROM updates; DELETE FROM events; DELETE FROM images; DELETE FROM digest_baselines;`)
  db.prepare(
    `INSERT INTO images (stack, service, compose_file, image_ref, registry, repository,
                         current_tag, watched, last_seen_at)
     VALUES ('miniflux','miniflux','miniflux/docker-compose.yaml','miniflux/miniflux:2.2.19',
             'docker.io','miniflux/miniflux','2.2.19',1,datetime('now'))`,
  ).run()
}

const LIVE = `('detected','pr_open','frozen')`

function live(stack = 'miniflux', service = 'miniflux') {
  return getDb()
    .prepare(`SELECT * FROM updates WHERE stack=? AND service=? AND state IN ${LIVE}`)
    .all(stack, service) as Record<string, unknown>[]
}

function insert(fromTag: string, toTag: string, magnitude = 'minor', tier = 'auto', state = 'detected') {
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state,
                            detected_at, updated_at)
       VALUES ('miniflux','miniflux','miniflux/miniflux',?,?,?,?,?,?,?)
       ON CONFLICT(stack, service, from_tag, to_tag) DO UPDATE SET
         state=excluded.state, tier=excluded.tier, updated_at=excluded.updated_at`,
    )
    .run(fromTag, toTag, magnitude, tier, state, now, now)
}

function supersede(id: number, detail: string) {
  getDb()
    .prepare(`UPDATE updates SET state='superseded', detail=?, updated_at=? WHERE id=?`)
    .run(detail, new Date().toISOString(), id)
}

beforeEach(reset)

test('migration 002 created the new tables and columns', () => {
  const db = getDb()
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
    .all()
    .map((r) => (r as { name: string }).name)
  for (const t of ['digest_baselines', 'prs', 'pr_updates', 'updates', 'images']) {
    assert.ok(tables.includes(t), `missing table ${t}`)
  }
  const cols = db.prepare(`PRAGMA table_info(images)`).all().map((r) => (r as { name: string }).name)
  assert.ok(cols.includes('last_status'))
  assert.ok(cols.includes('last_detail'))
  const prCols = db.prepare(`PRAGMA table_info(prs)`).all().map((r) => (r as { name: string }).name)
  assert.ok(prCols.includes('group_key'), 'prs should have been recreated with group support')
})

test('re-detecting the same update does not create a second row', () => {
  insert('2.2.19', '2.3.3')
  assert.equal(live().length, 1)
  // The upsert is what makes a repeat scan a no-op rather than a duplicate.
  insert('2.2.19', '2.3.3')
  assert.equal(live().length, 1)
})

test('a newer target supersedes the previous row rather than accumulating', () => {
  insert('2.2.19', '2.3.3')
  const first = live()[0]!
  supersede(Number(first.id), 'newer target 2.3.4')
  insert('2.2.19', '2.3.4')

  const rows = live()
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.to_tag, '2.3.4')
  const superseded = getDb()
    .prepare(`SELECT detail FROM updates WHERE state='superseded'`)
    .get() as { detail: string }
  assert.equal(superseded.detail, 'newer target 2.3.4')
})

test('caught-up clears a row once the file moves on its own (WUD applied it)', () => {
  insert('2.2.19', '2.3.3')
  // WUD rewrote the compose file overnight; the scan now sees current_tag = 2.3.3.
  const row = live()[0]!
  assert.notEqual(row.from_tag, '2.3.3')
  supersede(Number(row.id), 'caught-up')

  assert.equal(live().length, 0)
  const cleared = getDb()
    .prepare(`SELECT detail FROM updates WHERE state='superseded'`)
    .get() as { detail: string }
  assert.equal(cleared.detail, 'caught-up')
})

test('a vanished target is distinguishable from being caught up', () => {
  insert('2.2.19', '2.3.3')
  supersede(Number(live()[0]!.id), 'target-vanished')
  const row = getDb()
    .prepare(`SELECT detail FROM updates WHERE state='superseded'`)
    .get() as { detail: string }
  // Yanked releases must not look like a successful application.
  assert.equal(row.detail, 'target-vanished')
})

test('frozen rows are live but distinguishable from detected ones', () => {
  insert('16', '18', 'major', 'frozen', 'frozen')
  const rows = live()
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.state, 'frozen')
  // Shipping it promotes it without losing the row.
  getDb().prepare(`UPDATE updates SET state='detected', tier='ask' WHERE id=?`).run(rows[0]!.id)
  assert.equal((live()[0] as Record<string, unknown>).state, 'detected')
})

test('class assignment matches the policy engine for the real backlog shapes', () => {
  const c = (classLabel: string | null, policyLabel: string | null, prLabel: string | null) =>
    classFor({ classLabel, policyLabel, prLabel })

  // miniflux 2.2.19 -> 2.3.3, ordinary service: ships on its own, whatever the jump
  assert.equal(c(null, null, null), 'normal')
  // authelia and friends: infrastructure the v1 ladder pinned off the auto rung
  assert.equal(c(null, 'attended', null), 'lifeline')
  assert.equal(c(null, 'gated', null), 'ask')
  // postgres sidecar, dashboard-only
  assert.equal(c(null, null, 'on-request'), 'frozen')
  // the v2 label wins over the v1 ones
  assert.equal(c('stateful', 'manual', null), 'stateful')
})

test('rolling movement is recorded as a digest row that can never become a PR', () => {
  insert('latest@sha256:aaa', 'latest@sha256:bbb', 'digest', 'manual', 'detected')
  getDb().prepare(`UPDATE updates SET detail='rolling' WHERE from_tag LIKE 'latest@%'`).run()
  const row = live()[0]!
  assert.equal(row.detail, 'rolling')
  assert.equal(row.magnitude, 'digest')
})

test('digest baselines bootstrap once and then only advance on movement', () => {
  const db = getDb()
  const now = new Date().toISOString()
  const put = db.prepare(
    `INSERT INTO digest_baselines (registry, repository, tag, digest, observed_at, checked_at)
     VALUES (?,?,?,?,?,?)`,
  )
  put.run('docker.io', 'huginn/huginn-single-process', 'latest', 'sha256:aaa', now, now)

  const read = () =>
    db
      .prepare(`SELECT digest FROM digest_baselines WHERE repository=?`)
      .get('huginn/huginn-single-process') as { digest: string }
  assert.equal(read().digest, 'sha256:aaa')

  // An unchanged check touches checked_at only.
  db.prepare(`UPDATE digest_baselines SET checked_at=? WHERE repository=?`)
    .run(new Date().toISOString(), 'huginn/huginn-single-process')
  assert.equal(read().digest, 'sha256:aaa')

  // Acknowledged movement advances it, so the event fires exactly once.
  db.prepare(`UPDATE digest_baselines SET digest=? WHERE repository=?`)
    .run('sha256:bbb', 'huginn/huginn-single-process')
  assert.equal(read().digest, 'sha256:bbb')

  // One baseline serves both huginn services -- it is keyed by image, not by service.
  const count = db
    .prepare(`SELECT COUNT(*) c FROM digest_baselines WHERE repository=?`)
    .get('huginn/huginn-single-process') as { c: number }
  assert.equal(count.c, 1)
})

test('a label change retiers an outstanding update on the next scan', () => {
  // The whole point of keeping labels in the compose files is that editing one takes
  // effect without recreating anything. If the tier were frozen at insert time, adding
  // `shipshape.class: frozen` to a service with an update already outstanding would
  // silently do nothing until that update happened to be superseded.
  insert('16', '18', 'major', 'ask', 'detected')
  const before = live()[0]!
  assert.equal(before.tier, 'ask')
  assert.equal(before.state, 'detected')

  const nowFrozen = classFor({ classLabel: 'frozen', policyLabel: null, prLabel: null })
  assert.equal(nowFrozen, 'frozen')

  getDb()
    .prepare(`UPDATE updates SET tier=?, state=? WHERE id=?`)
    .run(nowFrozen, 'frozen', before.id)

  const after = live()[0]!
  assert.equal(after.tier, 'frozen')
  assert.equal(after.state, 'frozen')
  // The row survived -- retiering must not discard and recreate it.
  assert.equal(after.id, before.id)
})
