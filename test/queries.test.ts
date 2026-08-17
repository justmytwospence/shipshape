import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The inbox's promise is that everything in it is waiting on a person. These are the
 * cases where that is easy to get wrong: an update the machine will handle tonight, one
 * that has already been acknowledged, and one whose second pull request carries the
 * merge commit its first one never had.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-queries-'))
process.env.DATA_DIR = dir
process.env.GITHUB_REPO = 'you/repo'
delete process.env.REPO_DIR

const { getDb } = await import('../src/db.ts')
const {
  inboxNeedsYou,
  inboxRecent,
  updateView,
  updateTimeline,
  listUpdates,
  updatesForService,
} = await import('../src/updates/queries.ts')

after(() => rmSync(dir, { recursive: true, force: true }))

const now = () => new Date().toISOString()
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()

// One update per (service, from, to) is a real constraint -- two rows for the same bump
// would be two answers to one question -- so each fixture gets its own version pair.
let seq = 0

function addUpdate(o: {
  service?: string
  state: string
  detail?: string | null
  tier?: string
  magnitude?: string
  acked?: string | null
  updatedAt?: string
  fromTag?: string
  toTag?: string
}): number {
  seq++
  const info = getDb()
    .prepare(
      `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state,
                            detail, detected_at, updated_at, acked_at)
       VALUES ('media', ?, 'img', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      o.service ?? 'svc',
      o.fromTag ?? `1.0.${seq}`,
      o.toTag ?? `1.1.${seq}`,
      o.magnitude ?? 'minor',
      o.tier ?? 'manual',
      o.state,
      o.detail ?? null,
      ago(48),
      o.updatedAt ?? now(),
      o.acked ?? null,
    )
  return Number(info.lastInsertRowid)
}

function addPr(updateId: number, o: { number: number; state?: string; sha?: string | null; scope?: string }): number {
  const db = getDb()
  const info = db
    .prepare(
      `INSERT INTO prs (number, branch, head_sha_pushed, state, scope, created_at, merged_at, merge_commit_sha)
       VALUES (?, ?, 'head', ?, ?, ?, ?, ?)`,
    )
    .run(
      o.number,
      `b${o.number}`,
      o.state ?? 'open',
      o.scope ?? 'tag-only',
      ago(20),
      o.state === 'merged' ? ago(2) : null,
      o.sha ?? null,
    )
  const prId = Number(info.lastInsertRowid)
  db.prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`).run(prId, updateId)
  return prId
}

function addDeploy(updateId: number, o: { status: string; prId?: number; finishedAt?: string | null }): number {
  const db = getDb()
  const info = db
    .prepare(
      `INSERT INTO deploys (pr_number, pr_id, stack, services, strategy, ok, healthy, status,
                            attempts, created_at, started_at, finished_at, trigger)
       VALUES (NULL, ?, 'media', 'svc', 'up', 0, 0, ?, 1, ?, ?, ?, 'queue')`,
    )
    .run(o.prId ?? null, o.status, ago(3), ago(3), o.finishedAt === undefined ? ago(2) : o.finishedAt)
  const id = Number(info.lastInsertRowid)
  db.prepare(`INSERT INTO deploy_updates (deploy_id, update_id) VALUES (?, ?)`).run(id, updateId)
  return id
}

beforeEach(() => {
  const db = getDb()
  for (const t of ['deploy_updates', 'deploys', 'pr_updates', 'prs', 'updates', 'images', 'verdicts']) {
    db.prepare(`DELETE FROM ${t}`).run()
  }
})

test('the inbox is only what is waiting on a person', () => {
  addUpdate({ service: 'waiting', state: 'pr_open' })
  addUpdate({ service: 'held', state: 'held' })
  addUpdate({ service: 'rolling', state: 'detected', detail: 'rolling' })
  const merged = addUpdate({ service: 'ready', state: 'merged' })
  addDeploy(merged, { status: 'ready', finishedAt: null })
  // Not waiting on anyone: finished, or gone.
  addUpdate({ service: 'done', state: 'verified' })
  addUpdate({ service: 'gone', state: 'superseded' })
  addUpdate({ service: 'skipped', state: 'skipped' })

  const kinds = inboxNeedsYou().map((i) => `${i.kind}:${i.update.service}`)
  assert.deepEqual(kinds.sort(), [
    'on-request:held',
    'pr-waiting:waiting',
    'ready-to-deploy:ready',
    'rolling-moved:rolling',
  ])
})

test('the worst thing comes first', () => {
  addUpdate({ service: 'waiting', state: 'pr_open' })
  const broken = addUpdate({ service: 'broken', state: 'merged' })
  addDeploy(broken, { status: 'failed' })
  addUpdate({ service: 'held', state: 'held' })

  const first = inboxNeedsYou()[0]!
  assert.equal(first.kind, 'deploy-failed')
  assert.equal(first.update.service, 'broken')
})

