import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The MCP listener never starts without a token, and says why. */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-mcp-start-'))
process.env.DATA_DIR = dir
process.env.MCP_PORT = '18099'
delete process.env.MCP_TOKEN
after(() => rmSync(dir, { recursive: true, force: true }))

const { getDb } = await import('../src/db/index.ts')
const { startMcpServer } = await import('../src/mcp/listen.ts')
const { mcpEnabled } = await import('../src/env.ts')

test('the listener does not start without a token, and says why', () => {
  assert.equal(startMcpServer(), null)
  const row = getDb().prepare(`SELECT level, message FROM events WHERE kind = 'system'`).get() as {
    level: string
    message: string
  }
  assert.equal(row.level, 'error')
  assert.equal(row.message, 'MCP listener not started: MCP_TOKEN is not set')
})

test('card actions are not offered when the listener cannot run', () => {
  assert.equal(mcpEnabled(), false)
})
