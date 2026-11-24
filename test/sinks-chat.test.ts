import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Discord, Gotify and Apprise: sinks that cannot edit a message, so they speak on a first
 * fire and an escalation, and carry the card's actions as signed links.
 */

const root = mkdtempSync(join(tmpdir(), 'shipshape-sinks-chat-'))
process.env.DATA_DIR = root
process.env.POLICY_FILE = join(root, 'policy.yaml')
delete process.env.NOTIFY_URL
delete process.env.SMTP_URL
process.env.SHIPSHAPE_ACTION_SECRET = 'test-action-secret-0123456789abcdef'
process.env.SHIPSHAPE_ALLOWED_ORIGIN = 'https://shipshape.example'
process.env.DISCORD_WEBHOOK_URL = 'https://discord.invalid/api/webhooks/1/x'
process.env.GOTIFY_TOKEN = 'gt'
process.env.APPRISE_AUTH = 'u:p'
process.env.EMPTY_VAR = ''
after(() => rmSync(root, { recursive: true, force: true }))

const { getDb } = await import('../src/db/index.ts')
const { SinkSchema } = await import('../src/policy-schema.ts')
const { notify, activeChannels } = await import('../src/notify/index.ts')
const { sendDiscord, resetDiscordSink } = await import('../src/notify/sinks/discord.ts')
const { sendGotify, resetGotifySink } = await import('../src/notify/sinks/gotify.ts')
const { sendApprise, resetAppriseSink } = await import('../src/notify/sinks/apprise.ts')
const { verifyToken } = await import('../src/notify/links.ts')
const { mockFetch, assertAllMocked, status } = await import('./helpers/http.ts')

const policy = (yaml: string) => writeFileSync(process.env.POLICY_FILE!, yaml)
beforeEach(() => {
  resetDiscordSink()
  resetGotifySink()
  resetAppriseSink()
  policy('notify:\n  sinks: []\n')
})

const action = { emoji: '🚀', label: 'ship', do: { target: 'shipshape' as const, verb: 'ship', update: 7 } }
const card = {
  key: 'shipshape:decision:x',
  title: 'x 1 -> 2',
  body: 'Ship? this service always asks',
  priority: 3 as const,
  eventClass: 'decision' as const,
  click: 'https://shipshape.example/updates/7',
  actions: [action],
}

const discord = { type: 'discord' as const, url_env: 'DISCORD_WEBHOOK_URL' }
const gotify = { type: 'gotify' as const, url: 'https://gotify.invalid/', token_env: 'GOTIFY_TOKEN' }
const apprise = {
  type: 'apprise' as const,
  url: 'http://apprise.invalid:8000/notify/shipshape',
  tag: 'ops',
  auth_env: 'APPRISE_AUTH',
}

/** Every request, with its parsed body, answered 204. */
function capture(t: Parameters<typeof mockFetch>[0], reply: () => Response = () => status(204)) {
  const bodies: any[] = []
  const h = mockFetch(t, [
    {
      url: /.*/,
      reply: async (req) => {
        bodies.push(await req.json())
        return reply()
      },
    },
  ])
  return { h, bodies }
}

