import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'shipshape-test-'))

const { getDb } = await import('../src/db.ts')
const {
  carriedUpdates,
  enqueueDeploy,
  claimJob,
  dueJobs,
  hasPendingDeploys,
  linkDeployUpdates,
  markUpdates,
} = await import('../src/deploy/queue.ts')

/**
 * The queue exists for one guarantee: a merge that has been recorded cannot be forgotten.
 *
 * Before it, the pull request was marked merged and then deployed in the same breath,
 * with no try/catch on the path. Anything thrown in between -- a missing binary, a
 * socket permission, the container restarting -- left a merge nothing would ever act on
 * again, because `merged` had already removed it from the query that finds work.
 */

function reset(): void {
  getDb().exec(
    `DELETE FROM deploy_updates; DELETE FROM deploys; DELETE FROM prs; DELETE FROM updates; DELETE FROM pr_updates;`,
  )
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
  // Distinct stacks: two intents for the *same* services are not a queue of two, and
  // the newer one retires the older (see the supersession test below).
  for (let i = 10; i < 16; i++) {
    enqueueDeploy({
      prId: pr(i),
      prNumber: i,
      target: target({ stack: `stack-${i}` }),
      now: `2026-01-0${i - 9}T00:00:00Z`,
    })
  }
  assert.equal(dueJobs().length, 3, 'default cap')
  assert.equal(
    getDb().prepare(`SELECT COUNT(*) c FROM deploys WHERE status='pending'`).get().c,
    6,
    'the rest stay queued rather than being dropped',
  )
})

test('a newer intent for the same services retires the older one', () => {
  // Two pending intents for one stack are not two deploys: bringing it up runs against
  // whatever the checkout says now, so the older job would deploy this content and
  // record it under the wrong pull request.
  const now = new Date().toISOString()
  enqueueDeploy({ prId: pr(20), prNumber: 20, target: target({ stack: 'immich' }), now })
  enqueueDeploy({ prId: pr(21), prNumber: 21, target: target({ stack: 'immich' }), now })

  const rows = getDb()
    .prepare(`SELECT pr_number, status, detail FROM deploys WHERE stack = 'immich' ORDER BY id`)
    .all() as { pr_number: number; status: string; detail: string | null }[]
  assert.deepEqual(
    rows.map((r) => [r.pr_number, r.status]),
    [
      [20, 'superseded'],
      [21, 'pending'],
    ],
  )
  assert.match(rows[0]!.detail!, /overtaken by #21/)
  assert.equal(dueJobs().filter((j) => j.stack === 'immich').length, 1)
})

test('a claim can only be won once', () => {
  // The drain and an operator pressing Deploy must never both run compose on one stack.
  const now = new Date().toISOString()
  enqueueDeploy({ prId: pr(30), prNumber: 30, target: target({ stack: 'claimed' }), now })
  const id = (
    getDb().prepare(`SELECT id FROM deploys WHERE stack = 'claimed'`).get() as { id: number }
  ).id

  const first = claimJob(id)
  assert.ok(first, 'the first caller takes it')
  assert.equal(first!.stack, 'claimed')
  assert.equal(claimJob(id), null, 'the second finds it already running')
})

test('a ready job waits for the operator but can still be claimed', () => {
  // What a merge performed while paused leaves behind: an intent that never self-starts.
  const now = new Date().toISOString()
  enqueueDeploy({
    prId: pr(31),
    prNumber: 31,
    target: target({ stack: 'ready-stack' }),
    now,
    status: 'ready',
  })
  assert.equal(dueJobs().filter((j) => j.stack === 'ready-stack').length, 0, 'not due')
  const id = (
    getDb().prepare(`SELECT id FROM deploys WHERE stack = 'ready-stack'`).get() as { id: number }
  ).id
  assert.ok(claimJob(id), 'but the button can start it')
})

test('a queued deploy records which updates it carries', () => {
  // A rolling redeploy and a rollback have no pull request to infer this from later.
  const db = getDb()
  const prId = pr(40)
  db.prepare(
    `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state,
                          detected_at, updated_at)
     VALUES ('linked','svc','img','1.0.0','1.1.0','minor','manual','pr_open',?,?)`,
  ).run(new Date().toISOString(), new Date().toISOString())
  const updateId = (db.prepare(`SELECT id FROM updates ORDER BY id DESC LIMIT 1`).get() as { id: number }).id
  db.prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`).run(prId, updateId)

  enqueueDeploy({
    prId,
    prNumber: 40,
    target: target({ stack: 'linked' }),
    now: new Date().toISOString(),
  })
  const deployId = (
    db.prepare(`SELECT id FROM deploys WHERE stack = 'linked'`).get() as { id: number }
  ).id
  const linked = db
    .prepare(`SELECT update_id FROM deploy_updates WHERE deploy_id = ?`)
    .all(deployId) as { update_id: number }[]
  assert.deepEqual(linked.map((r) => r.update_id), [updateId])
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

/**
 * What a deploy moves is what it carried, not everything on its pull request.
 *
 * `markUpdates` used to join through the pull request. A retry pressed on one group member
 * moved all of them, a rolling redeploy with no pull request moved nothing, and a deploy
 * that brought up half a group had no way to say which half.
 */

function update(
  service: string,
  over: Partial<{ stack: string; from: string; to: string; state: string }> = {},
): number {
  const now = new Date().toISOString()
  const info = getDb()
    .prepare(
      `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state,
                            detected_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'minor', 'auto', ?, ?, ?)`,
    )
    .run(
      over.stack ?? 'n8n',
      service,
      `img/${service}`,
      over.from ?? '2.38.5',
      over.to ?? '2.38.7',
      over.state ?? 'merged',
      now,
      now,
    )
  return Number(info.lastInsertRowid)
}

const stateOf = (id: number) =>
  (getDb().prepare(`SELECT state FROM updates WHERE id = ?`).get(id) as { state: string }).state

/** The n8n group as #8 merged it: two members, one pull request, one queued deploy. */
function n8nGroup(): { prId: number; deployId: number; importId: number; n8nId: number } {
  const db = getDb()
  const prId = pr(8)
  const importId = update('n8n-import')
  const n8nId = update('n8n')
  const link = db.prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`)
  link.run(prId, importId)
  link.run(prId, n8nId)
  enqueueDeploy({
    prId,
    prNumber: 8,
    target: target({ stack: 'n8n', services: ['n8n-import', 'n8n'] }),
    now: new Date().toISOString(),
  })
  const deployId = (db.prepare(`SELECT id FROM deploys WHERE stack = 'n8n'`).get() as { id: number }).id
  return { prId, deployId, importId, n8nId }
}

