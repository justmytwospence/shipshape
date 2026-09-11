import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A merged update that a later merge has overtaken is retired, not left asking.
 *
 * #79 (minuspod -> 2.96.15) failed to deploy; #93 (2.96.15 -> 2.96.17) merged on top of
 * it. #79 could never deploy on its own after that, and still read `merged` with a Retry
 * button until someone pressed it.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-overtaken-'))
process.env.DATA_DIR = dir
delete process.env.REPO_DIR

const { getDb } = await import('../src/db.ts')
const { retireOvertaken } = await import('../src/updates/overtaken.ts')
const { reconcile, render, outcomesFor } = await import('../src/notify/digest.ts')
const { actionsFor } = await import('../src/updates/actions.ts')

after(() => rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  const db = getDb()
  for (const t of ['deploy_updates', 'deploys', 'pr_updates', 'prs', 'updates']) db.prepare(`DELETE FROM ${t}`).run()
})

const at = (m: number) => new Date(Date.UTC(2026, 8, 10, 9, m)).toISOString()

function update(o: { service?: string; from: string; to: string; state?: string }): number {
  return Number(
    getDb()
      .prepare(
        `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state, detail, detected_at, updated_at)
         VALUES ('minuspod', ?, 'ttlequals0/minuspod', ?, ?, 'minor', 'auto', ?, NULL, ?, ?)`,
      )
      .run(o.service ?? 'minuspod', o.from, o.to, o.state ?? 'merged', at(0), at(0)).lastInsertRowid,
  )
}

