import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The one incident a fork can raise, and when it is quiet.
 *
 * "<service> fork can retire" goes out once, when every reference has shipped in a
 * release newer than the base, or when one was closed with no fix on the way. The same
 * scan tomorrow sends nothing; a changed conclusion edits the message; dropping the fork
 * labels resolves it silently. Waiting -- merged, not released -- says nothing at all.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-fork-notify-'))
process.env.DATA_DIR = dir
process.env.GITHUB_TOKEN = 'test-token'
process.env.NOTIFY_URL = 'http://n8n.invalid/webhook/notify'
process.env.NOTIFY_TOKEN = 'k'
delete process.env.REPO_DIR
delete process.env.POLICY_FILE
delete process.env.SMTP_URL

const { getDb } = await import('../src/db.ts')
const { setMinSpacingForTests } = await import('../src/registry/http.ts')
const { checkFork, reconcileForks, forkRefs, forkVerdict, forkIncidentKey, newestUpstreamTag } = await import('../src/forks.ts')
const { eligibleGroups, isFork } = await import('../src/gitops/pr.ts')
const { PolicySchema } = await import('../src/config.ts')
const { mockFetch, assertAllMocked, json, status } = await import('./helpers/http.ts')
const { parseImageRef } = await import('../src/images/ref.ts')
type ScannedService = import('../src/compose/scan.ts').ScannedService

setMinSpacingForTests(0)
after(() => rmSync(dir, { recursive: true, force: true }))

const API = 'https://api.github.com/repos/o/r'
const KEY = forkIncidentKey('books', 'app')

function fork(waitsOn: string[], upstream = 'ghcr.io/o/r:v1.2.0@sha256:' + 'a'.repeat(64)): ScannedService {
  return {
    stack: 'books',
    service: 'app',
    composeFile: 'books/docker-compose.yaml',
    imageRaw: 'app-fork:v1.2.0-abc',
    ref: parseImageRef(upstream),
    labels: {},
    profiles: [],
    dormant: false,
    hasBuild: true,
    watched: true,
    unwatchable: null,
    pattern: 'digest',
    tagInclude: null,
    policyLabel: null,
    sourceLabel: null,
    changelogLabel: null,
    claudeLabel: null,
    deployLabel: null,
    probePort: null,
    archivePre: null,
    networkMode: null,
    prLabel: null,
    proposeLabel: null,
    groupLabel: null,
    unknownLabels: [],
    labelProblems: [],
    fork: { upstream, waitsOn },
  }
}

