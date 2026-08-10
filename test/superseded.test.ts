import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'shipshape-test-'))

const { getDb } = await import('../src/db.ts')
const { supersededPrs, successorFor } = await import('../src/gitops/pr.ts')
const { PolicySchema } = await import('../src/config.ts')
const { SETTINGS } = await import('../src/settings.ts')
const { decide } = await import('../src/gitops/automerge.ts')

/**
 * Retiring pull requests whose target was overtaken.
 *
 * The failure this prevents is not cosmetic. A superseded pull request rewrites the same
 * `image:` line as its successor from the same base, so exactly one can ever merge -- and
 * until the state filter went in, the superseded row still supplied the tier and verdict
 * that would have justified merging the wrong one.
 */

function reset(): void {
  getDb().exec(`DELETE FROM prs; DELETE FROM updates; DELETE FROM pr_updates; DELETE FROM events;`)
}

let seq = 0
function update(state: string, toTag: string, opts: { service?: string; magnitude?: string } = {}): number {
  const now = new Date().toISOString()
  const info = getDb()
    .prepare(
      `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state,
                            detected_at, updated_at)
       VALUES ('demo', ?, 'nginx:1.0.0', '1.0.0', ?, ?, 'auto', ?, ?, ?)`,
    )
    .run(opts.service ?? 'svc', toTag, opts.magnitude ?? 'minor', state, now, now)
  return Number(info.lastInsertRowid)
}

function pr(number: number, updateIds: number[], userOwned = 0): number {
  const info = getDb()
    .prepare(
      `INSERT INTO prs (number, branch, head_sha_pushed, state, user_owned, created_at)
       VALUES (?, ?, 'sha', 'open', ?, datetime('now'))`,
    )
    .run(number, `shipshape/demo--svc--${number}-${seq++}`, userOwned)
  const id = Number(info.lastInsertRowid)
  for (const u of updateIds) {
    getDb().prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`).run(id, u)
  }
  return id
}

beforeEach(reset)

test('a pull request whose every update is superseded is retired', () => {
  pr(1, [update('superseded', '1.1.0')])
  assert.deepEqual(
    supersededPrs().map((p) => p.number),
    [1],
  )
})

test('a live pull request is left alone', () => {
  pr(2, [update('pr_open', '1.1.0')])
  assert.deepEqual(supersededPrs(), [])
})

test('a partially superseded group is left alone', () => {
  // Two services bumped together, then one moved on. Closing would discard the member
  // that is still current, so this waits for a person instead.
  pr(3, [update('superseded', '1.1.0'), update('pr_open', '1.1.0', { service: 'svc2' })])
  assert.deepEqual(supersededPrs(), [])
})

test('a pull request with no updates at all is never swept', () => {
  // NOT EXISTS over an empty set is vacuously true, so without its own guard this row
  // would look fully superseded and be closed.
  pr(4, [])
  assert.deepEqual(supersededPrs(), [])
})

test('a branch someone has pushed to is still reported, so it can be told rather than closed', () => {
  // Selection includes it deliberately; the caller branches on user_owned and only
  // comments. Their commits are not ours to discard.
  pr(5, [update('superseded', '1.1.0')], 1)
  assert.deepEqual(
    supersededPrs().map((p) => [p.number, p.user_owned]),
    [[5, 1]],
  )
})

test('the successor is the newest live update for the same service, with its pull request', () => {
  const dead = pr(6, [update('superseded', '1.1.0')])
  const live = update('pr_open', '1.2.0')
  pr(7, [live])
  assert.deepEqual(successorFor(dead), { toTag: '1.2.0', number: 7 })
})

test('a successor with no pull request yet still names its version', () => {
  const dead = pr(8, [update('superseded', '1.1.0')])
  update('detected', '1.2.0')
  assert.deepEqual(successorFor(dead), { toTag: '1.2.0', number: null })
})

test('a superseded update can no longer justify a merge', async () => {
  // The sharp end: decide() used to join pr_updates -> updates with no state filter, so
  // an overtaken row still supplied magnitude, tier and verdict.
  const id = pr(9, [update('superseded', '1.1.0')])
  const d = await decide(id, 9)
  assert.equal(d.merge, false)
})

test('the setting exists, defaults to on, and is a switch in the Pull requests section', () => {
  assert.equal(PolicySchema.parse({}).prs.close_superseded, true)
  assert.equal(PolicySchema.parse({ prs: { close_superseded: false } }).prs.close_superseded, false)
  const def = SETTINGS.find((s) => s.path === 'prs.close_superseded')!
  assert.equal(def.kind, 'bool')
  assert.equal(def.section, 'Pull requests')
  assert.equal(def.defaultValue, 'true')
})
