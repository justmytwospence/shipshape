import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The MCP listener: the dashboard's reads and the operator's verbs for agents. It decides
 * no authority of its own -- a verb goes through the same dispatcher as a button, so what
 * `actionsFor` refuses comes back as the refusal sentence and changes nothing.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-mcp-'))
process.env.DATA_DIR = dir
delete process.env.REPO_DIR

const { getDb } = await import('../src/db.ts')
const { createMcpApp } = await import('../src/mcp/listen.ts')
const { OPERATOR_VERBS } = await import('../src/updates/operator-verbs.ts')

after(() => rmSync(dir, { recursive: true, force: true }))

const app = createMcpApp()
async function rpc(method: string, params: unknown = {}): Promise<any> {
  const r = await app.fetch(
    new Request('http://shipshape/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  )
  assert.equal(r.status, 200)
  const text = await r.text()
  const data = text.split('\n').find((l) => l.startsWith('data: '))
  return JSON.parse(data ? data.slice(6) : text)
}
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await rpc('tools/call', { name, arguments: args })).result
  return { isError: !!r.isError, body: JSON.parse(r.content[0].text) }
}

const now = () => new Date().toISOString()
function seedUpdate(state: string): number {
  return Number(
    getDb()
      .prepare(
        `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state, detail, detected_at, updated_at)
         VALUES ('app', 'web', 'example/app', '1.0.0', '1.1.0', 'minor', 'auto', ?, NULL, ?, ?)`,
      )
      .run(state, now(), now()).lastInsertRowid,
  )
}

beforeEach(() => {
  const db = getDb()
  for (const t of ['deploy_updates', 'deploys', 'pr_updates', 'prs', 'updates', 'events']) db.prepare(`DELETE FROM ${t}`).run()
})

test('the tools: reads plus the operator verbs, nothing that edits settings or labels', async () => {
  const tools = (await rpc('tools/list')).result.tools as { name: string; inputSchema: any }[]
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'activity', 'api_usage', 'check_service', 'find_package', 'get_service', 'get_update', 'inbox', 'list_exposures',
    'list_security_incidents', 'list_services', 'list_updates', 'scan_now', 'scan_status', 'stack_action',
    'update_action',
  ])
  const verbs = tools.find((t) => t.name === 'update_action')!.inputSchema.properties.verb.enum
  assert.deepEqual(verbs, [...OPERATOR_VERBS])
})

test('MCP declarations, context and guidance are complete, bounded and read-only', async (t) => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('unexpected upstream request') })
  const init = (await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).result
  assert.ok(init.capabilities.resources)
  assert.ok(init.capabilities.prompts)
  assert.match(init.instructions, /zero upstream requests/)
  const tools = (await rpc('tools/list')).result.tools
  const writes = ['scan_now', 'check_service', 'update_action', 'stack_action']
  for (const tool of tools) {
    for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) assert.equal(typeof tool.annotations[key], 'boolean', `${tool.name}.${key}`)
    assert.equal(tool.annotations.readOnlyHint, !writes.includes(tool.name), tool.name)
  }
  assert.equal(tools.find((x: any) => x.name === 'check_service').annotations.idempotentHint, false)
  const usage = (await rpc('tools/call', { name: 'api_usage', arguments: {} })).result
  assert.deepEqual(usage.structuredContent, JSON.parse(usage.content[0].text))
  assert.equal(usage.structuredContent.github.remaining, null)
  assert.equal(usage.structuredContent.docker_hub.current_remaining, 'unknown')
  assert.ok(tools.find((x: any) => x.name === 'api_usage').outputSchema)
  const resources = (await rpc('resources/list')).result.resources
  assert.deepEqual(resources.map((r: any) => r.uri).sort(), ['shipshape://status', 'shipshape://usage'])
  for (const resource of resources) {
    const body = (await rpc('resources/read', { uri: resource.uri })).result
    assert.ok(body.contents[0].text.length < 120000)
  }
  const templates = (await rpc('resources/templates/list')).result.resourceTemplates
  assert.equal(templates.length, 2)
  const id = seedUpdate('held')
  const update = (await rpc('resources/read', { uri: `shipshape://updates/${id}` })).result
  assert.ok(JSON.parse(update.contents[0].text).allowed_verbs.includes('open-pr'))
  assert.ok((await rpc('resources/read', { uri: 'shipshape://updates/not-an-id' })).error)
  const prompts = (await rpc('prompts/list')).result.prompts
  assert.deepEqual(prompts.map((p: any) => p.name), ['review-update'])
  const prompt = (await rpc('prompts/get', { name: 'review-update', arguments: { id: String(id) } })).result
  assert.match(prompt.messages[0].content.text, /Do not run an action/)
  assert.ok((await rpc('prompts/get', { name: 'review-update', arguments: { id: '../escape' } })).error)
  assert.equal(requests, 0)
  assert.equal(getDb().prepare(`SELECT state FROM updates WHERE id = ?`).get(id).state, 'held')
})

test('get_update says which verbs are allowed now', async () => {
  const id = seedUpdate('held')
  const { isError, body } = await call('get_update', { id })
  assert.equal(isError, false)
  assert.equal(body.id, id)
  assert.ok(Array.isArray(body.allowed_verbs))
  assert.ok(body.allowed_verbs.includes('open-pr'))
  assert.ok(!body.allowed_verbs.includes('rollback'))
})

test('a verb actionsFor refuses comes back as the refusal and changes nothing, and is logged', async () => {
  const id = seedUpdate('held')
  const { isError, body } = await call('update_action', { id, verb: 'rollback' })
  assert.equal(isError, true)
  assert.equal(body.ok, false)
  assert.ok(body.message.length > 0)
  const row = getDb().prepare(`SELECT state FROM updates WHERE id = ?`).get(id) as { state: string }
  assert.equal(row.state, 'held')
  const ev = getDb().prepare(`SELECT message FROM events WHERE message LIKE '%via MCP'`).get() as { message: string }
  assert.equal(ev.message, `rollback on update ${id} requested via MCP`)
})

test('an allowed verb acts: skip dismisses the update for good', async () => {
  const id = seedUpdate('held')
  const { isError, body } = await call('update_action', { id, verb: 'skip' })
  assert.equal(isError, false, body.message)
  const row = getDb().prepare(`SELECT state FROM updates WHERE id = ?`).get(id) as { state: string }
  assert.equal(row.state, 'skipped')
})

test('a verb not offered is rejected by the schema', async () => {
  const id = seedUpdate('held')
  const r = (await rpc('tools/call', { name: 'update_action', arguments: { id, verb: 'set-policy' } })).result
  assert.equal(r.isError, true)
})

test('stack_action with no deploy says so', async () => {
  const { isError, body } = await call('stack_action', { stack: 'nothing', verb: 'retry' })
  assert.equal(isError, true)
  assert.deepEqual(body, { ok: false, message: 'there is no deploy of nothing to retry' })
})

test('unknown things are errors, not empty answers', async () => {
  assert.equal((await call('get_update', { id: 999999 })).isError, true)
  assert.equal((await call('get_service', { stack: 'no', service: 'such' })).isError, true)
})
