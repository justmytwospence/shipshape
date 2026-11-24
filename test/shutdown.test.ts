import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Shutdown in order: stop starting, wait a bounded time, close the database, exit. */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-shutdown-'))
process.env.DATA_DIR = dir
delete process.env.REPO_DIR

const { createShutdown } = await import('../src/shutdown.ts')
const { isStopping } = await import('../src/lifecycle.ts')
const { getDb, closeDb } = await import('../src/db.ts')

after(() => rmSync(dir, { recursive: true, force: true }))

type Logged = { level: string; message: string; detail?: string }

function harness(o: { idle?: () => Promise<unknown>[]; deadlineMs?: number } = {}) {
  const steps: string[] = []
  const logged: Logged[] = []
  const exits: number[] = []
  const shutdown = createShutdown({
    closeListeners: async () => void steps.push('listeners'),
    stopScheduler: () => void steps.push('scheduler'),
    idle: o.idle ?? (() => []),
    inFlight: () => ['a deploy of books'],
    closeDb: () => void steps.push('db'),
    exit: (code) => void exits.push(code),
    log: ((e: Logged) => void logged.push(e)) as never,
    deadlineMs: o.deadlineMs,
  })
  return { shutdown, steps, logged, exits }
}

test('shutdown waits for work in flight, then closes the database and exits 0', async () => {
  let release!: () => void
  const work = new Promise<void>((r) => (release = r))
  const h = harness({ idle: () => [work] })
  const done = h.shutdown('SIGTERM')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(isStopping(), true)
  assert.deepEqual(h.steps, ['scheduler', 'listeners'])
  assert.deepEqual(h.exits, [], 'nothing exits while work runs')
  release()
  await done
  assert.deepEqual(h.steps, ['scheduler', 'listeners', 'db'])
  assert.deepEqual(h.exits, [0])
  assert.deepEqual(
    h.logged.map((l) => l.message),
    ['shutting down', 'shut down cleanly'],
  )
})

test('shutdown gives up at the deadline and still exits 0', async () => {
  const h = harness({ idle: () => [new Promise(() => {})], deadlineMs: 50 })
  await h.shutdown('SIGTERM')
  assert.deepEqual(h.exits, [0])
  const last = h.logged.at(-1)!
  assert.equal(last.message, 'shutdown deadline reached')
  assert.match(last.detail ?? '', /still running: a deploy of books/)
  assert.equal(h.steps.at(-1), 'db')
})

test('a second signal exits at once with 1', async () => {
  const h = harness({ idle: () => [new Promise(() => {})], deadlineMs: 100 })
  const first = h.shutdown('SIGTERM')
  await h.shutdown('SIGINT')
  assert.deepEqual(h.exits, [1])
  await first
  assert.deepEqual(h.exits, [1, 0])
})

test('getDb after closeDb throws instead of reopening', () => {
  getDb()
  closeDb()
  assert.throws(() => getDb(), /the database is closed \(shutting down\)/)
})
