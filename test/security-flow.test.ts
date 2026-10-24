import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The security path end to end, with no network, no docker and no model: the feed as it
 * stood on 2026-10-24, extractions supplied by hand, inventories written straight into
 * the tables syft would fill.
 */

const repo = mkdtempSync(join(tmpdir(), 'shipshape-security-repo-'))
const data = mkdtempSync(join(tmpdir(), 'shipshape-security-data-'))
process.env.REPO_DIR = repo
process.env.DATA_DIR = data
process.env.SELF_STACK = 'shipshape'
process.env.NOTIFY_URL = 'http://n8n.invalid/webhook/notify'
process.env.NOTIFY_TOKEN = 'k'
process.env.ANTHROPIC_API_KEY = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.POLICY_FILE
delete process.env.MCP_PORT

function writePolicy(security: string): void {
  mkdirSync(join(repo, 'shipshape', 'config'), { recursive: true })
  writeFileSync(join(repo, 'shipshape', 'config', 'policy.yaml'), `paused: false\nsecurity:\n${security}\n`)
}
writePolicy('  mode: on\n  auto_merge: true')
mkdirSync(join(repo, 'immich'), { recursive: true })
writeFileSync(
  join(repo, 'immich', 'docker-compose.yaml'),
  `services:
  immich-server:
    image: ghcr.io/immich-app/immich-server:v3.3.3
    labels:
      traefik.enable: true
      traefik.http.routers.immich.rule: Host(\`photos.example.com\`)
  immich-machine-learning:
    image: ghcr.io/immich-app/immich-machine-learning:v3.3.3
`,
)

const wire: Record<string, unknown>[] = []
globalThis.fetch = (async (_url: unknown, init: { body: unknown }) => {
  wire.push(JSON.parse(String(init.body)))
  return new Response('ok', { status: 200 })
}) as unknown as typeof fetch

const { getDb } = await import('../src/db.ts')
const { loadPolicy } = await import('../src/config.ts')
const { parseIndex, storeIncidents } = await import('../src/security/feed.ts')
const { runExtraction, normaliseTargets, incidentTargets } = await import('../src/security/extract.ts')
const { computeExposures, recordExposures, verifyFixes, securityFixFor, syncSecurityCards, candidateRef, isPublic, priorityOf } =
  await import('../src/security/act.ts')
const { packagesOf } = await import('../src/security/sbom.ts')

after(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(data, { recursive: true, force: true })
})

const fixture = JSON.parse(readFileSync(new URL('./fixtures/pwnwatch/incidents.json', import.meta.url), 'utf8')) as unknown

const NODE_TARGETS = {
  applicable: true,
  targets: [
    {
      ecosystem: 'binary',
      names: ['node'],
      affected: [{ lt: '22.23.4' }, { gte: '23.0.0', lt: '24.22.1' }, { gte: '25.0.0', lt: '26.12.1' }],
      fixed: ['22.23.4', '24.22.1', '26.12.1'],
    },
    { ecosystem: 'pypi', names: ['brotli', 'brotlicffi'], affected: [{ gte: '1.0.3', lt: '1.2.1' }], fixed: ['1.2.1'] },
  ],
}

function inventory(imageId: string, pkgs: [string, string, string][]): void {
  const db = getDb()
  db.prepare(`INSERT OR REPLACE INTO sbom_images (image_id, ref, scanned_at, error, packages) VALUES (?, ?, ?, NULL, ?)`).run(
    imageId,
    imageId,
    new Date().toISOString(),
    pkgs.length,
  )
  for (const [type, name, version] of pkgs) {
    db.prepare(`INSERT INTO sbom_packages (image_id, type, name, version) VALUES (?, ?, ?, ?)`).run(imageId, type, name, version)
  }
}

beforeEach(() => {
  wire.length = 0
})

test('the feed stores live incidents in the followed categories, once per updatedAt', () => {
  const { incidents, malformed } = parseIndex(fixture)
  assert.equal(malformed, 0)
  assert.equal(incidents.length, 5)
  assert.equal(storeIncidents(incidents, ['patch', 'supply-chain']), 5)
  // Nothing moved: nothing re-stored.
  assert.equal(storeIncidents(incidents, ['patch', 'supply-chain']), 0)
  // A category not followed is not taken in.
  const db = getDb()
  db.exec(`DELETE FROM security_incidents`)
  assert.equal(storeIncidents(incidents, ['supply-chain']), 0)
  assert.equal(storeIncidents(incidents, ['patch']), 5)
})

