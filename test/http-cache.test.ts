import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The response cache keeps only what can be revalidated, and a 304 says when it last was. */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-http-cache-'))
process.env.DATA_DIR = dir
process.env.GITHUB_TOKEN = 'test-token'
delete process.env.REPO_DIR

const { getDb } = await import('../src/db.ts')
const { fetchJson, setMinSpacingForTests } = await import('../src/registry/http.ts')
const { ghRequest } = await import('../src/upstream/github.ts')
const { mockFetch, assertAllMocked, json, status } = await import('./helpers/http.ts')

setMinSpacingForTests(0)
after(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => getDb().exec(`DELETE FROM http_cache`))

const OLD = '2026-01-01T00:00:00.000Z'
const row = (url: string) =>
  getDb().prepare(`SELECT etag, fetched_at FROM http_cache WHERE url = ?`).get(url) as
    | { etag: string | null; fetched_at: string }
    | undefined

test('a registry response without an ETag is not cached', async (t) => {
  const url = 'https://ghcr.io/v2/o/app/tags/list'
  const h = mockFetch(t, [{ url, reply: () => json({ tags: ['1'] }) }])
  assert.deepEqual(await fetchJson(url, { cacheKey: url }), { tags: ['1'] })
  assert.equal(row(url), undefined)
  assertAllMocked(h)
})

test('a registry response with an ETag is cached', async (t) => {
  const url = 'https://ghcr.io/v2/o/app/tags/list'
  const h = mockFetch(t, [{ url, reply: () => json({ tags: ['1'] }, { headers: { etag: '"a"' } }) }])
  await fetchJson(url, { cacheKey: url })
  assert.equal(row(url)?.etag, '"a"')
  assertAllMocked(h)
})

test('a 304 refreshes when the cached body was last confirmed', async (t) => {
  const reg = 'https://ghcr.io/v2/o/app/tags/list'
  const gh = 'github:/repos/o/r'
  const put = getDb().prepare(`INSERT INTO http_cache (url, etag, body, fetched_at) VALUES (?, '"a"', ?, ?)`)
  put.run(reg, JSON.stringify({ tags: ['1'] }), OLD)
  put.run(gh, JSON.stringify({ full_name: 'o/r' }), OLD)
  const h = mockFetch(t, [
    { url: reg, reply: () => status(304) },
    { url: 'https://api.github.com/repos/o/r', reply: () => status(304) },
  ])
  assert.deepEqual(await fetchJson(reg, { cacheKey: reg }), { tags: ['1'] })
  const r = await ghRequest<{ full_name: string }>('/repos/o/r', { cacheKey: gh })
  assert.equal(r.ok && r.fromCache, true)
  assert.ok(row(reg)!.fetched_at > OLD)
  assert.ok(row(gh)!.fetched_at > OLD)
  assertAllMocked(h)
})
