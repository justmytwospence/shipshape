import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * One card per decision, live. A decision is a stack -- everything in it waiting on you --
 * except one bump fanned out across stacks with nothing else waiting, which is one card
 * keyed by its image (nineteen sidecars, one card). The card leads with the question,
 * escalates once, and is resolved the moment the update stops waiting.
 */

const root = mkdtempSync(join(tmpdir(), 'shipshape-cards-'))
process.env.DATA_DIR = root
process.env.POLICY_FILE = join(root, 'policy.yaml')
process.env.NOTIFY_URL = 'http://n8n.invalid/webhook/notify'
process.env.NOTIFY_TOKEN = 'k'
process.env.MCP_PORT = '8082'
process.env.SHIPSHAPE_ALLOWED_ORIGIN = 'https://shipshape.example'
delete process.env.REPO_DIR
delete process.env.ANTHROPIC_API_KEY
delete process.env.OPENROUTER_API_KEY
writeFileSync(process.env.POLICY_FILE, 'paused: false\n')
after(() => rmSync(root, { recursive: true, force: true }))

const wire: any[] = []
globalThis.fetch = (async (_u: unknown, init: { body: string }) => {
  wire.push(JSON.parse(init.body))
  return new Response('ok', { status: 200 })
}) as unknown as typeof fetch

const { getDb } = await import('../src/db.ts')
const { currentDecisions, cardFor, syncDecisionCards, resetDecisionCards, DECISION_PREFIX } = await import('../src/notify/decisions.ts')

const AG = 'ghcr.io/agentgateway/agentgateway'

function add(stack: string, service: string, tier: string, o: { image?: string; to?: string; from?: string; since?: string | null; state?: string } = {}): number {
  return Number(
    getDb()
      .prepare(
        `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state, detected_at, updated_at, decision_since)
         VALUES (?, ?, ?, ?, ?, 'minor', ?, ?, ?, ?, ?)`,
      )
      .run(stack, service, `${o.image ?? AG}:${o.from ?? 'v1.6.0'}`, o.from ?? 'v1.6.0', o.to ?? 'v1.7.0', tier, o.state ?? 'detected', new Date().toISOString(), new Date().toISOString(), o.since ?? null)
      .lastInsertRowid,
  )
}

beforeEach(() => {
  getDb().exec(`DELETE FROM updates; DELETE FROM images; DELETE FROM verdicts; DELETE FROM proposals; DELETE FROM incidents; DELETE FROM prs`)
  wire.length = 0
  resetDecisionCards()
  writeFileSync(process.env.POLICY_FILE!, 'paused: false\n')
})

test('nineteen services on one bump are one decision, and one card', () => {
  for (let i = 0; i < 19; i++) add(`s${i}-mcp`, `s${i}-mcp-auth`, 'ask')
  const ds = currentDecisions()
  assert.equal(ds.length, 1)
  assert.equal(ds[0]!.members.length, 19)
  const c = cardFor(ds[0]!)
  assert.equal(c.key, `${DECISION_PREFIX}ghcr.io/agentgateway/agentgateway`)
  assert.equal(c.title, 'agentgateway v1.6.0 → v1.7.0 · 19 services')
})

test('a lone service is named by itself', () => {
  add('books', 'shelfmark', 'ask', { image: 'ghcr.io/x/shelfmark' })
  assert.equal(cardFor(currentDecisions()[0]!).title, 'books/shelfmark v1.6.0 → v1.7.0')
})

test('the first line is the question, the other holds follow, and the review summary closes', () => {
  const id = add('a', 'a-auth', 'ask')
  getDb()
    .prepare(`INSERT INTO verdicts (image, from_tag, to_tag, recommendation, confidence, summary, migration_steps, created_at) VALUES (?, 'v1.6.0', 'v1.7.0', 'approve', 'high', 'Session ids are now encrypted;  clients reconnect once.', '["rename X"]', 'now')`)
    .run(`${AG}:v1.6.0`)
  const lines = cardFor(currentDecisions()[0]!).body.split('\n')
  assert.equal(lines[0], 'Ship? this service always asks')
  assert.ok(lines.includes('- Needs: rename X'))
  assert.equal(lines.at(-1), 'Session ids are now encrypted; clients reconnect once.')
  void id
})

test('the taps are ship, snooze, always ship, skip -- and always ship only when every hold can be waived', () => {
  add('a', 'a-auth', 'ask')
  const waivable = cardFor(currentDecisions()[0]!).actions!.map((a) => `${a.emoji} ${a.do.verb}`)
  assert.deepEqual(waivable, ['🚀 ship', '💤 snooze', '♾️ always-ship', '⏭️ skip'])

  getDb().exec(`DELETE FROM updates`)
  add('t', 'traefik', 'lifeline', { image: 'traefik' })
  const stuck = cardFor(currentDecisions()[0]!).actions!.map((a) => a.do.verb)
  assert.deepEqual(stuck, ['ship', 'snooze', 'skip'], 'a lifeline cannot be waived, so there is nothing for always to mean')
})