test('the model output is cleaned: unknown ecosystems, empty ranges and appliances drop out', () => {
  const r = normaliseTargets({
    applicable: true,
    targets: [
      { ecosystem: 'binary', names: ['Node'], affected: [{ lt: '22.23.4' }], fixed: [] },
      { ecosystem: 'firmware', names: ['fortios'], affected: [{ lt: '7.0' }], fixed: [] },
      { ecosystem: 'npm', names: ['x'], affected: [{}], fixed: [] },
      { ecosystem: 'npm', names: ['y'], affected: [{ lt: 'latest' }], fixed: [] },
    ],
  })
  assert.deepEqual(r.targets.map((t) => t.names), [['node']])
  assert.equal(normaliseTargets({ applicable: false, targets: NODE_TARGETS.targets }).targets.length, 0)
})

test('extraction runs once per version text, through the injected reader', async () => {
  let calls = 0
  const r = await runExtraction(async (_system, user) => {
    calls++
    if (/Node2Shell/.test(user)) return { input: NODE_TARGETS }
    if (/Plex/.test(user)) {
      return { input: { applicable: true, targets: [{ ecosystem: 'any', names: ['plexmediaserver'], affected: [{ lt: '1.43.3.10861' }], fixed: ['1.43.3.10861'] }] } }
    }
    return { input: { applicable: false, targets: [] } }
  }, 10)
  // Postiz (node) and Pillow (python) are tagged with a stack, so "nothing here" is
  // doubted and read again later rather than stored.
  assert.equal(r.extracted, 3)
  assert.equal(r.failed, 2)
  assert.equal(calls, 5)
  // Again: nothing is due.
  const again = await runExtraction(async () => {
    calls++
    return { error: 'should not be called' }
  }, 10)
  assert.equal(again.extracted, 0)
  assert.equal(calls, 5)
  assert.deepEqual([...incidentTargets().keys()].sort(), ['nodejs-october-2026-security-releases', 'plex2shell-cve-2026-96652'])
})

test('a re-read that finds nothing keeps the earlier targets', async () => {
  const db = getDb()
  // The advisory's text is edited: the extraction is due again.
  db.prepare(`UPDATE security_incidents SET versions_hash = 'edited' WHERE slug = 'nodejs-october-2026-security-releases'`).run()
  const r = await runExtraction(async (_s, user) => {
    if (/Node2Shell/.test(user)) return { input: { applicable: false, targets: [] } }
    return { error: 'not due' }
  }, 10)
  assert.equal(r.extracted, 1)
  assert.ok(incidentTargets().has('nodejs-october-2026-security-releases'))
  const row = db.prepare(`SELECT targets_hash, extract_error FROM security_incidents WHERE slug = 'nodejs-october-2026-security-releases'`).get() as {
    targets_hash: string
    extract_error: string
  }
  assert.equal(row.targets_hash, 'edited')
  assert.match(row.extract_error, /kept the earlier targets/)
})

test('a targets array handed back as a JSON string is still read', () => {
  const r = normaliseTargets({ applicable: true, targets: JSON.stringify(NODE_TARGETS.targets) })
  assert.equal(r.targets.length, 2)
})

test('trust-store packages never become targets', () => {
  const r = normaliseTargets({
    applicable: true,
    targets: [
      { ecosystem: 'pypi', names: ['certifi'], affected: [{ lt: '2026.10.19' }], fixed: [] },
      { ecosystem: 'pypi', names: ['pip', 'requests'], affected: [{ lt: '9.0' }], fixed: [] },
    ],
  })
  assert.deepEqual(r.targets.map((t) => t.names), [['requests']])
})

