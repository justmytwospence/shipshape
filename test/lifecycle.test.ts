import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The registry of background work: shutdown waits on it, and a rejection never escapes. */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-lifecycle-'))
process.env.DATA_DIR = dir
delete process.env.REPO_DIR

const { track, background, inFlight, drain, isStopping, beginShutdown } = await import('../src/lifecycle.ts')
const { getDb } = await import('../src/db.ts')

after(() => rmSync(dir, { recursive: true, force: true }))

test('tracked work is forgotten once it settles', async () => {
  let release!: () => void
  const work = track(new Promise<void>((r) => (release = r)), 'a thing')
  assert.deepEqual(inFlight(), ['a thing'])
  release()
  await work
  await Promise.resolve()
  assert.deepEqual(inFlight(), [])
})

test('background logs a rejection instead of throwing', async () => {
  background(Promise.reject(new Error('boom')), 'the thing', 'deploy')
  await drain()
  await new Promise((r) => setImmediate(r))
  const row = getDb().prepare(`SELECT level, kind, message, detail FROM events WHERE message = 'the thing threw'`).get() as
    | { level: string; kind: string; message: string; detail: string }
    | undefined
  assert.deepEqual(row && { level: row.level, kind: row.kind, detail: row.detail }, { level: 'error', kind: 'deploy', detail: 'boom' })
})

test('drain waits for work added while it waits', async () => {
  let release!: () => void
  background(
    new Promise<void>((r) => (release = r)).then(() => {
      background(new Promise<void>((r) => setTimeout(r, 20)), 'second')
    }),
    'first',
  )
  const drained = drain().then(() => inFlight().length)
  release()
  assert.equal(await drained, 0)
})

test('beginShutdown makes isStopping true', () => {
  assert.equal(isStopping(), false)
  beginShutdown()
  assert.equal(isStopping(), true)
})
