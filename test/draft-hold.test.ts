import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A drafted config change waits for a person to read it. An approval older than the draft
 * does not cover it; Ship pressed after it does.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-draft-hold-'))
process.env.DATA_DIR = join(dir, 'data')
process.env.POLICY_FILE = join(dir, 'policy.yaml')
writeFileSync(process.env.POLICY_FILE, 'paused: false\nship:\n  cooldown_days: 0\n')
after(() => rmSync(dir, { recursive: true, force: true }))

const { getDb } = await import('../src/db/index.ts')
const { holdsForUpdate } = await import('../src/updates/holds.ts')

const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-01-02T00:00:00.000Z'
const T2 = '2026-01-03T00:00:00.000Z'

beforeEach(() => {
  const db = getDb()
  for (const t of ['proposals', 'pr_updates', 'prs', 'updates', 'verdicts', 'images'])
    db.prepare(`DELETE FROM ${t}`).run()
})

function seed(o: { approvedAt?: string | null; scope?: 'proposed' | 'tag-only'; error?: string | null } = {}): number {
  const db = getDb()
  db.prepare(
    `INSERT INTO images (stack, service, compose_file, image_ref, registry, repository, current_tag, watched, last_seen_at)
     VALUES ('app', 'app', 'app/docker-compose.yaml', 'example/app:1.0.0', 'docker.io', 'example/app', '1.0.0', 1, 'now')`,
  ).run()
  const id = Number(
    db
      .prepare(
        `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state, detected_at, updated_at, approved_at)
         VALUES ('app', 'app', 'example/app:1.0.0', '1.0.0', '1.0.1', 'patch', 'normal', 'detected', ?, ?, ?)`,
      )
      .run(T0, T0, o.approvedAt ?? null).lastInsertRowid,
  )
  db.prepare(
    `INSERT INTO verdicts (image, from_tag, to_tag, recommendation, confidence, breaking_changes, migration_steps, sources, created_at)
     VALUES ('example/app:1.0.0', '1.0.0', '1.0.1', 'approve', 'high', '[]', '[]', '[]', ?)`,
  ).run(T0)
  const pr = Number(
    db
      .prepare(
        `INSERT INTO prs (number, branch, head_sha_pushed, state, group_key, scope, created_at)
         VALUES (0, 'shipshape/app', '', 'open', NULL, ?, ?)`,
      )
      .run(o.scope ?? 'proposed', T1).lastInsertRowid,
  )
  db.prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`).run(pr, id)
  db.prepare(
    `INSERT INTO proposals (pr_id, update_id, ops, notes, summary, sources, changed, model, error, hunks, created_at)
     VALUES (?, ?, '[]', '[]', NULL, '[]', '[]', 'm', ?, '[]', ?)`,
  ).run(pr, id, o.error ?? null, T1)
  return id
}

test('an open draft holds its update', () => {
  const h = holdsForUpdate(seed())!
  assert.deepEqual(
    h.holds.map((x) => x.kind),
    ['draft'],
  )
  assert.equal(h.status.status, 'decision')
})

test('an approval older than the draft does not ship it', () => {
  assert.equal(holdsForUpdate(seed({ approvedAt: T0 }))!.status.status, 'decision')
})

test('ship pressed after the draft lifts the hold', () => {
  assert.equal(holdsForUpdate(seed({ approvedAt: T2 }))!.status.status, 'ready')
})

test('a notes-only proposal holds nothing', () => {
  assert.deepEqual(holdsForUpdate(seed({ scope: 'tag-only' }))!.holds, [])
})

test('a failed draft holds nothing', () => {
  assert.deepEqual(holdsForUpdate(seed({ error: 'boom' }))!.holds, [])
})