test('exposures, verified fixes and the gate follow the inventories, not the advisory', async () => {
  const db = getDb()
  inventory('sha256:server-old', [['binary', 'node', '24.21.0'], ['npm', 'sharp', '0.34.5']])
  inventory('sha256:ml-old', [['python', 'pillow', '12.3.0'], ['binary', 'python', '3.13.16']])
  inventory('sha256:server-new', [['binary', 'node', '24.22.1'], ['npm', 'sharp', '0.34.5']])
  const now = new Date().toISOString()
  const ins = db.prepare(
    `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state, detected_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'patch', 'auto', 'pr_open', ?, ?)`,
  )
  const id = Number(ins.run('immich', 'immich-server', 'ghcr.io/immich-app/immich-server:v3.3.3', 'v3.3.3', 'v3.3.5', now, now).lastInsertRowid)
  db.prepare(`INSERT INTO security_candidates (update_id, image_ref, image_id, checked_at) VALUES (?, ?, ?, ?)`).run(
    id,
    'ghcr.io/immich-app/immich-server:v3.3.5',
    'sha256:server-new',
    now,
  )

  const running = [
    { stack: 'immich', service: 'immich-server', imageId: 'sha256:server-old', imageRef: 'x' },
    { stack: 'immich', service: 'immich-machine-learning', imageId: 'sha256:ml-old', imageRef: 'y' },
  ]
  const targets = incidentTargets()
  const found = computeExposures(targets, running)
  assert.deepEqual([...found.values()].map((f) => `${f.slug} ${f.r.service}`), ['nodejs-october-2026-security-releases immich-server'])
  assert.equal(recordExposures(found), 1)
  assert.equal(verifyFixes(targets, found), 1)

  const { policy } = loadPolicy()
  assert.equal(policy.security.mode, 'on')
  const fix = securityFixFor(id, policy)
  assert.ok(fix)
  assert.deepEqual(fix.evidence, [{ type: 'binary', name: 'node', from: '24.21.0', to: ['24.22.1'] }])

  // Off, or shadow, or auto_merge false: the gate does not see it.
  writePolicy('  mode: shadow\n  auto_merge: true')
  assert.equal(securityFixFor(id, loadPolicy().policy), null)
  writePolicy('  mode: on\n  auto_merge: false')
  assert.equal(securityFixFor(id, loadPolicy().policy), null)
  writePolicy('  mode: on\n  auto_merge: true')

  // The candidate changes under it (a retag): the claim is withdrawn on the next pass.
  db.prepare(`UPDATE security_candidates SET image_id = 'sha256:server-old' WHERE update_id = ?`).run(id)
  assert.equal(verifyFixes(targets, found), 0)
  assert.equal(securityFixFor(id, loadPolicy().policy), null)
  db.prepare(`UPDATE security_candidates SET image_id = 'sha256:server-new' WHERE update_id = ?`).run(id)
  verifyFixes(targets, found)
})

test('a card opens for exposure nobody is fixing, and resolves when it is gone', async () => {
  const db = getDb()
  // The verified fix is inside its grace period: no card yet.
  assert.equal(await syncSecurityCards(loadPolicy().policy), 0)

  // Withdraw the fix: now it waits on nobody.
  db.exec(`DELETE FROM security_fixes`)
  await syncSecurityCards(loadPolicy().policy)
  assert.equal(wire.length, 1)
  const card = wire[0]!
  assert.equal(card.key, 'shipshape:security:nodejs-october-2026-security-releases')
  assert.equal(card.status, 'firing')
  // Critical, not exploited, public router: P4.
  assert.equal(card.priority, 4)
  assert.match(String(card.message), /immich\/immich-server \(public\): node 24\.21\.0/)

  // Exposure gone: resolved, silently.
  db.exec(`DELETE FROM exposures`)
  await syncSecurityCards(loadPolicy().policy)
  assert.deepEqual(wire[1], { key: 'shipshape:security:nodejs-october-2026-security-releases', source: 'shipshape', status: 'resolved' })
})

test('helpers: candidate refs, public routers, loudness, syft output', () => {
  assert.equal(candidateRef('ghcr.io/immich-app/immich-server:v3.3.3', 'v3.3.5'), 'ghcr.io/immich-app/immich-server:v3.3.5')
  assert.equal(
    candidateRef('huginn/huginn-single-process:latest@sha256:aaa', 'latest@sha256:bbb'),
    'huginn/huginn-single-process:latest@sha256:bbb',
  )
  const svc = (labels: Record<string, string>) => ({ labels }) as never
  assert.equal(isPublic(svc({ 'traefik.enable': 'true', 'traefik.http.routers.a.rule': 'Host(`a`)' })), true)
  assert.equal(isPublic(svc({ 'traefik.enable': 'true', 'traefik.http.routers.a.rule': 'Host(`a`) && ClientIP(`10.0.0.0/8`)' })), false)
  assert.equal(isPublic(svc({ 'traefik.http.routers.a.rule': 'Host(`a`)' })), false)
  assert.equal(priorityOf('critical', true, true), 5)
  assert.equal(priorityOf('critical', false, true), 4)
  assert.equal(priorityOf('high', true, false), 4)
  assert.equal(priorityOf('critical', false, false), 3)
  assert.deepEqual(
    packagesOf({
      artifacts: [
        { type: 'binary', name: 'node', version: '22.23.4', locations: [{ path: '/usr/local/bin/node' }] },
        { type: 'binary', name: 'node', version: '22.23.4', locations: [{ path: '/usr/local/bin/node' }] },
        { type: 'npm', name: 'x' },
      ],
    }),
    [{ type: 'binary', name: 'node', version: '22.23.4', path: '/usr/local/bin/node' }],
  )
})