test('discord posts one embed with the title, the body and the signed links, and pings nobody', async (t) => {
  const { h, bodies } = capture(t)
  await sendDiscord(discord, card)
  assert.equal(h.calls[0]!.url, 'https://discord.invalid/api/webhooks/1/x')
  const b = bodies[0]
  assert.deepEqual(b.allowed_mentions, { parse: [] })
  assert.equal(b.embeds[0].title, 'x 1 -> 2')
  assert.equal(b.embeds[0].url, card.click)
  assert.match(b.embeds[0].description, /^Ship\? this service always asks/)
  assert.match(b.embeds[0].description, /\]\(https:\/\/shipshape\.example\/act\//)
  const token = /\/act\/([^)?#\s]+)/.exec(b.embeds[0].description)![1]!
  assert.deepEqual(verifyToken(decodeURIComponent(token), process.env.SHIPSHAPE_ACTION_SECRET!), {
    verb: 'ship',
    updateId: 7,
  })
  assertAllMocked(h)
})

test('discord colours a card by priority', async (t) => {
  const { bodies } = capture(t)
  await sendDiscord(discord, { ...card, key: 'a', priority: 3 })
  await sendDiscord(discord, { ...card, key: 'b', priority: 5 })
  assert.deepEqual(
    bodies.map((b) => b.embeds[0].color),
    [0x2563eb, 0xdc2626],
  )
})

test('discord is skipped when its variable is unset or not https', async (t) => {
  const { h } = capture(t)
  await sendDiscord({ type: 'discord', url_env: 'NO_SUCH_URL' }, card)
  process.env.PLAIN_URL = 'http://discord.invalid/x'
  await sendDiscord({ type: 'discord', url_env: 'PLAIN_URL' }, card)
  assert.equal(h.calls.length, 0)
  assertAllMocked(h)
})

test('a long body is cut so the links still fit', async (t) => {
  const { bodies } = capture(t)
  await sendDiscord(discord, { ...card, body: 'x'.repeat(5000) })
  const d: string = bodies[0].embeds[0].description
  assert.ok(d.length <= 4096, String(d.length))
  assert.match(d, /\[🚀 ship\]\(https:\/\/shipshape\.example\/act\/[^)]+\)$/)
})

test('gotify posts to /message with the app token, a mapped priority and the click URL', async (t) => {
  const { h, bodies } = capture(t, () => status(200))
  await sendGotify(gotify, card)
  assert.equal(h.calls[0]!.url, 'https://gotify.invalid/message')
  assert.equal(h.calls[0]!.headers.get('x-gotify-key'), 'gt')
  const b = bodies[0]
  assert.equal(b.priority, 5)
  assert.equal(b.extras['client::notification'].click.url, card.click)
  assert.equal(b.extras['client::display'].contentType, 'text/plain')
  assert.match(b.message, /🚀 ship: https:\/\/shipshape\.example\/act\//)
  assertAllMocked(h)
})

test('gotify maps priorities 1-5 onto 1, 3, 5, 8, 10', async (t) => {
  const { bodies } = capture(t, () => status(200))
  for (const p of [1, 2, 3, 4, 5] as const) await sendGotify(gotify, { ...card, key: `k${p}`, priority: p })
  assert.deepEqual(
    bodies.map((b) => b.priority),
    [1, 3, 5, 8, 10],
  )
})

test('apprise posts title, body, type and tag to the configured endpoint', async (t) => {
  const { h, bodies } = capture(t, () => status(200))
  await sendApprise(apprise, { ...card, priority: 4 })
  assert.equal(h.calls[0]!.url, 'http://apprise.invalid:8000/notify/shipshape')
  const b = bodies[0]
  assert.equal(b.title, 'x 1 -> 2')
  assert.equal(b.type, 'warning')
  assert.equal(b.tag, 'ops')
  assert.equal(b.format, 'text')
  assert.match(b.body, /^Ship\? this service always asks/)
  assertAllMocked(h)
})

test('apprise sends basic auth only when auth_env names a set variable, and is skipped when it names an empty one', async (t) => {
  const { h } = capture(t, () => status(200))
  await sendApprise(apprise, card)
  assert.equal(h.calls[0]!.headers.get('authorization'), 'Basic dTpw')
  await sendApprise({ ...apprise, auth_env: undefined }, { ...card, key: 'other' })
  assert.equal(h.calls[1]!.headers.get('authorization'), null)
  await sendApprise({ ...apprise, auth_env: 'EMPTY_VAR' }, { ...card, key: 'third' })
  assert.equal(h.calls.length, 2)
})

test('the chat sinks speak on a first fire and an escalation, not on repeats or resolves', async (t) => {
  for (const send of [
    (m: typeof card | Record<string, unknown>) => sendDiscord(discord, m as never),
    (m: typeof card | Record<string, unknown>) => sendGotify(gotify, m as never),
    (m: typeof card | Record<string, unknown>) => sendApprise(apprise, m as never),
  ]) {
    await t.test('sequence', async (t) => {
      const { h } = capture(t, () => status(200))
      await send(card)
      await send({ ...card, body: 'edited' })
      assert.equal(h.calls.length, 1, 'an edit is not a new message')
      await send({ ...card, priority: 4 })
      assert.equal(h.calls.length, 2, 'an escalation is')
      await send({ key: card.key, status: 'resolved', title: '', body: '' })
      assert.equal(h.calls.length, 2, 'a resolve says nothing')
      await send(card)
      assert.equal(h.calls.length, 3, 'and the next occurrence is new')
    })
  }
})

test('a failed send is logged and forgotten, so the next fire tries again', async (t) => {
  const { h } = capture(t, () => status(500))
  await sendDiscord(discord, card)
  const row = getDb()
    .prepare(`SELECT detail FROM events WHERE message = 'could not post to Discord' ORDER BY id DESC LIMIT 1`)
    .get() as { detail: string } | undefined
  assert.ok(row)
  assert.ok(!row.detail.includes('discord.invalid'), 'the webhook URL is the secret and is never logged')
  await sendDiscord(discord, card)
  assert.equal(h.calls.length, 2)
})

test('notify routes each sink type from the policy file', async (t) => {
  policy(
    'notify:\n  sinks:\n    - type: discord\n    - type: gotify\n      url: https://gotify.invalid\n    - type: apprise\n      url: http://apprise.invalid:8000/notify/shipshape\n',
  )
  const { h } = capture(t, () => status(200))
  await notify(card)
  assert.deepEqual(h.calls.map((c) => new URL(c.url).host).sort(), [
    'apprise.invalid:8000',
    'discord.invalid',
    'gotify.invalid',
  ])
  assertAllMocked(h)
})

test('activeChannels names each configured sink', () => {
  policy(
    'notify:\n  sinks:\n    - type: discord\n    - type: gotify\n      url: https://gotify.invalid\n    - type: apprise\n      url: http://apprise.invalid:8000/notify\n      tag: ops\n',
  )
  assert.deepEqual(activeChannels('decision'), ['Discord', 'Gotify', 'Apprise ops'])
})

test('the new sink types parse with their defaults', () => {
  assert.equal((SinkSchema.parse({ type: 'discord' }) as { url_env: string }).url_env, 'DISCORD_WEBHOOK_URL')
  assert.equal(
    (SinkSchema.parse({ type: 'gotify', url: 'https://g.invalid' }) as { token_env: string }).token_env,
    'GOTIFY_TOKEN',
  )
  assert.throws(() => SinkSchema.parse({ type: 'gotify' }))
  assert.throws(() => SinkSchema.parse({ type: 'apprise', url: 'http://a.invalid/notify', tag: '' }))
})
