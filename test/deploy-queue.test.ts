import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'shipshape-test-'))

const { getDb } = await import('../src/db.ts')
const { enqueueDeploy, dueJobs, hasPendingDeploys, markUpdates } = await import(
  '../src/deploy/queue.ts'
)

/**
 * The queue exists for one guarantee: a merge that has been recorded cannot be forgotten.
 *
 * Before it, the pull request was marked merged and then deployed in the same breath,
 * with no try/catch on the path. Anything thrown in between -- a missing binary, a
 * socket permission, the container restarting -- left a merge nothing would ever act on
 * again, because `merged` had already removed it from the query that finds work.
 */

function reset(): void {
  getDb().exec(`DELETE FROM deploys; DELETE FROM prs; DELETE FROM updates; DELETE FROM pr_updates;`)
}

const target = (over: Partial<{ stack: string; services: string[]; strategy: 'up' | 'rm-first' }> = {}) => ({
  stack: 'jellyfin',
  services: ['jellyfin'],
  strategy: 'up' as const,
  ...over,
})

function pr(number: number): number {
  const info = getDb()
    .prepare(
      `INSERT INTO prs (number, branch, head_sha_pushed, state, created_at)
       VALUES (?, ?, 'sha', 'open', datetime('now'))`,
    )
    .run(number, `b${number}`)
  return Number(info.lastInsertRowid)
}

beforeEach(reset)

test('an enqueued deploy survives as pending work', () => {
  enqueueDeploy({ prId: pr(1), prNumber: 1, target: target(), now: new Date().toISOString() })
  const jobs = dueJobs()
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0]!.stack, 'jellyfin')
  assert.equal(jobs[0]!.attempts, 0)
  assert.ok(hasPendingDeploys())
})

test('the enqueue commits with the merge, or not at all', () => {
  // The guarantee in one assertion: if the surrounding transaction rolls back, no merge
  // was recorded either, so there is nothing to have lost.
  const db = getDb()
  const id = pr(2)
  assert.throws(() => {
    db.transaction(() => {
      db.prepare(`UPDATE prs SET state = 'merged' WHERE id = ?`).run(id)
      enqueueDeploy({ prId: id, prNumber: 2, target: target(), now: new Date().toISOString() })
      throw new Error('crash between merge and deploy')
    })()
  })
  assert.equal(dueJobs().length, 0)
  const state = db.prepare(`SELECT state FROM prs WHERE id = ?`).get(id) as { state: string }
  assert.notEqual(state.state, 'merged', 'the merge rolled back with the intent')
})

test('jobs drain oldest first', () => {
  enqueueDeploy({ prId: pr(3), prNumber: 3, target: target({ stack: 'a' }), now: '2026-01-01T00:00:00Z' })
  enqueueDeploy({ prId: pr(4), prNumber: 4, target: target({ stack: 'b' }), now: '2026-01-02T00:00:00Z' })
  assert.deepEqual(dueJobs().map((j) => j.stack), ['a', 'b'])
})

test('a tick takes a bounded slice, leaving the rest queued', () => {
  for (let i = 10; i < 16; i++) {
    enqueueDeploy({ prId: pr(i), prNumber: i, target: target(), now: `2026-01-0${i - 9}T00:00:00Z` })
  }
  assert.equal(dueJobs().length, 3, 'default cap')
  assert.equal(
    getDb().prepare(`SELECT COUNT(*) c FROM deploys WHERE status='pending'`).get().c,
    6,
    'the rest stay queued rather than being dropped',
  )
})

test('services are deduped into the queued row', () => {
  enqueueDeploy({
    prId: pr(5),
    prNumber: 5,
    target: target({ services: ['n8n', 'n8n', 'n8n-import'] }),
    now: new Date().toISOString(),
  })
  assert.equal(dueJobs()[0]!.services, 'n8n n8n-import')
})

test('nothing is pending once the queue is worked off', () => {
  enqueueDeploy({ prId: pr(6), prNumber: 6, target: target(), now: new Date().toISOString() })
  getDb().exec(`UPDATE deploys SET status = 'deployed'`)
  assert.equal(dueJobs().length, 0)
  assert.ok(!hasPendingDeploys())
})

test('lifecycle states reach every update behind the deploy', () => {
  const prId = pr(7)
  const now = new Date().toISOString()
  const u = getDb()
    .prepare(
      `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state,
                            detected_at, updated_at)
       VALUES ('jellyfin','jellyfin','j:1','1','2','minor','auto','merged',?,?)`,
    )
    .run(now, now)
  getDb()
    .prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`)
    .run(prId, Number(u.lastInsertRowid))
  enqueueDeploy({ prId, prNumber: 7, target: target(), now })

  markUpdates(dueJobs()[0]!.id, 'deploying')
  const row = getDb()
    .prepare(`SELECT state FROM updates WHERE id = ?`)
    .get(Number(u.lastInsertRowid)) as { state: string }
  assert.equal(row.state, 'deploying')
})