test('markUpdates follows what the deploy carried', () => {
  const { deployId, importId, n8nId } = n8nGroup()

  markUpdates(deployId, 'deploying', { services: ['n8n'] })
  assert.equal(stateOf(n8nId), 'deploying')
  assert.equal(stateOf(importId), 'merged', 'the member that was not named stays where it was')

  // Nothing named is nothing moved, never "all of them".
  markUpdates(deployId, 'x', { services: [] })
  assert.equal(stateOf(n8nId), 'deploying')
  assert.equal(stateOf(importId), 'merged')
})

test('a retry of one member moves only that member', () => {
  // Try again is pressed on one update. Its row belongs to the same pull request as the
  // group, and marking through that pull request moved the sibling it never carried.
  const { prId, importId, n8nId } = n8nGroup()
  const info = getDb()
    .prepare(
      `INSERT INTO deploys (pr_number, pr_id, stack, services, strategy, ok, healthy,
                            status, attempts, created_at, trigger)
       VALUES (8, ?, 'n8n', 'n8n-import n8n', 'up', 0, 0, 'pending', 0, ?, 'retry')`,
    )
    .run(prId, new Date().toISOString())
  const retryId = Number(info.lastInsertRowid)
  linkDeployUpdates(retryId, prId, [n8nId])

  markUpdates(retryId, 'deployed')
  assert.equal(stateOf(n8nId), 'deployed')
  assert.equal(stateOf(importId), 'merged')
})

test('a deploy with no pull request still moves its update', () => {
  // A rolling-tag redeploy. There is no pull request to join through, so the update used
  // to stay in whatever state it was pressed in, whatever the deploy did.
  const updateId = update('actual', {
    stack: 'actual',
    from: 'latest@sha256:aaa',
    to: 'latest@sha256:bbb',
    state: 'detected',
  })
  const info = getDb()
    .prepare(
      `INSERT INTO deploys (pr_number, pr_id, stack, services, strategy, ok, healthy,
                            status, attempts, created_at, trigger)
       VALUES (NULL, NULL, 'actual', 'actual', 'up', 0, 0, 'pending', 0, ?, 'redeploy')`,
    )
    .run(new Date().toISOString())
  const deployId = Number(info.lastInsertRowid)
  linkDeployUpdates(deployId, null, [updateId])

  markUpdates(deployId, 'deploying')
  assert.equal(stateOf(updateId), 'deploying')
  assert.equal(claimJob(deployId)!.trigger, 'redeploy')
})

test('a deploy knows the versions of what it carried, and only that', () => {
  // The digest line is built from this. A retry pressed on one member must not name the
  // sibling it never brought up.
  const { prId, n8nId, deployId } = n8nGroup()
  assert.deepEqual(carriedUpdates(deployId), [
    { service: 'n8n-import', from_tag: '2.38.5', to_tag: '2.38.7' },
    { service: 'n8n', from_tag: '2.38.5', to_tag: '2.38.7' },
  ])

  const info = getDb()
    .prepare(
      `INSERT INTO deploys (pr_number, pr_id, stack, services, strategy, ok, healthy,
                            status, attempts, created_at, trigger)
       VALUES (8, ?, 'n8n', 'n8n', 'up', 0, 0, 'pending', 0, ?, 'retry')`,
    )
    .run(prId, new Date().toISOString())
  const retryId = Number(info.lastInsertRowid)
  linkDeployUpdates(retryId, prId, [n8nId])
  assert.deepEqual(carriedUpdates(retryId), [{ service: 'n8n', from_tag: '2.38.5', to_tag: '2.38.7' }])
})

test('claimed jobs know who asked for them', () => {
  // A redeploy that does not land leaves its update somewhere different from a merge that
  // does not, so the job has to carry who asked for it.
  enqueueDeploy({ prId: pr(50), prNumber: 50, target: target({ stack: 'asked' }), now: new Date().toISOString() })
  const id = (getDb().prepare(`SELECT id FROM deploys WHERE stack = 'asked'`).get() as { id: number }).id
  assert.equal(dueJobs().find((j) => j.id === id)!.trigger, 'queue')
  assert.equal(claimJob(id)!.trigger, 'queue')
})
