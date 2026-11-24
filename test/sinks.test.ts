import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Notification sinks. Shipshape emits messages; policy says where they go. The webhook
 * keeps its old wire format exactly; email and ntfy never edit, so
 * they speak on a first fire and an escalation and are quiet about everything else.
 */

const root = mkdtempSync(join(tmpdir(), 'shipshape-sinks-'))
process.env.DATA_DIR = root
process.env.POLICY_FILE = join(root, 'policy.yaml')
process.env.NOTIFY_URL = 'http://n8n.invalid/webhook/notify'
process.env.NOTIFY_TOKEN = 'k'
process.env.SHIPSHAPE_ACTION_SECRET = '0123456789abcdef0123456789abcdef'
process.env.SHIPSHAPE_ALLOWED_ORIGIN = 'https://shipshape.example'
process.env.MCP_PORT = '8082'
process.env.MCP_TOKEN = 'a'.repeat(32)
process.env.NTFY_TOKEN = 'tk'
delete process.env.SMTP_URL
after(() => rmSync(root, { recursive: true, force: true }))

const wire: { url: string; headers: Record<string, string>; body: any }[] = []
globalThis.fetch = (async (url: unknown, init: { body: string; headers: Record<string, string> }) => {
  wire.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) })
  return new Response('ok', { status: 200 })
}) as unknown as typeof fetch

const { getDb } = await import('../src/db/index.ts')
const { notify, activeChannels, sinkCredentials } = await import('../src/notify/index.ts')
const { sendNtfy, resetNtfySink } = await import('../src/notify/sinks/ntfy.ts')
const { sendEmailSink, resetEmailSink } = await import('../src/notify/sinks/email.ts')
const { verifyToken } = await import('../src/notify/links.ts')

const policy = (yaml: string) => writeFileSync(process.env.POLICY_FILE!, yaml)
beforeEach(() => {
  getDb().exec(`DELETE FROM incidents`)
  wire.length = 0
  resetNtfySink()
  resetEmailSink()
  policy('notify:\n  sinks:\n    - { type: webhook }\n')
})

const action = { emoji: '🚀', label: 'ship', do: { target: 'shipshape' as const, verb: 'ship', update: 7 } }
const card = { key: 'shipshape:decision:x', title: 'x 1 -> 2', body: 'Ship? this service always asks', priority: 3 as const, eventClass: 'decision' as const, actions: [action] }

test('no sinks are configured by default: nothing is sent', async () => {
  policy('')
  await notify({ key: 'shipshape:deploy:app', title: 'deploy failed', body: 'x', priority: 4, eventClass: 'broken' })
  assert.equal(wire.length, 0)
})

test('a webhook sink gets the payload the router has always been sent', async () => {
  await notify({ key: 'shipshape:deploy:app', title: 'deploy failed', body: 'x', priority: 4, eventClass: 'broken' })
  assert.deepEqual(wire.map((w) => w.body), [
    {
      key: 'shipshape:deploy:app',
      source: 'shipshape',
      title: 'deploy failed',
      message: 'x',
      priority: 4,
      status: 'firing',
      // A deploy incident always offers retry and roll back (MCP_PORT is set here).
      actions: [
        { emoji: '🔁', label: 'retry', do: { target: 'shipshape', verb: 'retry', stack: 'app' } },
        { emoji: '⏪', label: 'roll back', do: { target: 'shipshape', verb: 'rollback', stack: 'app' } },
      ],
    },
  ])
  assert.equal(wire[0]!.headers.authorization, 'Bearer k')
  assert.equal(wire[0]!.url, process.env.NOTIFY_URL)
})

test('a webhook sink can read its URL and token from other variables', async () => {
  process.env.OTHER_URL = 'http://other.invalid/hook'
  process.env.OTHER_TOKEN = 'o'
  policy('notify:\n  sinks:\n    - { type: webhook, url_env: OTHER_URL, token_env: OTHER_TOKEN }\n')
  await notify({ key: 'k', title: 't', body: 'b' })
  assert.equal(wire[0]!.url, 'http://other.invalid/hook')
  assert.equal(wire[0]!.headers.authorization, 'Bearer o')
})

test('a webhook card carries its actions through unchanged, for the router to turn into reactions', async () => {
  await notify(card)
  assert.deepEqual(wire[0]!.body.actions, [action])
})

test('a sink hears only the event classes it lists', async () => {
  policy('notify:\n  sinks:\n    - { type: webhook, events: [decision, broken] }\n')
  await notify({ ...card, key: 'a' })
  await notify({ key: 'b', title: 'sync', body: 'x', eventClass: 'system' })
  await notify({ key: 'c', title: 'cve', body: 'x', eventClass: 'security' })
  await notify({ key: 'd', title: 'failed', body: 'x', eventClass: 'broken' })
  assert.deepEqual(wire.map((w) => w.body.key), ['a', 'd'])
})