function pr(number: number, updateId: number, o: { state?: string; mergedAt?: string | null } = {}): number {
  const db = getDb()
  const id = Number(
    db
      .prepare(
        `INSERT INTO prs (number, branch, head_sha_pushed, state, scope, created_at, merged_at)
         VALUES (?, ?, 'sha', ?, 'tag-only', ?, ?)`,
      )
      .run(number, `b${number}`, o.state ?? 'merged', at(0), o.mergedAt === undefined ? at(number % 60) : o.mergedAt)
      .lastInsertRowid,
  )
  db.prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`).run(id, updateId)
  return id
}

function deploy(prId: number, number: number, updateId: number, status: string): void {
  const db = getDb()
  const id = Number(
    db
      .prepare(
        `INSERT INTO deploys (pr_number, pr_id, stack, services, strategy, ok, healthy, status, attempts, created_at)
         VALUES (?, ?, 'minuspod', 'minuspod', 'up', 0, 0, ?, 1, ?)`,
      )
      .run(number, prId, status, at(0)).lastInsertRowid,
  )
  db.prepare(`INSERT INTO deploy_updates (deploy_id, update_id) VALUES (?, ?)`).run(id, updateId)
}

const stateOf = (id: number) =>
  getDb().prepare(`SELECT state, detail FROM updates WHERE id = ?`).get(id) as { state: string; detail: string | null }

test('an earlier merge is retired by a later one for the same service', () => {
  const u79 = update({ from: '2.87.0-cpu', to: '2.96.15-cpu' })
  deploy(pr(79, u79, { mergedAt: at(6) }), 79, u79, 'failed')
  const u93 = update({ from: '2.96.15-cpu', to: '2.96.17-cpu' })
  pr(93, u93, { mergedAt: at(30) })

  const retired = retireOvertaken()
  assert.deepEqual(retired.map((r) => [r.prNumber, r.byPrNumber]), [[79, 93]])
  assert.deepEqual(stateOf(u79), { state: 'superseded', detail: 'overtaken by #93' })
  assert.equal(stateOf(u93).state, 'merged', 'the one that overtook is untouched')
  assert.deepEqual(retireOvertaken(), [], 'and running it again changes nothing')
})

test('once retired it offers nothing to press', () => {
  const u79 = update({ from: 'a', to: 'b' })
  pr(79, u79, { mergedAt: at(6) })
  pr(93, update({ from: 'b', to: 'c' }), { mergedAt: at(30) })
  retireOvertaken()
  assert.deepEqual(actionsFor({ state: stateOf(u79).state as never, prNumber: 79, deployStatus: 'failed' }), [])
})

test('an update whose own deploy is queued or running keeps its own outcome', () => {
  for (const status of ['pending', 'running']) {
    getDb().exec(`DELETE FROM deploy_updates; DELETE FROM deploys; DELETE FROM pr_updates; DELETE FROM prs; DELETE FROM updates;`)
    const older = update({ from: 'a', to: 'b' })
    deploy(pr(79, older, { mergedAt: at(6) }), 79, older, status)
    pr(93, update({ from: 'b', to: 'c' }), { mergedAt: at(30) })
    assert.deepEqual(retireOvertaken(), [], status)
    assert.equal(stateOf(older).state, 'merged')
  }
})

test('a later update that was rolled back or dismissed has overtaken nothing', () => {
  // A rollback puts the file back where the later update started -- where this one ended.
  for (const state of ['failed', 'skipped', 'superseded']) {
    getDb().exec(`DELETE FROM pr_updates; DELETE FROM prs; DELETE FROM updates;`)
    const older = update({ from: 'a', to: 'b' })
    pr(79, older, { mergedAt: at(6) })
    pr(93, update({ from: 'b', to: 'c', state }), { mergedAt: at(30) })
    assert.deepEqual(retireOvertaken(), [], state)
  }
})

test('a merge for a different service overtakes nothing', () => {
  const minuspod = update({ from: 'a', to: 'b' })
  pr(79, minuspod, { mergedAt: at(6) })
  pr(93, update({ service: 'minuspod-whisper', from: 'x', to: 'y' }), { mergedAt: at(30) })
  assert.deepEqual(retireOvertaken(), [])
  assert.equal(stateOf(minuspod).state, 'merged')
})

test('the newest merge is never the one retired', () => {
  const newer = update({ from: 'b', to: 'c' })
  pr(93, newer, { mergedAt: at(30) })
  const older = update({ from: 'a', to: 'b' })
  pr(79, older, { mergedAt: at(6) })
  retireOvertaken()
  assert.equal(stateOf(newer).state, 'merged')
  assert.equal(stateOf(older).state, 'superseded')
})

test('an update is dated and named by the pull request that merged, not one that closed', () => {
  // grafana's update 9 is linked to #15, closed unmerged, and to #23, which merged. The
  // closed link must neither hide the merge time nor be named as the carrier.
  const u = update({ from: '12.4', to: '13.0' })
  pr(15, u, { state: 'closed', mergedAt: null })
  pr(23, u, { mergedAt: at(20) })
  pr(40, update({ from: '13.0', to: '13.1' }), { mergedAt: at(30) })

  assert.deepEqual(retireOvertaken().map((r) => [r.prNumber, r.byPrNumber]), [[23, 40]])
})

test('no merge time means no evidence of order, so nothing is retired', () => {
  const u = update({ from: 'a', to: 'b' })
  pr(79, u, { mergedAt: null })
  pr(93, update({ from: 'b', to: 'c' }), { mergedAt: at(30) })
  assert.deepEqual(retireOvertaken(), [])
})

test('the digest calls an overtaken pull request overtaken, not a failure', () => {
  const url = (n: number) => `https://github.com/you/repo/pull/${n}`
  const batch = [{ id: 1, at: at(0), category: 'opened' as const, stack: 'minuspod', service: 'minuspod', summary: 'a -> b (#79)', detail: null, url: url(79) }]
  const m = render(
    reconcile(batch, new Map([[79, { merged: true, superseded: true, deploy: { status: 'failed', detail: 'compose failed' } }]])),
  )!
  assert.equal(m.title, 'shipshape: #79 merged, overtaken by a later update')
})

test('outcomes know a pull request whose updates were all overtaken', () => {
  const u79 = update({ from: 'a', to: 'b' })
  deploy(pr(79, u79, { mergedAt: at(6) }), 79, u79, 'failed')
  pr(93, update({ from: 'b', to: 'c' }), { mergedAt: at(30) })
  retireOvertaken()

  const row = (n: number) => ({ id: n, at: at(0), category: 'opened' as const, stack: null, service: null, summary: '', detail: null, url: `https://github.com/you/repo/pull/${n}` })
  const o = outcomesFor([row(79), row(93)])
  assert.equal(o.get(79)!.superseded, true)
  assert.equal(o.get(93)!.superseded, false)
})
