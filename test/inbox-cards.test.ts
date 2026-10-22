import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** One card per update waiting on you: which rows become cards, and their lifecycle. */

const root = mkdtempSync(join(tmpdir(), 'shipshape-inbox-cards-'))
process.env.DATA_DIR = root
process.env.NOTIFY_URL = 'http://n8n.invalid/webhook/notify'
process.env.NOTIFY_TOKEN = 'k'
process.env.MCP_PORT = '8082'
delete process.env.POLICY_FILE

const wire: Record<string, any>[] = []
globalThis.fetch = (async (_u: unknown, init: { body: unknown }) => {
  wire.push(JSON.parse(String(init.body)))
  return new Response('ok', { status: 200 })
}) as unknown as typeof fetch

const { getDb } = await import('../src/db.ts')
const { syncInboxCards, waitsOnYou, cardFor } = await import('../src/notify/inbox-cards.ts')

after(() => rmSync(root, { recursive: true, force: true }))
beforeEach(() => {
  getDb().exec(`DELETE FROM incidents;`)
  wire.length = 0
})

const item = (kind: string, o: Record<string, unknown> = {}) =>
  ({
    kind,
    update: {
      id: 7, stack: 'media', service: 'jellyfin', fromTag: '10.9', toTag: '10.10', magnitude: 'minor',
      tier: 'manual', state: 'pr_open', actions: ['merge-deploy', 'skip', 'rerun-review'], primary: 'merge-deploy',
      pr: { number: 12, url: 'https://github.com/x/y/pull/12', held: null },
      verdict: { recommendation: 'approve', confidence: 'high', summary: 'Routine.', breakingChanges: [], migrationSteps: [], error: null, provisional: false },
      ...o,
    },
  }) as any

test('what waits on you', () => {
  assert.equal(waitsOnYou(item('pr-waiting'), false), true)
  assert.equal(waitsOnYou(item('pr-waiting', { tier: 'auto' }), false), false)
  assert.equal(waitsOnYou(item('pr-waiting', { tier: 'auto' }), true), true)
  assert.equal(waitsOnYou(item('on-request'), false), false)
  assert.equal(waitsOnYou(item('deploy-failed'), false), false)
  assert.equal(waitsOnYou(item('ready-to-deploy', { tier: 'attended' }), false), true)
  assert.equal(waitsOnYou(item('ready-to-deploy', { tier: 'manual' }), false), false)
})

test('a card carries its verbs as taps, primary first and skip last', () => {
  const c = cardFor(item('pr-waiting'))
  assert.equal(c.key, 'shipshape:update:media/jellyfin')
  assert.equal(c.title, 'media/jellyfin 10.9 → 10.10')
  assert.deepEqual(c.actions!.map((a) => a.emoji), ['🚀', '📖', '⏭️'])
})

test('sent once, edited only on change, resolved when it stops waiting', async () => {
  await syncInboxCards([item('pr-waiting')])
  await syncInboxCards([item('pr-waiting')])
  assert.equal(wire.length, 1)
  assert.equal(wire[0]!.priority, 2)
  await syncInboxCards([])
  assert.deepEqual(wire[1], { key: 'shipshape:update:media/jellyfin', source: 'shipshape', status: 'resolved' })
})

test('a newer version edits the same card', async () => {
  await syncInboxCards([item('pr-waiting')])
  await syncInboxCards([item('pr-waiting', { id: 8, toTag: '10.11' })])
  assert.equal(wire.length, 2)
  assert.equal(wire[1]!.key, wire[0]!.key)
  assert.equal(wire[1]!.status, 'firing')
  assert.match(wire[1]!.title, /10\.11/)
})
