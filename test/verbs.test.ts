import { test, beforeEach, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The verbs against a real database: what each one leaves behind, and -- more
 * importantly -- what a stale page cannot make happen.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-verbs-'))
process.env.DATA_DIR = dir
delete process.env.REPO_DIR

const { getDb } = await import('../src/db.ts')
const { contextFor, runVerb } = await import('../src/updates/verbs.ts')
const { actionsFor } = await import('../src/updates/actions.ts')

after(() => rmSync(dir, { recursive: true, force: true }))

const now = () => new Date().toISOString()

function seedUpdate(o: Partial<{ state: string; detail: string | null; toTag: string }> = {}): number {
  const db = getDb()
  const info = db
    .prepare(
      `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state,
                            detail, detected_at, updated_at)
       VALUES ('media','jellyfin','jellyfin/jellyfin','10.9.11',?,'minor','manual',?,?,?,?)`,
    )
    .run(o.toTag ?? '10.10.3', o.state ?? 'pr_open', o.detail ?? null, now(), now())
  return Number(info.lastInsertRowid)
}

function seedImage(currentTag = '10.9.11'): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO images (stack, service, compose_file, image_ref, registry,
             repository, current_tag, watched, last_seen_at)
       VALUES ('media','jellyfin','media/docker-compose.yaml','jellyfin/jellyfin:${currentTag}',
               'docker.io','jellyfin/jellyfin',?,1,?)`,
    )
    .run(currentTag, now())
}

beforeEach(() => {
  const db = getDb()
  for (const t of ['deploy_updates', 'deploys', 'pr_updates', 'prs', 'updates', 'images', 'verdicts']) {
    db.prepare(`DELETE FROM ${t}`).run()
  }
})

test('a verb the state does not offer is refused with a reason, not an exception', async () => {
  const id = seedUpdate({ state: 'pr_open' })
  const r = await runVerb(id, 'deploy')
  assert.equal(r.ok, false)
  assert.match(r.message, /nothing is waiting to be deployed/)
  // And nothing was written.
  assert.equal(getDb().prepare(`SELECT COUNT(*) c FROM deploys`).get<{ c: number }>().c, 0)
})

test('a verb on an update that has been deleted says so', async () => {
  const r = await runVerb(9999, 'deploy')
  assert.equal(r.ok, false)
  assert.match(r.message, /no longer exists/)
})

test('acknowledging a rolled-back update stops it asking again', async () => {
  const id = seedUpdate({ state: 'failed', detail: 'rolled back' })
  seedImage('10.9.11')
  assert.ok(actionsFor(contextFor(id)!.ctx).includes('ack'))

  const r = await runVerb(id, 'ack')
  assert.equal(r.ok, true)
  assert.ok(contextFor(id)!.ctx.ackedAt, 'the acknowledgement is recorded')
  assert.ok(!actionsFor(contextFor(id)!.ctx).includes('ack'), 'and not offered twice')
})

test('trying a rolled-back update again puts it back at the start of the pipeline', async () => {
  const id = seedUpdate({ state: 'failed', detail: 'rolled back' })
  seedImage('10.9.11') // the revert put the old tag back, so re-landing is honest

  const r = await runVerb(id, 'retry')
  assert.equal(r.ok, true, r.message)
  const after = contextFor(id)!
  assert.equal(after.row.state, 'detected')
  assert.equal(after.row.detail, 'retry')
  assert.equal(after.row.acked_at, null, 'a fresh attempt is not pre-acknowledged')
})

test('trying again is refused while the change is still in the tree', async () => {
  const id = seedUpdate({ state: 'failed' })
  seedImage('10.10.3') // never reverted: the file is on the new version already

  const r = await runVerb(id, 'retry')
  assert.equal(r.ok, false)
  assert.match(r.message, /still in the tree/)
  assert.equal(contextFor(id)!.row.state, 'failed', 'and the tombstone stands')
})

test('a dismissed update can be asked for again', async () => {
  const id = seedUpdate({ state: 'skipped', detail: 'dismissed' })
  seedImage('10.9.11')
  const r = await runVerb(id, 'retry')
  assert.equal(r.ok, true, r.message)
  assert.equal(contextFor(id)!.row.state, 'detected')
})

test('rolling back needs the commit that landed it', async () => {
  const db = getDb()
  const id = seedUpdate({ state: 'verified' })
  const prInfo = db
    .prepare(
      `INSERT INTO prs (number, branch, head_sha_pushed, state, scope, created_at)
       VALUES (77,'b','sha','merged','tag-only',?)`,
    )
    .run(now())
  db.prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`).run(
    Number(prInfo.lastInsertRowid),
    id,
  )
  // No merge_commit_sha yet: there is nothing to revert, so the verb is not on offer.
  assert.ok(!actionsFor(contextFor(id)!.ctx).includes('rollback'))
  const refused = await runVerb(id, 'rollback')
  assert.equal(refused.ok, false)
  assert.match(refused.message, /nothing to revert/)

  db.prepare(`UPDATE prs SET merge_commit_sha = 'abc1234' WHERE id = ?`).run(
    Number(prInfo.lastInsertRowid),
  )
  assert.ok(actionsFor(contextFor(id)!.ctx).includes('rollback'), 'and offered once it is known')
})

test('the context follows the newest pull request, not an open one', async () => {
  // An update that has been through two attempts has two pull requests. Joining on
  // `state = open` returns neither once both are closed, which is how a merged update
  // loses the merge commit it would need to roll back.
  const db = getDb()
  const id = seedUpdate({ state: 'merged' })
  for (const [n, state, sha] of [
    [14, 'closed', null],
    [22, 'merged', 'deadbee'],
  ] as const) {
    const info = db
      .prepare(
        `INSERT INTO prs (number, branch, head_sha_pushed, state, scope, created_at, merge_commit_sha)
         VALUES (?,?,'sha',?,'tag-only',?,?)`,
      )
      .run(n, `b${n}`, state, now(), sha)
    db.prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`).run(
      Number(info.lastInsertRowid),
      id,
    )
  }
  const ctx = contextFor(id)!.ctx
  assert.equal(ctx.prNumber, 22)
  assert.equal(ctx.mergeCommitSha, 'deadbee')
})

test('deploying is refused when the queued job has already been claimed', async () => {
  const db = getDb()
  const id = seedUpdate({ state: 'merged' })
  const info = db
    .prepare(
      `INSERT INTO deploys (pr_number, stack, services, strategy, ok, healthy, status,
                            attempts, created_at, trigger)
       VALUES (41,'media','jellyfin','up',0,0,'running',1,?,'queue')`,
    )
    .run(now())
  db.prepare(`INSERT INTO deploy_updates (deploy_id, update_id) VALUES (?, ?)`).run(
    Number(info.lastInsertRowid),
    id,
  )
  const r = await runVerb(id, 'deploy')
  assert.equal(r.ok, false)
  assert.match(r.message, /already running or finished/)
})
