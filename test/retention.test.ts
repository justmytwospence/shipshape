import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Retention: what nothing reads is removed after a scan, and an old database is compacted once. */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-retention-'))
process.env.DATA_DIR = dir
delete process.env.REPO_DIR

const { getDb } = await import('../src/db.ts')
const { prune, compactOnce } = await import('../src/db/retention.ts')

after(() => rmSync(dir, { recursive: true, force: true }))

const NOW = Date.parse('2026-11-21T00:00:00Z')
const ago = (days: number) => new Date(NOW - days * 864e5).toISOString()

beforeEach(() => {
  getDb().exec(`DELETE FROM http_cache; DELETE FROM tags_seen; DELETE FROM images; DELETE FROM events; DELETE FROM restore_points;`)
})

const cache = (url: string, etag: string | null, at: string) =>
  getDb().prepare(`INSERT INTO http_cache (url, etag, body, fetched_at) VALUES (?, ?, '{}', ?)`).run(url, etag, at)
const urls = () => (getDb().prepare(`SELECT url FROM http_cache ORDER BY url`).all() as { url: string }[]).map((r) => r.url)

test('cache rows not fetched in 30 days go, external links stay', () => {
  cache('github:/repos/o/old', '"e"', ago(40))
  cache('github:/repos/o/new', '"e"', ago(2))
  cache('external:https://example.org/notes', '"e"', ago(400))
  assert.equal(prune(NOW).cache, 1)
  assert.deepEqual(urls(), ['external:https://example.org/notes', 'github:/repos/o/new'])
})

test('registry pages cached without an ETag go', () => {
  cache('https://registry-1.docker.io/v2/x/tags/list', null, ago(1))
  cache('https://ghcr.io/v2/y/tags/list', '"e"', ago(1))
  cache('github:/repos/o/r', null, ago(1))
  prune(NOW)
  assert.deepEqual(urls(), ['github:/repos/o/r', 'https://ghcr.io/v2/y/tags/list'])
})

test('tags of repositories nothing runs are forgotten; watched ones stay', () => {
  const db = getDb()
  db.prepare(
    `INSERT INTO images (stack, service, compose_file, image_ref, registry, repository, last_seen_at)
     VALUES ('a', 'app', 'a/docker-compose.yaml', 'ghcr.io/o/app:1', 'ghcr.io', 'o/app', ?)`,
  ).run(ago(0))
  const tag = db.prepare(
    `INSERT INTO tags_seen (registry, repository, tag, first_seen_at) VALUES (?, ?, ?, ?)`,
  )
  tag.run('ghcr.io', 'o/app', '1', ago(1))
  tag.run('ghcr.io', 'o/gone', '1', ago(1))
  assert.equal(prune(NOW).tags, 1)
  const left = db.prepare(`SELECT repository FROM tags_seen`).all() as { repository: string }[]
  assert.deepEqual(left, [{ repository: 'o/app' }])
})

test('info events older than 90 days go; warnings and errors stay', () => {
  const ev = getDb().prepare(`INSERT INTO events (at, level, kind, message, last_at) VALUES (?, ?, 'scan', ?, ?)`)
  ev.run(ago(100), 'info', 'old info', null)
  ev.run(ago(100), 'info', 'old but seen lately', ago(3))
  ev.run(ago(100), 'warn', 'old warn', null)
  ev.run(ago(100), 'error', 'old error', null)
  ev.run(ago(5), 'info', 'new info', null)
  assert.equal(prune(NOW).events, 1)
  const left = (getDb().prepare(`SELECT message FROM events WHERE message NOT LIKE 'database%' ORDER BY id`).all() as { message: string }[]).map((r) => r.message)
  assert.deepEqual(left, ['old but seen lately', 'old warn', 'old error', 'new info'])
})

test('restore points whose file is gone are forgotten; offsite ones stay', () => {
  const kept = join(dir, 'kept.tar.zst')
  writeFileSync(kept, 'x')
  const rp = getDb().prepare(
    `INSERT INTO restore_points (stack, service, path, bytes, created_at) VALUES ('a', 'db', ?, 1, ?)`,
  )
  rp.run(kept, ago(1))
  rp.run(join(dir, 'deleted.tar.zst'), ago(1))
  rp.run('offsite:s3://bucket/x', ago(1))
  assert.equal(prune(NOW).restorePoints, 1)
  const left = (getDb().prepare(`SELECT path FROM restore_points ORDER BY id`).all() as { path: string }[]).map((r) => r.path)
  assert.deepEqual(left, [kept, 'offsite:s3://bucket/x'])
})

test('pruning that removes nothing says nothing', () => {
  prune(NOW)
  const n = getDb().prepare(`SELECT COUNT(*) c FROM events WHERE message = 'database pruned'`).get() as { c: number }
  assert.equal(n.c, 0)
})

test('a new database starts with incremental auto-vacuum', () => {
  assert.equal(getDb().pragma('auto_vacuum', { simple: true }), 2)
  assert.equal(compactOnce().compacted, false)
})