test('several sinks each get the message, and one failing does not stop the other', async () => {
  policy('notify:\n  sinks:\n    - { type: ntfy, url: "http://ntfy.invalid", topic: t }\n    - { type: webhook }\n')
  const real = globalThis.fetch
  globalThis.fetch = (async (url: unknown, init: any) => {
    if (String(url).includes('ntfy.invalid')) throw new Error('down')
    return real(url as never, init)
  }) as never
  await notify(card)
  globalThis.fetch = real
  assert.equal(wire.length, 1)
  assert.equal(wire[0]!.body.key, card.key)
})

test('ntfy gets one JSON publish, with the actions as signed view buttons', async () => {
  await sendNtfy({ type: 'ntfy', url: 'http://ntfy.invalid', topic: 'homelab', token_env: 'NTFY_TOKEN' }, card)
  const w = wire[0]!
  assert.equal(w.url, 'http://ntfy.invalid')
  assert.equal(w.headers.authorization, 'Bearer tk')
  assert.deepEqual([w.body.topic, w.body.title, w.body.priority], ['homelab', 'x 1 -> 2', 3])
  const [button] = w.body.actions
  assert.equal(button.action, 'view')
  const token = button.url.replace('https://shipshape.example/act/', '')
  assert.deepEqual(verifyToken(token, '0123456789abcdef0123456789abcdef'), { verb: 'ship', updateId: 7 })
})

test('ntfy and email speak on a first fire and an escalation, and not on repeats or resolves', async () => {
  const sink = { type: 'ntfy' as const, url: 'http://ntfy.invalid', topic: 't' }
  await sendNtfy(sink, card)
  await sendNtfy(sink, { ...card, body: 'edited' })
  assert.equal(wire.length, 1, 'an edit is not a new message')
  await sendNtfy(sink, { ...card, priority: 4 })
  assert.equal(wire.length, 2, 'an escalation is')
  await sendNtfy(sink, { key: card.key, status: 'resolved', title: '', body: '' })
  assert.equal(wire.length, 2, 'a resolve says nothing')
  await sendNtfy(sink, card)
  assert.equal(wire.length, 3, 'and the next occurrence is new')
})

test('email is skipped when SMTP is not configured, so there is no half-working state', async () => {
  await sendEmailSink(card)
  assert.equal(wire.length, 0)
  assert.deepEqual(activeChannels('decision'), ['webhook'])
})

test('with no links possible (no secret) the buttons are simply left off', async () => {
  const saved = process.env.SHIPSHAPE_ALLOWED_ORIGIN
  delete process.env.SHIPSHAPE_ALLOWED_ORIGIN
  await sendNtfy({ type: 'ntfy', url: 'http://ntfy.invalid', topic: 't' }, card)
  process.env.SHIPSHAPE_ALLOWED_ORIGIN = saved
  assert.equal(wire[0]!.body.actions, undefined)
})

test('a webhook without a token sends no Authorization header', async () => {
  process.env.OTHER_URL = 'http://hook.invalid/x'
  delete process.env.NO_SUCH_TOKEN
  policy('notify:\n  sinks:\n    - type: webhook\n      url_env: OTHER_URL\n      token_env: NO_SUCH_TOKEN\n')
  await notify(card)
  assert.equal(wire.length, 1)
  assert.equal(wire[0]!.url, 'http://hook.invalid/x')
  assert.equal(wire[0]!.headers.authorization, undefined)
  assert.deepEqual(activeChannels('decision'), ['webhook'])
})

test('the status page lists the variables each sink reads, and never their values', () => {
  policy('notify:\n  sinks:\n    - type: webhook\n    - type: ntfy\n      url: http://ntfy.invalid\n      topic: t\n      token_env: NTFY_TOKEN\n    - type: ntfy\n      url: http://ntfy.invalid\n      topic: u\n      token_env: UNSET_NTFY\n')
  delete process.env.UNSET_NTFY
  const rows = sinkCredentials()
  assert.deepEqual(rows, [
    { name: 'NOTIFY_URL', state: 'set', note: 'bearer from NOTIFY_TOKEN' },
    { name: 'NTFY_TOKEN', state: 'set', note: 'ntfy token for t' },
    { name: 'UNSET_NTFY', state: 'missing', note: 'ntfy token for u' },
  ])
  assert.ok(!JSON.stringify(rows).includes('http://n8n.invalid'))
})
