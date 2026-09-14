import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'shipshape-left-stopped-'))
process.env.DATA_DIR = dir
delete process.env.REPO_DIR
process.env.GITHUB_REPO = 'you/repo'
// No channel configured, so the failure paths below have nobody to alert.
delete process.env.NTFY_URL
delete process.env.NTFY_TOKEN
delete process.env.SMTP_URL

const { getDb } = await import('../src/db.ts')
const { carriedFor, claimJob, enqueueDeploy, linkDeployUpdates, runDeployJob, runRechecks } = await import(
  '../src/deploy/queue.ts'
)
const { readRecordedPlan } = await import('../src/deploy/runstate.ts')
const { composeCalls, fakeIo, obs } = await import('./helpers/deploy-io.ts')
type DeployJob = import('../src/deploy/queue.ts').DeployJob

after(() => rmSync(dir, { recursive: true, force: true }))

/**
 * A deploy's outcome, end to end through the queue: the row, the updates, the digest.
 *
 * bitwarden was stopped on purpose, #101 merged 1.37.3 at 09:02 on 2026-09-14, and the
 * deploy started it -- then the digest called it deployed. Here a deploy that finds a
 * service stopped leaves it so, and every record says Left stopped rather than verified.
 */

beforeEach(() => {
  getDb().exec(
    `DELETE FROM deploy_updates; DELETE FROM deploys; DELETE FROM pr_updates; DELETE FROM prs;
     DELETE FROM updates; DELETE FROM digest_items; DELETE FROM events;`,
  )
})

const now = () => new Date().toISOString()
const db = () => getDb()

function seedPr(number: number): number {
  const info = db()
    .prepare(
      `INSERT INTO prs (number, branch, head_sha_pushed, state, scope, created_at, merge_commit_sha)
       VALUES (?, ?, 'sha', 'merged', 'tag-only', ?, 'abc1234')`,
    )
    .run(number, `b${number}`, now())
  return Number(info.lastInsertRowid)
}

function seedUpdate(u: { stack: string; service: string; from: string; to: string; state?: string }): number {
  const info = db()
    .prepare(
      `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state, detected_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'patch', 'auto', ?, ?, ?)`,
    )
    .run(u.stack, u.service, `img/${u.service}`, u.from, u.to, u.state ?? 'merged', now(), now())
  return Number(info.lastInsertRowid)
}