test('acknowledging a failure takes it out of the inbox without hiding the history', () => {
  const id = addUpdate({ service: 'broken', state: 'failed', detail: 'rolled back' })
  assert.equal(inboxNeedsYou().length, 1)

  getDb().prepare(`UPDATE updates SET acked_at = ? WHERE id = ?`).run(now(), id)
  assert.equal(inboxNeedsYou().length, 0, 'seen means seen')
  assert.equal(updateView(id)!.state, 'failed', 'but the update is unchanged')
})

test('a pull request whose review could not run says so, rather than looking merely unread', () => {
  const id = addUpdate({ state: 'pr_open', fromTag: '1.0.0', toTag: '1.1.0' })
  addPr(id, { number: 5 })
  getDb()
    .prepare(
      `INSERT INTO verdicts (image, from_tag, to_tag, error, created_at, attempts)
       VALUES ('img','1.0.0','1.1.0','404 fetching the changelog',?,3)`,
    )
    .run(now())

  const item = inboxNeedsYou()[0]!
  assert.equal(item.kind, 'review-failed')
  assert.equal(item.update.primary, 'rerun-review')
  assert.equal(item.update.verdict?.attempts, 3)
})

test('the newest pull request wins, so a second attempt does not lose the merge commit', () => {
  const id = addUpdate({ state: 'merged' })
  addPr(id, { number: 14, state: 'closed' })
  addPr(id, { number: 22, state: 'merged', sha: 'cafe123' })

  const v = updateView(id)!
  assert.equal(v.pr?.number, 22)
  assert.equal(v.pr?.mergeCommitSha, 'cafe123')
  assert.equal(v.pr?.url, 'https://github.com/you/repo/pull/22')
})

test('an update appears once even when it has two pull requests', () => {
  // The dashboard query joined on open pull requests and duplicated the row.
  const id = addUpdate({ state: 'pr_open' })
  addPr(id, { number: 14 })
  addPr(id, { number: 22 })
  assert.equal(listUpdates({ stage: 'open' }).filter((u) => u.id === id).length, 1)
})

test('the timeline tells the whole story, including what has not happened yet', () => {
  const id = addUpdate({ state: 'deployed', fromTag: '1.0.0', toTag: '1.1.0' })
  const prId = addPr(id, { number: 9, state: 'merged', sha: 'abc' })
  const db = getDb()
  db.prepare(
    `INSERT INTO verdicts (image, from_tag, to_tag, recommendation, confidence, summary, created_at)
     VALUES ('img','1.0.0','1.1.0','caution','medium','read the release notes',?)`,
  ).run(ago(19))
  const dep = addDeploy(id, { status: 'deployed', prId, finishedAt: ago(1) })
  db.prepare(`UPDATE deploys SET recheck_at = ? WHERE id = ?`).run(
    new Date(Date.now() + 1800_000).toISOString(),
    dep,
  )

  const kinds = updateTimeline(id).map((m) => m.kind)
  assert.deepEqual(kinds, ['detected', 'pr', 'review', 'merged', 'deploying', 'deployed', 'verified'])
  const future = updateTimeline(id).at(-1)!
  assert.equal(future.future, true, 'the soak is shown before it finishes')
  assert.match(updateTimeline(id)[2]!.label, /caution at medium confidence/)
})

test('recent activity spans the merge, the deploy and the dismissal', () => {
  const merged = addUpdate({ service: 'a', state: 'verified' })
  addPr(merged, { number: 3, state: 'merged' })
  addDeploy(merged, { status: 'verified' })
  addUpdate({ service: 'b', state: 'skipped', detail: 'dismissed', updatedAt: ago(1) })

  const kinds = inboxRecent(24).map((r) => r.kind)
  assert.ok(kinds.includes('merged'))
  assert.ok(kinds.includes('verified'))
  assert.ok(kinds.includes('skipped'))
  // Ordered newest first so the page reads as a feed.
  const times = inboxRecent(24).map((r) => r.at)
  assert.deepEqual([...times].sort().reverse(), times)
})

test('a service page shows its whole history, not just what is live', () => {
  addUpdate({ service: 'jelly', state: 'verified', updatedAt: ago(50) })
  addUpdate({ service: 'jelly', state: 'pr_open' })
  addUpdate({ service: 'other', state: 'pr_open' })

  const rows = updatesForService('media', 'jelly')
  assert.equal(rows.length, 2)
  assert.ok(rows.every((r) => r.service === 'jelly'))
})
