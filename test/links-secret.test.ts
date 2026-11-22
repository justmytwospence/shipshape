import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'shipshape-links-secret-'))
process.env.DATA_DIR = dir
process.env.SHIPSHAPE_ACTION_SECRET = 'short'
process.env.SHIPSHAPE_ALLOWED_ORIGIN = 'https://shipshape.example.test'
after(() => rmSync(dir, { recursive: true, force: true }))

const { getDb } = await import('../src/db.ts')
const { actionUrl } = await import('../src/notify/links.ts')

test('a short action secret makes no links, and says so once', () => {
  assert.equal(actionUrl('ship', 1), null)
  assert.equal(actionUrl('ship', 1), null)
  const rows = getDb()
    .prepare(`SELECT COUNT(*) c FROM events WHERE message = 'SHIPSHAPE_ACTION_SECRET is shorter than 32 characters, so no action links are sent'`)
    .get() as { c: number }
  assert.equal(rows.c, 1)
})