test('every tap names the lowest update id of the decision', () => {
  const ids = [add('a', 'a-auth', 'ask'), add('b', 'b-auth', 'ask')]
  for (const a of cardFor(currentDecisions()[0]!).actions!) assert.equal((a.do as { update: number }).update, Math.min(...ids))
})

test('a decision is P3, and P4 once it has waited past the escalation delay', () => {
  add('a', 'a-auth', 'ask')
  assert.equal(cardFor(currentDecisions()[0]!).priority, 3)
  const long = new Date(Date.now() - 8 * 86_400_000).toISOString()
  getDb().exec(`UPDATE updates SET decision_since = '${long}'`)
  assert.equal(cardFor(currentDecisions()[0]!).priority, 4, 'after seven days')
  writeFileSync(process.env.POLICY_FILE!, 'paused: false\nnotify:\n  escalate_after_days: 30\n')
  assert.equal(cardFor(currentDecisions()[0]!).priority, 3, 'the delay is policy')
})

test('what ships on its own, is snoozed, or is frozen is not a decision', () => {
  add('ok', 'ok', 'normal', { image: 'a/ok' })
  const sn = add('sn', 'sn', 'ask', { image: 'a/sn' })
  getDb().prepare(`UPDATE updates SET snoozed_until = ? WHERE id = ?`).run(new Date(Date.now() + 86_400_000).toISOString(), sn)
  add('fz', 'fz', 'frozen', { image: 'a/fz', state: 'frozen' })
  assert.deepEqual(currentDecisions(), [])
})

test('a newer target for the same image edits the same card', () => {
  add('a', 'a-auth', 'ask', { to: 'v1.7.0' })
  const first = cardFor(currentDecisions()[0]!)
  getDb().exec(`UPDATE updates SET state = 'superseded'`)
  add('a', 'a-auth', 'ask', { from: 'v1.6.0', to: 'v1.7.1' })
  const second = cardFor(currentDecisions()[0]!)
  assert.equal(second.key, first.key)
  assert.match(second.title, /v1\.7\.1/)
})

test('syncing sends a card once, edits it when it changes, and resolves it when it stops waiting', async () => {
  const id = add('a', 'a-auth', 'ask')
  assert.equal(await syncDecisionCards(), 1)
  assert.equal(wire.length, 1)
  assert.deepEqual([wire[0].key, wire[0].status, wire[0].priority], [`${DECISION_PREFIX}stack:a`, 'firing', 3])
  assert.equal(wire[0].actions.length, 4)

  assert.equal(await syncDecisionCards(), 0, 'nothing changed, nothing sent')
  assert.equal(wire.length, 1)

  add('a', 'a-db', 'ask', { image: 'docker.io/library/postgres', from: '17', to: '18' })
  assert.equal(await syncDecisionCards(), 1)
  assert.equal(wire.length, 2, 'a changed card is re-sent, which the router edits in place')
  assert.equal(wire[1].key, `${DECISION_PREFIX}stack:a`)

  getDb().prepare(`UPDATE updates SET state = 'merged'`).run()
  assert.equal(await syncDecisionCards(), 1)
  assert.deepEqual(wire.at(-1), { key: `${DECISION_PREFIX}stack:a`, source: 'shipshape', status: 'resolved', redact: true })
  void id
})

test('a stack is one card listing each update with what holds it', () => {
  add('payments', 'btcpayserver', 'ask', { image: 'docker.io/btcpayserver/btcpayserver', from: '2.1.0', to: '2.2.0' })
  add('payments', 'payments-db', 'stateful', { image: 'docker.io/library/postgres', from: '17', to: '18' })
  add('other', 'other', 'ask', { image: 'docker.io/x/other' })
  const ds = currentDecisions()
  assert.equal(ds.length, 2)
  const c = cardFor(ds.find((d) => d.stack === 'payments')!)
  assert.equal(c.key, `${DECISION_PREFIX}stack:payments`)
  assert.equal(c.title, 'payments: 2 updates')
  const lines = c.body.split('\n')
  assert.match(lines[0]!, /^Ship these together\?/)
  assert.equal(lines[1], '- btcpayserver 2.1.0 → 2.2.0: this service always asks')
  assert.match(lines[2]!, /^- payments-db 17 → 18: /)
})

test('a stack with more waiting does not join a fan-out of one of its images', () => {
  add('s1', 's1-auth', 'ask')
  add('s2', 's2-auth', 'ask')
  add('s2', 's2-db', 'ask', { image: 'docker.io/library/postgres', from: '17', to: '18' })
  add('s3', 's3-auth', 'ask')
  const keys = currentDecisions().map((d) => d.key).sort()
  assert.deepEqual(keys, ['ghcr.io/agentgateway/agentgateway', 'stack:s2'])
  assert.equal(currentDecisions().find((d) => d.repository)!.members.length, 2)
})

test('the cards v1 posted are resolved, so nothing stale is left in the room', async () => {
  getDb().prepare(`INSERT INTO incidents (key, open, pending, attempts, updated_at) VALUES ('shipshape:update:books/shelfmark', 1, NULL, 0, 'now')`).run()
  await syncDecisionCards()
  assert.deepEqual(wire, [{ key: 'shipshape:update:books/shelfmark', source: 'shipshape', status: 'resolved', redact: true }])
})
