import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The incident channel: keyed messages to the homelab's notification router, resolved
 * silently, and kept for retry when the router cannot take them.
 */

const root = mkdtempSync(join(tmpdir(), 'shipshape-incidents-'))
process.env.DATA_DIR = root
process.env.NOTIFY_URL = 'http://n8n.invalid/webhook/notify'
process.env.NOTIFY_TOKEN = 'k'
process.env.POLICY_FILE = join(root, 'policy.yaml')
writeFileSync(process.env.POLICY_FILE, '')
delete process.env.SMTP_URL

let up = true
const wire: Record<string, unknown>[] = []
globalThis.fetch = (async (_url: unknown, init: { body: unknown; headers: Record<string, string> }) => {
  assert.equal(init.headers.authorization, 'Bearer k')
  if (!up) throw new Error('connect ECONNREFUSED')
  wire.push(JSON.parse(String(init.body)))
  return new Response('ok', { status: 200 })
}) as unknown as typeof fetch

const { getDb } = await import('../src/db.ts')
const { notify, resolveIncident, retryPendingIncidents } = await import('../src/notify/index.ts')

after(() => rmSync(root, { recursive: true, force: true }))
beforeEach(() => {
  getDb().exec(`DELETE FROM incidents; DELETE FROM events;`)
  wire.length = 0
  up = true
})

test('a keyed alert is a firing incident from shipshape', async () => {
  await notify({ key: 'shipshape:sync', title: 'sync blocked', body: 'why', priority: 4 })
  assert.deepEqual(wire, [{ key: 'shipshape:sync', source: 'shipshape', title: 'sync blocked', message: 'why', priority: 4, status: 'firing' }])
})

test('resolving something that was never opened sends nothing', async () => {
  await resolveIncident('shipshape:deploy:never')
  assert.equal(wire.length, 0)
})

test('resolving an open incident sends one bare resolution, once', async () => {
  await notify({ key: 'shipshape:deploy:app', title: 'deploy failed', body: 'x', priority: 4 })
  await resolveIncident('shipshape:deploy:app')
  await resolveIncident('shipshape:deploy:app')
  assert.equal(wire.length, 2)
  assert.deepEqual(wire[1], { key: 'shipshape:deploy:app', source: 'shipshape', status: 'resolved' })
})

test('an unkeyed message is a one-shot event', async () => {
  await notify({ title: 'note', body: 'y' })
  assert.equal(wire[0]!.status, 'event')
  assert.equal(getDb().prepare(`SELECT COUNT(*) c FROM incidents`).get()!.c, 0)
})

test('a sink only hears the events it asks for', async () => {
  writeFileSync(process.env.POLICY_FILE!, 'notify:\n  sinks:\n    - { type: webhook, events: [decision] }\n')
  await notify({ key: 'shipshape:sync', title: 'sync blocked', body: 'why', priority: 4 })
  assert.equal(wire.length, 0, 'a system message is not a decision')
  await notify({ key: 'shipshape:decision:x', title: 'x 1 -> 2', body: 'Ship?', priority: 3, eventClass: 'decision' })
  assert.equal(wire.length, 1)
  assert.equal(wire[0]!.key, 'shipshape:decision:x')
  writeFileSync(process.env.POLICY_FILE!, '')
})

test('with no sinks configured nothing is sent', async () => {
  writeFileSync(process.env.POLICY_FILE!, 'notify:\n  sinks: []\n')
  await notify({ key: 'shipshape:sync', title: 'sync blocked', body: 'why' })
  assert.equal(wire.length, 0)
  writeFileSync(process.env.POLICY_FILE!, '')
})

test('a send the router cannot take is retried on the next tick, latest state winning', async () => {
  up = false
  await notify({ key: 'shipshape:budget', title: 'budget spent', body: 'a', priority: 4 })
  await resolveIncident('shipshape:budget')
  assert.equal(wire.length, 0)
  up = true
  assert.equal(await retryPendingIncidents(), 1)
  assert.deepEqual(wire, [{ key: 'shipshape:budget', source: 'shipshape', status: 'resolved' }])
  assert.equal(await retryPendingIncidents(), 0)
})
