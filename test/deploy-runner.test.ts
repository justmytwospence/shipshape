import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * One deploy per stack at a time. Two things start deploys -- the queue's drain and a
 * person's button -- and compose cannot tolerate two `up -d`s against one project. A launch
 * that finds the stack busy leaves its row `pending`; the drain carries it out later.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-runner-'))
process.env.DATA_DIR = dir
delete process.env.REPO_DIR

const { getDb } = await import('../src/db/index.ts')
const { launchDeploy, stackBusy, deploysIdle, inFlightDeployIds } = await import('../src/deploy/runner.ts')
const { drainDeployQueue } = await import('../src/deploy/queue.ts')
const { beginShutdown } = await import('../src/lifecycle.ts')
const { fakeIo } = await import('./helpers/deploy-io.ts')

after(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  getDb().exec(`DELETE FROM deploy_updates; DELETE FROM deploys; DELETE FROM updates; DELETE FROM events;`)
})

const now = () => new Date().toISOString()
const OK = async () => ({ status: 'in-sync' as const, sha: 'x' })

function deploy(stack: string, status: 'pending' | 'ready' = 'ready'): number {
  const info = getDb()
    .prepare(
      `INSERT INTO deploys (stack, services, strategy, ok, healthy, status, attempts, created_at, trigger)
       VALUES (?, ?, 'up', 0, 0, ?, 0, ?, 'operator')`,
    )
    .run(stack, stack, status, now())
  return Number(info.lastInsertRowid)
}
const row = (id: number) =>
  getDb().prepare(`SELECT status, attempts, detail FROM deploys WHERE id = ?`).get(id) as {
    status: string
    attempts: number
    detail: string | null
  }

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((r) => (open = r))
  return { promise, open }
}

test('a second deploy of a busy stack is queued, not run alongside the first', async () => {
  const hold = gate()
  const first = deploy('media')
  const l1 = launchDeploy(first, 'media', {
    label: 'first',
    io: fakeIo({ media: 'absent' }),
    sync: async () => {
      await hold.promise
      return { status: 'in-sync', sha: 'x' }
    },
  })
  assert.deepEqual(l1, { started: true })
  assert.equal(stackBusy('media'), true)
  assert.ok(inFlightDeployIds().has(first))

  const second = deploy('media', 'ready')
  const l2 = launchDeploy(second, 'media', { label: 'second', io: fakeIo({ media: 'absent' }), sync: OK })
  assert.equal(l2.started, false)
  assert.ok('queued' in l2 && l2.queued)
  assert.match((l2 as { message: string }).message, /already running; this one is queued/)
  assert.equal(row(second).status, 'pending', 'a ready row pressed while its stack is busy becomes pending')

  hold.open()
  await deploysIdle()
  assert.equal(stackBusy('media'), false)
  assert.equal(inFlightDeployIds().size, 0)
})

test('two stacks deploy side by side', async () => {
  const hold = gate()
  const slow = async () => {
    await hold.promise
    return { status: 'in-sync' as const, sha: 'x' }
  }
  const a = launchDeploy(deploy('a'), 'a', { label: 'a', io: fakeIo({ a: 'absent' }), sync: slow })
  const b = launchDeploy(deploy('b'), 'b', { label: 'b', io: fakeIo({ b: 'absent' }), sync: slow })
  assert.deepEqual([a, b], [{ started: true }, { started: true }])
  hold.open()
  await deploysIdle()
})

test('a refused sync leaves the row pending and gives its attempt back', async () => {
  const id = deploy('media')
  const l = launchDeploy(id, 'media', {
    label: 'x',
    io: fakeIo({ media: 'absent' }),
    sync: async () => ({ status: 'paused', reason: 'checkout is on "dev"' }),
  })
  assert.deepEqual(l, { started: true })
  await deploysIdle()
  const r = row(id)
  assert.equal(r.status, 'pending')
  assert.equal(r.attempts, 0)
  assert.match(r.detail ?? '', /^waiting: the checkout could not be updated \(checkout is on "dev"\)/)
  assert.equal(stackBusy('media'), false)
})

test('the drain skips a stack an operator deploy holds', async () => {
  const hold = gate()
  launchDeploy(deploy('media'), 'media', {
    label: 'x',
    io: fakeIo({ media: 'absent' }),
    sync: async () => {
      await hold.promise
      return { status: 'in-sync', sha: 'x' }
    },
  })
  const waiting = deploy('media', 'pending')
  const r = await drainDeployQueue()
  assert.equal(r.ran, 0)
  assert.equal(row(waiting).status, 'pending')
  hold.open()
  await deploysIdle()
})

test('reclaimStale never touches a deploy this process is running', async () => {
  const hold = gate()
  const id = deploy('media')
  launchDeploy(id, 'media', {
    label: 'x',
    io: fakeIo({ media: 'absent' }),
    sync: async () => {
      await hold.promise
      return { status: 'in-sync', sha: 'x' }
    },
  })
  getDb()
    .prepare(`UPDATE deploys SET started_at = ? WHERE id = ?`)
    .run(new Date(Date.now() - 3_600_000).toISOString(), id)
  await drainDeployQueue()
  assert.equal(row(id).status, 'running', 'slow is not stuck')
  hold.open()
  await deploysIdle()
})

test('while shutting down nothing starts and the row is queued', () => {
  beginShutdown()
  const id = deploy('media', 'ready')
  const l = launchDeploy(id, 'media', { label: 'x', io: fakeIo({ media: 'absent' }), sync: OK })
  assert.equal(l.started, false)
  assert.match((l as { message: string }).message, /restarting/)
  assert.equal(row(id).status, 'pending')
})
