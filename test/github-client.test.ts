import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The GitHub client, against a fake network.
 *
 * The point of it is the distinction the old hand-rolled fetches could not draw: a rate
 * limit, a missing repository and an outage all came back as "nothing", and the changelog
 * review was told the project "publishes no GitHub releases" when GitHub had simply said
 * "not now".
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-gh-'))
process.env.DATA_DIR = dir
process.env.GITHUB_TOKEN = 'test-token'
delete process.env.REPO_DIR

const { getDb } = await import('../src/db.ts')
const { setMinSpacingForTests, readCache } = await import('../src/registry/http.ts')
const { ghRequest, classifyFailure } = await import('../src/upstream/github.ts')
const { fetchReleases, fetchCompare } = await import('../src/changelog/github.ts')
const probe = await import('../src/registry/probe.ts')
const { mockFetch, assertAllMocked, json, status } = await import('./helpers/http.ts')

setMinSpacingForTests(0)
after(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  getDb().exec(`DELETE FROM http_cache`)
})

const REPO = 'https://api.github.com/repos/o/r'

test('a success returns the body, authenticated', async (t) => {
  const h = mockFetch(t, [{ url: REPO, reply: () => json({ full_name: 'O/R' }) }])
  const r = await ghRequest<{ full_name: string }>('/repos/o/r')
  assert.deepEqual(r, { ok: true, data: { full_name: 'O/R' }, fromCache: false })
  assert.equal(h.calls[0]!.headers.get('authorization'), 'Bearer test-token')
  assert.equal(h.calls[0]!.headers.get('accept'), 'application/vnd.github+json')
  assertAllMocked(h)
})

test('an empty token sends no authorization at all', async (t) => {
  const h = mockFetch(t, [{ url: REPO, reply: () => json({}) }])
  await ghRequest('/repos/o/r', { token: '' })
  assert.equal(h.calls[0]!.headers.get('authorization'), null)
  assertAllMocked(h)
})

test('only the trimmed body is cached', async (t) => {
  const h = mockFetch(t, [
    { url: REPO, reply: () => json({ full_name: 'O/R', description: 'x'.repeat(5000) }, { headers: { etag: '"e1"' } }) },
  ])
  const r = await ghRequest<{ name: string }>('/repos/o/r', {
    cacheKey: 'github:/repos/o/r',
    trim: (raw) => ({ name: (raw as { full_name: string }).full_name }),
  })
  assert.deepEqual(r.ok && r.data, { name: 'O/R' })
  assert.deepEqual(readCache('github:/repos/o/r'), { etag: '"e1"', body: '{"name":"O/R"}' })
  assertAllMocked(h)
})

test('a 304 is served from the cache, having sent the stored ETag', async (t) => {
  let n = 0
  const h = mockFetch(t, [
    {
      url: REPO,
      reply: (req) => {
        n++
        if (req.headers.get('if-none-match') === '"e1"') return status(304)
        return json({ full_name: 'O/R' }, { headers: { etag: '"e1"' } })
      },
    },
  ])
  await ghRequest('/repos/o/r', { cacheKey: 'k' })
  const second = await ghRequest<{ full_name: string }>('/repos/o/r', { cacheKey: 'k' })
  assert.equal(n, 2)
  assert.deepEqual(second, { ok: true, data: { full_name: 'O/R' }, fromCache: true })
  assertAllMocked(h)
})

test('the primary rate limit is named as such, with the reset time', async (t) => {
  const reset = Math.floor(Date.UTC(2026, 8, 13, 14, 5) / 1000)
  const h = mockFetch(t, [
    {
      url: REPO,
      reply: () => status(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }),
    },
  ])
  const r = await ghRequest('/repos/o/r')
  assert.equal(r.ok, false)
  assert.equal(!r.ok && r.kind, 'rate-limited')
  assert.equal(!r.ok && r.resetAt, '2026-09-13T14:05:00.000Z')
  assert.match(!r.ok ? r.detail : '', /rate limit was reached \(resets 2026-09-13T14:05:00.000Z\)/)
  assertAllMocked(h)
})

test('a secondary rate limit reads retry-after, on 403 or 429', () => {
  const now = Date.UTC(2026, 8, 13, 14, 0)
  for (const code of [403, 429]) {
    const c = classifyFailure(code, new Headers({ 'retry-after': '60' }), now)
    assert.deepEqual(c, { kind: 'rate-limited', resetAt: '2026-09-13T14:01:00.000Z' })
  }
})

test('a 403 that is not a rate limit is a refusal, and a 404 is an answer', () => {
  assert.deepEqual(classifyFailure(403, new Headers({ 'x-ratelimit-remaining': '4999' })), { kind: 'auth' })
  assert.deepEqual(classifyFailure(401, new Headers()), { kind: 'auth' })
  for (const code of [404, 410, 422]) assert.deepEqual(classifyFailure(code, new Headers()), { kind: 'not-found' })
  assert.deepEqual(classifyFailure(502, new Headers()), { kind: 'server' })
})

test('an outage serves the cached copy, marked stale', async (t) => {
  let fail = false
  const h = mockFetch(t, [
    { url: REPO, reply: () => (fail ? status(502) : json({ full_name: 'O/R' }, { headers: { etag: '"e1"' } })) },
  ])
  await ghRequest('/repos/o/r', { cacheKey: 'k' })
  fail = true
  const r = await ghRequest<{ full_name: string }>('/repos/o/r', { cacheKey: 'k' })
  assert.deepEqual(r, { ok: true, data: { full_name: 'O/R' }, fromCache: true, stale: true })
  assertAllMocked(h)
})

