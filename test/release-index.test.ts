import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Reading a project's releases once, for everything that needs them.
 *
 * Prereleases are kept and marked rather than dropped, and pages are followed far enough to
 * reach the running version -- minuspod's first page was almost all betas.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-releases-'))
process.env.DATA_DIR = dir
process.env.GITHUB_TOKEN = 'test-token'
delete process.env.REPO_DIR

const { getDb } = await import('../src/db.ts')
const { setMinSpacingForTests, readCache } = await import('../src/registry/http.ts')
const { releaseIndex } = await import('../src/upstream/releases.ts')
const { versionKey } = await import('../src/versions/key.ts')
const { mockFetch, assertAllMocked, json, status } = await import('./helpers/http.ts')

setMinSpacingForTests(0)
after(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  getDb().exec(`DELETE FROM http_cache`)
})

const page = (n: number) => `https://api.github.com/repos/o/r/releases?per_page=100&page=${n}`
const rel = (tag: string, o: { prerelease?: boolean; draft?: boolean; body?: string } = {}) => ({
  tag_name: tag,
  name: tag,
  published_at: '2026-09-01T00:00:00Z',
  body: o.body ?? `notes for ${tag}`,
  draft: o.draft ?? false,
  prerelease: o.prerelease ?? false,
})
/** A full page of newer releases, so the reader has to decide whether to go on. */
const fullOfBetas = (major: number) => Array.from({ length: 100 }, (_, i) => rel(`v${major}.0.${99 - i}-beta.1`, { prerelease: true }))

test('drafts are dropped; prereleases are kept, marked and keyed', async (t) => {
  const h = mockFetch(t, [
    {
      url: page(1),
      reply: () => json([rel('v2.96.22', { prerelease: true }), rel('v2.96.20', { draft: true }), rel('v2.95.3')]),
    },
  ])
  const r = await releaseIndex('o/r')
  assert.ok(r.ok)
  assert.deepEqual(
    r.releases.map((x) => [x.tag, x.prerelease, x.key?.core.join('.')]),
    [
      ['v2.96.22', true, '2.96.22'],
      ['v2.95.3', false, '2.95.3'],
    ],
  )
  assert.equal(r.complete, true)
  assert.equal(h.calls.length, 1)
  assertAllMocked(h)
})

test('full pages are followed until a release at or below the running version appears', async (t) => {
  const h = mockFetch(t, [
    { url: page(1), reply: () => json(fullOfBetas(3)) },
    { url: page(2), reply: () => json([...Array.from({ length: 99 }, (_, i) => rel(`v2.9.${99 - i}`)), rel('v2.0.0')]) },
  ])
  const r = await releaseIndex('o/r', { until: versionKey('2.5.0'), maxPages: 5 })
  assert.ok(r.ok && r.complete)
  assert.equal(h.calls.length, 2, 'page 2 reached 2.5.0, so page 3 was never asked for')
  assertAllMocked(h)
})

test('the page limit is a limit, and says so', async (t) => {
  const h = mockFetch(t, [
    { url: page(1), reply: () => json(fullOfBetas(9)) },
    { url: page(2), reply: () => json(fullOfBetas(8)) },
  ])
  const r = await releaseIndex('o/r', { until: versionKey('1.0.0'), maxPages: 2 })
  assert.ok(r.ok)
  assert.equal(r.complete, false)
  assert.equal(r.releases.length, 200)
  assertAllMocked(h)
})

test('a rate limit on the first page is reported, not read as "no releases"', async (t) => {
  const h = mockFetch(t, [{ url: page(1), reply: () => status(403, { 'x-ratelimit-remaining': '0' }) }])
  const r = await releaseIndex('o/r')
  assert.equal(r.ok, false)
  assert.equal(!r.ok && r.kind, 'rate-limited')
  assertAllMocked(h)
})

test('a cached page stands in when GitHub is down, marked stale', async (t) => {
  let down = false
  const h = mockFetch(t, [
    { url: page(1), reply: () => (down ? status(502) : json([rel('v1.2.0')], { headers: { etag: '"e1"' } })) },
  ])
  await releaseIndex('o/r')
  down = true
  const r = await releaseIndex('o/r')
  assert.ok(r.ok && r.stale)
  assert.deepEqual(r.ok && r.releases.map((x) => x.tag), ['v1.2.0'])
  assertAllMocked(h)
})

test('bodies are only kept, and only cached, when asked for', async (t) => {
  const h = mockFetch(t, [{ url: page(1), reply: () => json([rel('v1.2.0', { body: 'the long notes' })]) }])
  const lean = await releaseIndex('o/r')
  assert.equal(lean.ok && lean.releases[0]!.body, '')
  assert.doesNotMatch(readCache(`github:/repos/o/r/releases?per_page=100&page=1`)!.body, /the long notes/)

  const full = await releaseIndex('o/r', { bodies: true })
  assert.equal(full.ok && full.releases[0]!.body, 'the long notes')
  assertAllMocked(h)
})