function seedImage(svc: ScannedService): void {
  getDb()
    .prepare(
      `INSERT INTO images (stack, service, compose_file, image_ref, registry, repository, current_tag,
                           watched, fork_upstream, fork_waits_on, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      svc.stack,
      svc.service,
      svc.composeFile,
      svc.imageRaw,
      svc.ref!.registry,
      svc.ref!.repository,
      svc.ref!.tag,
      svc.fork?.upstream ?? null,
      svc.fork ? JSON.stringify(svc.fork.waitsOn) : null,
      new Date().toISOString(),
    )
}

beforeEach(() => {
  getDb().exec(`DELETE FROM images; DELETE FROM updates; DELETE FROM fork_refs; DELETE FROM incidents; DELETE FROM events; DELETE FROM http_cache;`)
})

/** The fake GitHub plus the fake router, which records what it was handed. */
function world(t: Parameters<typeof mockFetch>[0], gh: Parameters<typeof mockFetch>[1]) {
  const wire: Record<string, unknown>[] = []
  const h = mockFetch(t, [
    ...gh,
    {
      url: 'http://n8n.invalid/webhook/notify',
      reply: async (req) => {
        wire.push((await req.json()) as Record<string, unknown>)
        return new Response('ok', { status: 200 })
      },
    },
  ])
  return { h, wire }
}

const mergedPr = (n: number, sha: string) => [
  { url: `${API}/issues/${n}`, reply: () => json({ state: 'closed', state_reason: null, pull_request: { merged_at: 'x' } }) },
  { url: `${API}/pulls/${n}`, reply: () => json({ state: 'closed', merged: true, merge_commit_sha: sha }) },
]
const releases = (tags: string[]) => ({
  url: `${API}/releases?per_page=100&page=1`,
  reply: () => json(tags.map((t) => ({ tag_name: t, name: t, published_at: null, body: '', draft: false, prerelease: false }))),
})
const compare = (sha: string, tag: string, st: string) => ({
  url: `${API}/compare/${sha}...${encodeURIComponent(tag)}`,
  reply: () => json({ status: st }),
})

test('the verdict: every fix shipped past the base retires; a closed-unfixed one is a decision; the rest wait', () => {
  const row = (state: string, releasedIn: string | null = null) =>
    ({ ref: 'o/r#1', state, fixSha: null, releasedIn, comparedTo: null, detail: null, checkedAt: 'now' }) as never
  assert.equal(forkVerdict('v1.2.0', [row('released', 'v1.3.0')]).kind, 'retire')
  assert.equal(forkVerdict('v1.2.0', [row('released', 'v1.3.0'), row('merged-unreleased')]).kind, 'waiting')
  // Released in the base itself is not newer than the base.
  assert.equal(forkVerdict('v1.2.0', [row('released', 'v1.2.0')]).kind, 'waiting')
  assert.equal(forkVerdict('v1.2.0', [row('open')]).kind, 'waiting')
  assert.equal(forkVerdict('v1.2.0', [row('unknown')]).kind, 'waiting')
  assert.equal(forkVerdict('v1.2.0', []).kind, 'waiting')
  assert.equal(forkVerdict('v1.2.0', [row('released', 'v1.3.0'), row('closed-unfixed')]).kind, 'unfixed')
})

test('waiting is silent: a merged, unreleased fix is recorded and sends nothing', async (t) => {
  const svc = fork(['o/r#1'])
  seedImage(svc)
  const { h, wire } = world(t, [...mergedPr(1, 'f00d'), releases(['v1.2.0']), compare('f00d', 'v1.2.0', 'behind')])
  await checkFork(svc)
  assert.deepEqual(
    forkRefs('books', 'app').map((r) => [r.ref, r.state, r.comparedTo]),
    [['o/r#1', 'merged-unreleased', 'v1.2.0']],
  )
  assert.equal(wire.length, 0)
  assertAllMocked(h)
})

test('a release that carries every fix sends one incident, and the same scan tomorrow sends nothing', async (t) => {
  const svc = fork(['o/r#1'])
  seedImage(svc)
  const { h, wire } = world(t, [...mergedPr(1, 'f00d'), releases(['v1.3.0', 'v1.2.0']), compare('f00d', 'v1.3.0', 'ahead')])
  await checkFork(svc)
  assert.equal(wire.length, 1)
  const sent = wire[0]!
  assert.equal(sent.key, KEY)
  assert.equal(sent.status, 'firing')
  assert.equal(sent.priority, 3)
  assert.equal(sent.title, 'app fork can retire')
  assert.match(String(sent.message), /o\/r#1: released in v1\.3\.0/)
  assert.match(String(sent.message), /Retiring a fork/)
  assert.equal(sent.click, 'https://github.com/o/r/releases/tag/v1.3.0')
  assert.equal(forkRefs('books', 'app')[0]!.state, 'released')

  // The scan after: the same facts, no second message.
  await checkFork(svc)
  await checkFork(svc)
  assert.equal(wire.length, 1)
  assertAllMocked(h)
})

test('a reference closed without a fix sends the other sentence, once', async (t) => {
  const svc = fork(['o/r#1', 'o/r#2'])
  seedImage(svc)
  const { h, wire } = world(t, [
    { url: `${API}/issues/1`, reply: () => json({ state: 'open', state_reason: null, pull_request: null }) },
    { url: `${API}/issues/2`, reply: () => json({ state: 'closed', state_reason: 'not_planned', pull_request: null }) },
    releases(['v1.2.0']),
  ])
  await checkFork(svc)
  await checkFork(svc)
  assert.equal(wire.length, 1)
  assert.equal(wire[0]!.title, 'app fork has no upstream fix')
  assert.match(String(wire[0]!.message), /o\/r#2: closed without a fix/)
  assert.doesNotMatch(String(wire[0]!.message), /o\/r#1/)
  assertAllMocked(h)
})

test('a changed conclusion edits the message under the same key', async (t) => {
  const svc = fork(['o/r#1', 'o/r#2'])
  seedImage(svc)
  let second: 'behind' | 'ahead' = 'behind'
  const { h, wire } = world(t, [
    ...mergedPr(1, 'aaaa'),
    ...mergedPr(2, 'bbbb'),
    releases(['v1.3.0']),
    compare('aaaa', 'v1.3.0', 'ahead'),
    { url: `${API}/compare/bbbb...v1.3.0`, reply: () => json({ status: second }) },
  ])
  await checkFork(svc)
  assert.equal(wire.length, 0, 'one of two still waiting')
  second = 'ahead'
  getDb().exec(`DELETE FROM http_cache`)
  await checkFork(svc)
  assert.equal(wire.length, 1)
  assert.match(String(wire[0]!.message), /o\/r#1: released in v1\.3\.0\n- o\/r#2: released in v1\.3\.0/)
  assertAllMocked(h)
})

test('a failed lookup keeps what the last one found, and does not resolve an open incident', async (t) => {
  const svc = fork(['o/r#1'])
  seedImage(svc)
  let down = false
  const { h, wire } = world(t, [
    { url: `${API}/issues/1`, reply: () => (down ? status(500) : json({ state: 'closed', state_reason: null, pull_request: { merged_at: 'x' } })) },
    { url: `${API}/pulls/1`, reply: () => json({ state: 'closed', merged: true, merge_commit_sha: 'f00d' }) },
    releases(['v1.3.0']),
    compare('f00d', 'v1.3.0', 'ahead'),
  ])
  await checkFork(svc)
  assert.equal(wire.length, 1)
  down = true
  getDb().exec(`DELETE FROM http_cache`)
  await checkFork(svc)
  const r = forkRefs('books', 'app')[0]!
  assert.equal(r.state, 'released')
  assert.match(r.detail ?? '', /could not check/)
  assert.equal(wire.length, 1, 'neither re-sent nor resolved')
  assertAllMocked(h)
})

test('dropping the fork labels resolves the incident and forgets the references', async (t) => {
  const svc = fork(['o/r#1'])
  seedImage(svc)
  const { h, wire } = world(t, [...mergedPr(1, 'f00d'), releases(['v1.3.0']), compare('f00d', 'v1.3.0', 'ahead')])
  await checkFork(svc)
  assert.equal(wire.length, 1)

  // The next scan sees the service with no fork labels.
  await reconcileForks([{ ...svc, fork: null }])
  assert.equal(wire.length, 2)
  assert.deepEqual(wire[1], { key: KEY, source: 'shipshape', status: 'resolved' })
  assert.deepEqual(forkRefs('books', 'app'), [])
  assert.equal(
    (getDb().prepare(`SELECT fork_notified FROM images WHERE service = 'app'`).get() as { fork_notified: string | null }).fork_notified,
    null,
  )
  // And once more changes nothing.
  await reconcileForks([])
  assert.equal(wire.length, 2)
  assertAllMocked(h)
})

test('a service that disappears altogether is resolved too', async (t) => {
  const svc = fork(['o/r#1'])
  seedImage(svc)
  const { h, wire } = world(t, [...mergedPr(1, 'f00d'), releases(['v1.3.0']), compare('f00d', 'v1.3.0', 'ahead')])
  await checkFork(svc)
  getDb().exec(`DELETE FROM images`)
  await reconcileForks([])
  assert.equal(wire.length, 2)
  assert.equal(wire[1]!.status, 'resolved')
  assertAllMocked(h)
})

test('the newest release is the highest of what shipshape recorded and what GitHub released', async (t) => {
  const svc = fork([])
  seedImage(svc)
  getDb()
    .prepare(
      `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state, detected_at, updated_at)
       VALUES ('books','app','ghcr.io/o/r','v1.2.0','v1.4.0','minor','held','held','now','now')`,
    )
    .run()
  const h = mockFetch(t, [releases(['v1.3.0'])])
  assert.equal(await newestUpstreamTag(svc, 'o/r'), 'v1.4.0')
  // With no recorded update a digest-pinned fork would only ever see its base; the
  // repository's releases are what say it has moved on.
  getDb().exec(`DELETE FROM updates`)
  assert.equal(await newestUpstreamTag(svc, 'o/r'), 'v1.3.0')
  // An image tag that matches a release takes the release's spelling, which compare needs.
  getDb()
    .prepare(
      `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state, detected_at, updated_at)
       VALUES ('books','app','ghcr.io/o/r','v1.2.0','1.3.0','minor','held','held','now','now')`,
    )
    .run()
  assert.equal(await newestUpstreamTag(svc, 'o/r'), 'v1.3.0')
  assertAllMocked(h)
})

test('the pull request pass never picks a fork up, and the editor refuses one', () => {
  const svc = fork(['o/r#1'])
  seedImage(svc)
  getDb()
    .prepare(
      `INSERT INTO images (stack, service, compose_file, image_ref, registry, repository, current_tag, watched, last_seen_at)
       VALUES ('media','plain','media/docker-compose.yaml','x/y:1.0.0','docker.io','x/y','1.0.0',1,'now')`,
    )
    .run()
  const insert = getDb().prepare(
    `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state, detail, detected_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'minor', 'manual', 'detected', ?, 'now', 'now')`,
  )
  // A fork row that somehow reached 'detected' with a PR-able tier: still refused.
  insert.run('books', 'app', 'ghcr.io/o/r:v1.2.0', 'v1.2.0', 'v1.3.0', null)
  insert.run('media', 'plain', 'x/y:1.0.0', '1.0.0', '1.1.0', null)
  const groups = eligibleGroups(PolicySchema.parse({}))
  const members = groups.flatMap((g) => g.members.map((m) => `${m.stack}/${m.service}`))
  assert.deepEqual(members, ['media/plain'])
  assert.equal(isFork('books', 'app'), true)
  assert.equal(isFork('media', 'plain'), false)
})