test('an outage with nothing cached is reported, not hidden', async (t) => {
  const h = mockFetch(t, [{ url: REPO, reply: () => status(503) }])
  const r = await ghRequest('/repos/o/r', { cacheKey: 'k' })
  assert.equal(!r.ok && r.kind, 'server')
  assertAllMocked(h)
})

test('a network error is classified, and falls back to the cache', async (t) => {
  let down = false
  const h = mockFetch(t, [
    {
      url: REPO,
      reply: () => {
        if (down) throw new TypeError('fetch failed')
        return json({ full_name: 'O/R' })
      },
    },
  ])
  const cold = await ghRequest('/repos/o/r')
  assert.equal(cold.ok, true)
  down = true
  const r = await ghRequest('/repos/o/r')
  assert.equal(!r.ok && r.kind, 'network')

  down = false
  await ghRequest('/repos/o/r', { cacheKey: 'k' })
  down = true
  const warm = await ghRequest('/repos/o/r', { cacheKey: 'k' })
  assert.equal(warm.ok && warm.stale, true)
  assertAllMocked(h)
})

test('a 404 is never papered over with an old copy', async (t) => {
  let gone = false
  const h = mockFetch(t, [{ url: REPO, reply: () => (gone ? status(404) : json({ full_name: 'O/R' })) }])
  await ghRequest('/repos/o/r', { cacheKey: 'k' })
  gone = true
  const r = await ghRequest('/repos/o/r', { cacheKey: 'k' })
  assert.equal(!r.ok && r.kind, 'not-found')
  assertAllMocked(h)
})

test('the harness fails loudly on a request nothing expected', async (t) => {
  const h = mockFetch(t, [])
  await assert.rejects(() => fetch('https://example.invalid/x'), /unmocked fetch/)
  assert.deepEqual(h.unmatched, ['GET https://example.invalid/x'])
})

// -------------------------------------------------------------------------------------
// The ported callers behave exactly as they did
// -------------------------------------------------------------------------------------

test('fetchReleases still drops drafts and prereleases and caps bodies', async (t) => {
  const h = mockFetch(t, [
    {
      url: 'https://api.github.com/repos/o/r/releases?per_page=60',
      reply: () =>
        json([
          { tag_name: 'v2', name: 'v2', published_at: 'p', body: 'y'.repeat(7000), draft: false, prerelease: false },
          { tag_name: 'v3-rc', name: null, published_at: 'p', body: 'b', draft: false, prerelease: true },
          { tag_name: 'v4', name: null, published_at: null, body: null, draft: true, prerelease: false },
        ]),
    },
  ])
  const releases = await fetchReleases('o/r')
  assert.deepEqual(
    releases.map((r) => [r.tag, r.body.length]),
    [['v2', 6000]],
  )
  assertAllMocked(h)
})

test('fetchReleases still returns nothing on any failure', async (t) => {
  const h = mockFetch(t, [{ url: /\/releases\?per_page=60$/, reply: () => status(500) }])
  assert.deepEqual(await fetchReleases('o/r'), [])
  assertAllMocked(h)
})

test('the probe still sends the token it was given and drops prereleases', async (t) => {
  const h = mockFetch(t, [
    {
      url: 'https://api.github.com/repos/o/r/releases?per_page=40',
      reply: () =>
        json([
          { tag_name: 'v2', draft: false, prerelease: false, published_at: null },
          { tag_name: 'v3-rc', draft: false, prerelease: true, published_at: null },
        ]),
    },
  ])
  const releases = await probe.fetchReleases('o/r', 'probe-token')
  assert.deepEqual(releases.map((r) => r.tag_name), ['v2'])
  assert.equal(h.calls[0]!.headers.get('authorization'), 'Bearer probe-token')
  assertAllMocked(h)
})

test('the probe still reads a refusal as no releases, and an outage as a failure', async (t) => {
  // detect.ts reports "release probing failed" only when this throws; returning [] on an
  // outage would turn it into "probing confirmed no image tags", which would be false.
  let mode: 'refuse' | 'down' = 'refuse'
  const h = mockFetch(t, [
    {
      url: /\/releases\?per_page=40$/,
      reply: () => {
        if (mode === 'down') throw new TypeError('fetch failed')
        return status(404)
      },
    },
  ])
  assert.deepEqual(await probe.fetchReleases('o/r', ''), [])
  mode = 'down'
  await assert.rejects(() => probe.fetchReleases('o/r', ''), /could not be reached/)
  assertAllMocked(h)
})

test('fetchCompare still tries the v-prefixed pair after a miss', async (t) => {
  const h = mockFetch(t, [
    { url: 'https://api.github.com/repos/o/r/compare/1.0...1.1', reply: () => status(404) },
    {
      url: 'https://api.github.com/repos/o/r/compare/v1.0...v1.1',
      reply: () => json({ commits: [{ commit: { message: 'fix: a thing\n\nbody' } }] }),
    },
  ])
  assert.deepEqual(await fetchCompare('o/r', '1.0', '1.1'), ['fix: a thing'])
  assertAllMocked(h)
})
