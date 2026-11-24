import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * An exposure card offers the one tap that fixes it: shipping the verified fix that is
 * still waiting. The MCP listener has to be on for a tap to reach anything, so this file
 * sets it before importing (the listener's settings are read once, at import).
 */

const repo = mkdtempSync(join(tmpdir(), 'shipshape-security-cards-repo-'))
const data = mkdtempSync(join(tmpdir(), 'shipshape-security-cards-data-'))
process.env.REPO_DIR = repo
process.env.DATA_DIR = data
process.env.SELF_STACK = 'shipshape'
process.env.NOTIFY_URL = 'http://n8n.invalid/webhook/notify'
process.env.NOTIFY_TOKEN = 'k'
process.env.MCP_PORT = '8082'
process.env.MCP_TOKEN = 'a'.repeat(32)
delete process.env.POLICY_FILE

mkdirSync(join(repo, 'shipshape', 'config'), { recursive: true })
// auto_merge off: a verified fix is not left to the merge gate's grace period, so the card
// is sent at once.
writeFileSync(
  join(repo, 'shipshape', 'config', 'policy.yaml'),
  'paused: false\nnotify:\n  sinks:\n    - { type: webhook }\nsecurity:\n  mode: on\n  auto_merge: false\n',
)
mkdirSync(join(repo, 'immich'), { recursive: true })
writeFileSync(
  join(repo, 'immich', 'docker-compose.yaml'),
  'services:\n  immich-server:\n    image: ghcr.io/immich-app/immich-server:v3.3.3\n',
)

const wire: Record<string, unknown>[] = []
globalThis.fetch = (async (_url: unknown, init: { body: unknown }) => {
  wire.push(JSON.parse(String(init.body)))
  return new Response('ok', { status: 200 })
}) as unknown as typeof fetch

const { getDb } = await import('../src/db/index.ts')
const { loadPolicy } = await import('../src/config.ts')
const { parseIndex, storeIncidents } = await import('../src/security/feed.ts')
const { syncSecurityCards } = await import('../src/security/act.ts')

after(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(data, { recursive: true, force: true })
})

const SLUG = 'nodejs-october-2026-security-releases'

test('a waiting verified fix is offered as a ship tap on the exposure card', async () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/pwnwatch/incidents.json', import.meta.url), 'utf8'),
  ) as unknown
  storeIncidents(parseIndex(fixture).incidents, ['patch', 'supply-chain'])

  const db = getDb()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO exposures (slug, stack, service, type, package, installed, fixed, first_seen_at, last_seen_at)
     VALUES (?, 'immich', 'immich-server', 'binary', 'node', '24.21.0', '24.22.1', ?, ?)`,
  ).run(SLUG, now, now)
  const id = Number(
    db
      .prepare(
        `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state, detected_at, updated_at)
         VALUES ('immich', 'immich-server', 'ghcr.io/immich-app/immich-server:v3.3.3', 'v3.3.3', 'v3.3.5', 'patch', 'ask', 'detected', ?, ?)`,
      )
      .run(now, now).lastInsertRowid,
  )
  db.prepare(`INSERT INTO security_fixes (update_id, slug, evidence, verified_at) VALUES (?, ?, '[]', ?)`).run(
    id,
    SLUG,
    now,
  )

  await syncSecurityCards(loadPolicy().policy)
  assert.equal(wire.length, 1)
  const card = wire[0]!
  assert.equal(card.key, `shipshape:security:${SLUG}`)
  assert.match(String(card.message), /fix: v3\.3\.5/)
  assert.doesNotMatch(String(card.message), /#\d/)
  const actions = card.actions as { do: { verb: string; update: number } }[]
  assert.deepEqual(
    actions.map((a) => a.do),
    [{ target: 'shipshape', verb: 'ship', update: id }],
  )
})
