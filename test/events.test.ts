import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The same sentence repeated is one fact with a count. Two messages accounted for 83% of
 * the rows in the real log, which is what made the activity page useless for the thing it
 * exists for.
 */

let dir: string
let db: typeof import('../src/db.ts')

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shipshape-events-'))
  process.env.DATA_DIR = dir
  delete process.env.REPO_DIR
  db = await import('../src/db.ts')
})

after(() => rmSync(dir, { recursive: true, force: true }))

const rows = () =>
  db
    .getDb()
    .prepare(`SELECT message, count, at, last_at FROM events ORDER BY id`)
    .all() as { message: string; count: number; at: string; last_at: string | null }[]

test('a repeated message bumps a count instead of adding a row', () => {
  db.logEvent({ level: 'info', kind: 'pr', message: 'holding 13 update(s)' })
  db.logEvent({ level: 'info', kind: 'pr', message: 'holding 13 update(s)' })
  db.logEvent({ level: 'info', kind: 'pr', message: 'holding 13 update(s)' })

  const held = rows().filter((r) => r.message === 'holding 13 update(s)')
  assert.equal(held.length, 1, 'three identical events are one row')
  assert.equal(held[0]!.count, 3)
  assert.ok(held[0]!.last_at, 'the last occurrence is timestamped')
})

test('a different level, target or detail is a different fact', () => {
  db.logEvent({ level: 'info', kind: 'scan', message: 'same words' })
  db.logEvent({ level: 'warn', kind: 'scan', message: 'same words' })
  db.logEvent({ level: 'info', kind: 'scan', message: 'same words', stack: 'immich' })
  db.logEvent({ level: 'info', kind: 'scan', message: 'same words', detail: 'because' })

  assert.equal(rows().filter((r) => r.message === 'same words').length, 4)
})

test('an old repeat starts a new row rather than reviving a stale one', () => {
  db.logEvent({ level: 'info', kind: 'sync', message: 'pushed main to origin' })
  // Age the row past the coalescing window.
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
  db.getDb()
    .prepare(`UPDATE events SET at = ?, last_at = NULL WHERE message = ?`)
    .run(old, 'pushed main to origin')

  db.logEvent({ level: 'info', kind: 'sync', message: 'pushed main to origin' })

  const pushes = rows().filter((r) => r.message === 'pushed main to origin')
  assert.equal(pushes.length, 2, 'yesterday and today are separate events')
  assert.equal(pushes[1]!.count, 1)
})