/** A merged pull request carrying these updates, queued and claimed the way the drain does. */
function mergedAndClaimed(
  number: number,
  stack: string,
  updates: { service: string; from: string; to: string }[],
): { job: DeployJob; ids: number[]; id: number } {
  const prId = seedPr(number)
  const ids = updates.map((u) => {
    const id = seedUpdate({ stack, ...u })
    db().prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`).run(prId, id)
    return id
  })
  enqueueDeploy({
    prId,
    prNumber: number,
    target: { stack, services: updates.map((u) => u.service), strategy: 'up' },
    now: now(),
  })
  const { id } = db().prepare(`SELECT MAX(id) id FROM deploys`).get() as { id: number }
  return { job: claimJob(id)!, ids, id }
}

function insertDeploy(o: {
  stack: string
  status: string
  ok?: number
  healthy?: number
  snapshot?: string | null
  trigger?: string
  prNumber?: number | null
  prId?: number | null
}): number {
  const info = db()
    .prepare(
      `INSERT INTO deploys (pr_number, pr_id, stack, services, strategy, ok, healthy, status, attempts,
                            created_at, trigger, snapshot)
       VALUES (?, ?, ?, ?, 'up', ?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(
      o.prNumber ?? null,
      o.prId ?? null,
      o.stack,
      o.stack,
      o.ok ?? 0,
      o.healthy ?? 0,
      o.status,
      now(),
      o.trigger ?? 'queue',
      o.snapshot ?? null,
    )
  return Number(info.lastInsertRowid)
}

/** A recorded plan that brought `up` up and left `left`. */
const planJson = (up: string[], left: string[] = []) =>
  JSON.stringify({
    v: 1,
    at: now(),
    seen: [],
    up,
    left: left.map((service) => ({ service, state: 'exited', why: 'not-running', restartPolicy: 'unless-stopped', oldRef: null })),
    restored: [],
  })

const deployRow = (id: number) =>
  db()
    .prepare(`SELECT status, ok, healthy, detail, recheck_at, snapshot FROM deploys WHERE id = ?`)
    .get(id) as { status: string; ok: number; healthy: number; detail: string; recheck_at: string | null; snapshot: string | null }

const stateOf = (updateId: number) =>
  (db().prepare(`SELECT state FROM updates WHERE id = ?`).get(updateId) as { state: string }).state

const digestItems = () =>
  db()
    .prepare(`SELECT category, stack, service, summary, detail, url FROM digest_items ORDER BY id`)
    .all() as { category: string; stack: string; service: string | null; summary: string; detail: string | null; url: string | null }[]

const lastEvent = () =>
  db().prepare(`SELECT level, message, detail FROM events WHERE kind = 'deploy' ORDER BY id DESC LIMIT 1`).get() as {
    level: string
    message: string
    detail: string | null
  }

// ---------------------------------------------------------------- the reported case

test('a deploy that brought nothing up reads left stopped, not verified', async () => {
  const { job, ids, id } = mergedAndClaimed(101, 'bitwarden', [{ service: 'bitwarden', from: '1.37.2', to: '1.37.3' }])
  const io = fakeIo(
    { bitwarden: { state: 'exited', imageRef: 'vaultwarden/server:1.37.2' } },
    { pinned: () => new Map([['bitwarden', 'vaultwarden/server:1.37.3']]) },
  )
  await runDeployJob(job, { io })

  const sentence = 'bitwarden left stopped (exited) — compose brings it up on 1.37.3; docker start would resume 1.37.2'
  assert.deepEqual(composeCalls(io.calls), [])

  const row = deployRow(id)
  assert.equal(row.status, 'left-stopped')
  assert.equal(row.ok, 1)
  assert.equal(row.healthy, 0)
  assert.equal(row.recheck_at, null, 'nothing came up, so nothing soaks')
  assert.equal(row.detail, sentence)
  assert.equal(readRecordedPlan(row.snapshot)!.left[0]!.service, 'bitwarden')

  assert.equal(stateOf(ids[0]!), 'left-stopped')

  const items = digestItems()
  assert.deepEqual(items.at(-1), {
    category: 'left-stopped',
    stack: 'bitwarden',
    service: 'bitwarden',
    summary: '#101 merged — 1.37.2 -> 1.37.3, left stopped (not running)',
    detail: sentence,
    url: 'https://github.com/you/repo/pull/101',
  })
  assert.ok(!items.some((i) => /up in/.test(i.summary)))

  assert.deepEqual(lastEvent(), { level: 'info', message: 'bitwarden left stopped', detail: sentence })
})

test('a clean deploy names the versions it moved between', async () => {
  const { job, ids, id } = mergedAndClaimed(102, 'servarr', [
    { service: 'jackett', from: 'v0.24.2572-ls26', to: 'v0.24.2586-ls28' },
  ])
  const io = fakeIo({ jackett: 'running' })
  await runDeployJob(job, { io })

  assert.deepEqual(composeCalls(io.calls), ['compose -f servarr/docker-compose.yaml up -d --no-deps jackett'])
  const row = deployRow(id)
  assert.equal(row.status, 'deployed')
  assert.match(row.detail, /^jackett up in \d+s$/)
  assert.ok(row.recheck_at, 'soaking')
  assert.equal(stateOf(ids[0]!), 'deployed')

  const item = digestItems().at(-1)!
  assert.equal(item.summary, '#102 deployed — v0.24.2572-ls26 -> v0.24.2586-ls28')
  assert.equal(item.service, 'jackett')
  assert.equal(item.detail, null)
  assert.equal(lastEvent().message, 'servarr deployed')
})

// ---------------------------------------------------------------- a group, half running

async function partialGroup() {
  const deployed = mergedAndClaimed(91, 'n8n', [
    { service: 'n8n-import', from: '2.38.5', to: '2.38.7' },
    { service: 'n8n', from: '2.38.5', to: '2.38.7' },
  ])
  const io = fakeIo(
    {
      n8n: 'running',
      'n8n-import': { state: 'exited', exitCode: 0, restartPolicy: 'no', imageRef: 'n8nio/n8n:2.38.5' },
    },
    {
      pinned: () =>
        new Map([
          ['n8n', 'n8nio/n8n:2.38.7'],
          ['n8n-import', 'n8nio/n8n:2.38.7'],
        ]),
    },
  )
  await runDeployJob(deployed.job, { io })
  return { ...deployed, io }
}

test('a partial group deploys the running half and leaves the other', async () => {
  const { ids, id, io } = await partialGroup()
  const [importId, n8nId] = ids as [number, number]

  assert.deepEqual(composeCalls(io.calls), ['compose -f n8n/docker-compose.yaml up -d --no-deps n8n'])
  assert.ok(io.calls.includes('verify n8n'))

  const clause = 'n8n-import left stopped (exited) — compose brings it up on 2.38.7; docker start would resume 2.38.5'
  const row = deployRow(id)
  assert.equal(row.status, 'deployed')
  assert.match(row.detail, new RegExp(`^n8n up in \\d+s; ${clause.replace(/[().]/g, '\\$&')}$`))
  assert.equal(stateOf(n8nId), 'deployed')
  assert.equal(stateOf(importId), 'left-stopped')

  const item = digestItems().at(-1)!
  assert.equal(item.category, 'deployed')
  assert.equal(item.summary, '#91 deployed — n8n-import, n8n 2.38.5 -> 2.38.7; n8n-import left stopped (not running)')
  assert.equal(item.service, null)
  assert.equal(item.detail, clause)
})

test('the soak only looks at what came up', async () => {
  const { ids, id } = await partialGroup()
  const [importId, n8nId] = ids as [number, number]
  db().prepare(`UPDATE deploys SET recheck_at = ? WHERE id = ?`).run(new Date(Date.now() - 60_000).toISOString(), id)

  const looked: string[] = []
  await runRechecks({
    observe: async (_project, service) => {
      looked.push(service)
      return obs(service)
    },
  })
  assert.deepEqual(looked, ['n8n'], 'n8n-import was never started, so it is not soaked')
  assert.equal(deployRow(id).status, 'verified')
  assert.equal(stateOf(n8nId), 'verified')
  assert.equal(stateOf(importId), 'left-stopped')
})

// ---------------------------------------------------------------- carry

test('a retry puts back what the failed attempt took down', async () => {
  const prId = seedPr(93)
  const updateId = seedUpdate({ stack: 'minuspod', service: 'minuspod', from: '2.96.15-cpu', to: '2.96.17-cpu' })
  db().prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`).run(prId, updateId)

  // The attempt that removed the old container and failed mid-Recreate, leaving it DOWN.
  insertDeploy({ stack: 'minuspod', status: 'failed', prNumber: 93, prId, snapshot: planJson(['minuspod']) })
  // Try again on the alert.
  const retryId = insertDeploy({ stack: 'minuspod', status: 'pending', trigger: 'retry', prNumber: 93, prId })
  linkDeployUpdates(retryId, prId, [updateId])
  assert.ok(carriedFor('minuspod', ['minuspod'], retryId).has('minuspod'))

  const io = fakeIo({ minuspod: 'absent' })
  await runDeployJob(claimJob(retryId)!, { io })
  assert.ok(io.calls.includes('compose -f minuspod/docker-compose.yaml up -d --no-deps minuspod'), io.calls.join('\n'))
  const row = deployRow(retryId)
  assert.equal(row.status, 'deployed')
  assert.match(row.detail, /^minuspod up in \d+s; minuspod brought back up — shipshape's last attempt left it down$/)
  assert.equal(stateOf(updateId), 'deployed')
})

test('an interrupted attempt keeps its own plan', () => {
  const id = insertDeploy({ stack: 'minuspod', status: 'pending', snapshot: planJson(['minuspod']) })
  assert.ok(carriedFor('minuspod', ['minuspod'], id).has('minuspod'))

  const leftIt = insertDeploy({ stack: 'bitwarden', status: 'pending', snapshot: planJson([], ['bitwarden']) })
  assert.equal(carriedFor('bitwarden', ['bitwarden'], leftIt).size, 0, 'its own plan left it, so it stays left')
})

test("another row's attempt that never finished still carries", () => {
  // shipshape died after rm-first removed minuspod, and a second deploy of it drained before
  // reclaimStale's thirty minutes were up: the older row still reads running, and its plan
  // meant minuspod to be up. A throw puts a row back to pending, and a newer merge can
  // supersede it while it waits.
  for (const status of ['running', 'pending', 'superseded']) {
    db().exec(`DELETE FROM deploys`)
    insertDeploy({ stack: 'minuspod', status, snapshot: planJson(['minuspod']) })
    const newer = insertDeploy({ stack: 'minuspod', status: 'running' })
    assert.ok(carriedFor('minuspod', ['minuspod'], newer).has('minuspod'), status)
  }

  db().exec(`DELETE FROM deploys`)
  insertDeploy({ stack: 'minuspod', status: 'running', snapshot: planJson([], ['minuspod']) })
  const newer = insertDeploy({ stack: 'minuspod', status: 'running' })
  assert.equal(carriedFor('minuspod', ['minuspod'], newer).size, 0, 'an unfinished plan that left it still left it')
})

test('an attempt that failed with nothing healthy carries, whatever the failure was called', () => {
  for (const status of ['failed', 'error', 'rolled-back']) {
    db().exec(`DELETE FROM deploys`)
    insertDeploy({ stack: 'svc', status, snapshot: planJson(['svc']) })
    const next = insertDeploy({ stack: 'svc', status: 'pending' })
    assert.ok(carriedFor('svc', ['svc'], next).has('svc'), status)
  }
})

test('verified weeks ago is not a licence to start it', () => {
  insertDeploy({ stack: 'svc', status: 'verified', ok: 1, healthy: 1, snapshot: planJson(['svc']) })
  let next = insertDeploy({ stack: 'svc', status: 'pending' })
  assert.equal(carriedFor('svc', ['svc'], next).size, 0, 'a verified plan is not damage')

  db().exec(`DELETE FROM deploys`)
  insertDeploy({ stack: 'svc', status: 'failed', snapshot: planJson(['svc']) })
  insertDeploy({ stack: 'svc', status: 'left-stopped', ok: 1, snapshot: planJson([], ['svc']) })
  next = insertDeploy({ stack: 'svc', status: 'pending' })
  assert.equal(carriedFor('svc', ['svc'], next).size, 0, 'a later plan that left it is the later word')

  db().exec(`DELETE FROM deploys`)
  insertDeploy({ stack: 'svc', status: 'rolled-back', ok: 1, healthy: 1, trigger: 'rollback', snapshot: planJson(['svc']) })
  next = insertDeploy({ stack: 'svc', status: 'pending' })
  assert.equal(carriedFor('svc', ['svc'], next).size, 0, 'an operator rollback that came back healthy')

  db().exec(`DELETE FROM deploys`)
  const mine = insertDeploy({ stack: 'svc', status: 'pending' })
  insertDeploy({ stack: 'svc', status: 'failed', snapshot: planJson(['svc']) })
  insertDeploy({ stack: 'other', status: 'failed', snapshot: planJson(['svc']) })
  assert.equal(carriedFor('svc', ['svc'], mine).size, 0, 'a later row, or another stack, says nothing about this one')
})

// ---------------------------------------------------------------- redeploys

const rolling = { from: 'latest@sha256:cb4826a1b2c3d4e5f60718293a4b5c6d', to: 'latest@sha256:09fb11d4e5f6a7b8c9d0e1f2a3b4c5d6' }

function redeployClaimed(): { job: DeployJob; id: number; updateId: number } {
  const updateId = seedUpdate({ stack: 'actual', service: 'actual', ...rolling, state: 'detected' })
  const id = insertDeploy({ stack: 'actual', status: 'pending', trigger: 'redeploy' })
  linkDeployUpdates(id, null, [updateId])
  return { job: claimJob(id)!, id, updateId }
}

test('a redeploy that deployed names no pull request', async () => {
  const { job, updateId } = redeployClaimed()
  const io = fakeIo({ actual: 'running' })
  await runDeployJob(job, { pull: true, io })

  assert.deepEqual(composeCalls(io.calls), [
    'compose -f actual/docker-compose.yaml pull actual',
    'compose -f actual/docker-compose.yaml up -d --no-deps actual',
  ])
  const item = digestItems().at(-1)!
  assert.equal(item.summary, 'redeployed — latest@cb4826a1b2c3 -> latest@09fb11d4e5f6')
  assert.equal(item.url, null)
  assert.equal(stateOf(updateId), 'deployed')
})

test('a redeploy of a stopped rolling service does nothing and says nothing', async () => {
  const { job, id, updateId } = redeployClaimed()
  const io = fakeIo({ actual: 'exited' })
  await runDeployJob(job, { pull: true, io })

  assert.deepEqual(composeCalls(io.calls), [], 'not even a pull')
  assert.equal(deployRow(id).status, 'left-stopped')
  assert.equal(stateOf(updateId), 'left-stopped')
  assert.deepEqual(digestItems(), [])
  // Nothing was pulled, so compose would start the image already here, not the move.
  assert.equal(
    deployRow(id).detail,
    'actual left stopped (exited) — nothing was pulled, so compose brings it up on the image already on this host; Redeploy once it is running',
  )
})

test('a redeploy that did not land leaves the tag moved', async () => {
  const { job, id, updateId } = redeployClaimed()
  const io = fakeIo({ actual: 'running' }, { exitCode: (c) => (c.includes(' up ') ? 1 : 0) })
  await runDeployJob(job, { pull: true, io })
  assert.equal(deployRow(id).status, 'failed')
  assert.equal(stateOf(updateId), 'detected')
})

// ---------------------------------------------------------------- docker could not be asked

test('a docker that cannot be asked records a failure, and no plan', async () => {
  const { job, ids, id } = mergedAndClaimed(101, 'bitwarden', [{ service: 'bitwarden', from: '1.37.2', to: '1.37.3' }])
  const io = fakeIo({ bitwarden: 'unreadable' })
  await runDeployJob(job, { io })

  assert.deepEqual(composeCalls(io.calls), [])
  const row = deployRow(id)
  assert.equal(row.status, 'failed')
  assert.equal(row.snapshot, null, 'a guess is never recorded as a plan')
  assert.match(row.detail, /^could not ask docker whether bitwarden is running: permission denied/)
  assert.equal(stateOf(ids[0]!), 'merged', 'still merged, so Try again is offered')
  assert.deepEqual(lastEvent().message, 'deploy of bitwarden failed after #101 merged')
  assert.deepEqual(digestItems(), [])
})
