import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The curated map: every key reachable, and a removed entry answered by the tier that
 * replaced it rather than by its old row.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-overrides-'))
process.env.DATA_DIR = dir
delete process.env.REPO_DIR
delete process.env.GITHUB_TOKEN

const { getDb } = await import('../src/db.ts')
const { setMinSpacingForTests } = await import('../src/registry/http.ts')
const { overrideKeys, sourceFor, resetResolverMemo, RESOLVER_VERSION } = await import('../src/resolver/index.ts')
const { parseImageRef } = await import('../src/images/ref.ts')
const { mockFetch, assertAllMocked, json } = await import('./helpers/http.ts')

setMinSpacingForTests(0)
after(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  getDb().exec(`DELETE FROM images; DELETE FROM resolutions; DELETE FROM http_cache;`)
  resetResolverMemo()
})

function curatedRow(repository: string, repo: string): void {
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO resolutions (registry, repository, source_url, tier, confidence, detail, resolved_at, checked_at, resolver_version)
       VALUES ('docker.io', ?, ?, 'override', 'high', 'shipshape''s curated map', ?, ?, ?)`,
    )
    .run(repository, repo, now, now, RESOLVER_VERSION)
}

test('every curated key is a form an image reference actually produces', () => {
  // `docker.io/telegraf` was one that is not: the reference normalises to library/telegraf,
  // so the entry could never be looked up.
  for (const key of overrideKeys()) {
    const ref = parseImageRef(key)
    assert.equal(`${ref.registry}/${ref.repository}`, key, key)
  }
})

test('an answer from a curated entry since removed is looked up again, and says where it came from now', async (t) => {
  curatedRow('n8nio/n8n', 'n8n-io/n8n')
  const h = mockFetch(t, [
    { url: 'https://hub.docker.com/v2/repositories/n8nio/n8n/', reply: () => json({ full_description: 'Source: https://github.com/n8n-io/n8n' }) },
    { url: 'https://api.github.com/repos/n8n-io/n8n', reply: () => json({ full_name: 'n8n-io/n8n' }) },
  ])
  const s = await sourceFor({ registry: 'docker.io', repository: 'n8nio/n8n' }, { allowBilled: false })
  assert.deepEqual([s.repo, s.tier, s.confidence], ['n8n-io/n8n', 'description', 'high'])
  assertAllMocked(h)
})

test('an answer from a curated entry still in the map costs nothing', async (t) => {
  curatedRow('library/postgres', 'postgres/postgres')
  const h = mockFetch(t, [])
  const s = await sourceFor({ registry: 'docker.io', repository: 'library/postgres' })
  assert.deepEqual([s.repo, s.tier], ['postgres/postgres', 'override'])
  assert.equal(h.calls.length, 0)
})
