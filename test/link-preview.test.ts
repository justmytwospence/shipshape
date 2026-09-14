import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as dns from 'node:dns'

/**
 * What the link dialog shows before it offers to write anything.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-preview-'))
process.env.DATA_DIR = dir
delete process.env.REPO_DIR
delete process.env.GITHUB_TOKEN

const { getDb } = await import('../src/db.ts')
const { setMinSpacingForTests } = await import('../src/registry/http.ts')
const { previewLink } = await import('../src/resolver/preview.ts')
const { mockFetch, assertAllMocked, json, text, status } = await import('./helpers/http.ts')

setMinSpacingForTests(0)
after(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  getDb().exec(`DELETE FROM http_cache; DELETE FROM images; DELETE FROM resolutions;`)
  getDb()
    .prepare(
      `INSERT INTO images (stack, service, compose_file, image_ref, registry, repository, current_tag, watched, last_seen_at)
       VALUES ('media', 'jellyfin', 'media/docker-compose.yaml', 'jellyfin/jellyfin:10.9.11', 'docker.io', 'jellyfin/jellyfin', '10.9.11', 1, ?)`,
    )
    .run(new Date().toISOString())
})

const none = { source: null, changelog: null }
const ask = (o: { source?: string; changelog?: string; current?: { source: string | null; changelog: string | null } }) =>
  previewLink({ stack: 'media', service: 'jellyfin', source: o.source ?? '', changelog: o.changelog ?? '', current: o.current ?? none })

test('a repository is shown as GitHub names it, with its releases and the running version', async (t) => {
  const h = mockFetch(t, [
    { url: 'https://api.github.com/repos/JellyFin/Jellyfin', reply: () => json({ full_name: 'jellyfin/jellyfin', fork: false, archived: false }) },
    {
      url: 'https://api.github.com/repos/jellyfin/jellyfin/releases?per_page=100&page=1',
      reply: () => json([
        { tag_name: 'v10.10.0', prerelease: false, draft: false },
        { tag_name: 'v10.9.11', prerelease: false, draft: false },
      ]),
    },
  ])
  const p = await ask({ source: 'https://github.com/JellyFin/Jellyfin' })
  assert.equal(p.source?.repo, 'jellyfin/jellyfin')
  assert.deepEqual(p.source?.releases, { count: 2, newest: 'v10.10.0', newestPrerelease: false })
  assert.equal(p.source?.runningRelease, 'v10.9.11')
  assert.equal(p.writable, true)
  assert.equal(p.values.source, 'jellyfin/jellyfin', 'written as GitHub names it')
  assertAllMocked(h)
})

test('a repository GitHub does not have is not offered for writing', async (t) => {
  const h = mockFetch(t, [{ url: 'https://api.github.com/repos/jellyfin/jellyfn', reply: () => status(404) }])
  const p = await ask({ source: 'jellyfin/jellyfn' })
  assert.equal(p.source?.ok, false)
  assert.match(p.source?.reason ?? '', /GitHub has no repository jellyfin\/jellyfn/)
  assert.equal(p.writable, false)
  assertAllMocked(h)
})

test('GitHub being unavailable is said, and does not stop a write that needs no network', async (t) => {
  const h = mockFetch(t, [{ url: 'https://api.github.com/repos/jellyfin/jellyfin', reply: () => status(503) }])
  const p = await ask({ source: 'jellyfin/jellyfin' })
  assert.equal(p.source?.checked, false)
  assert.match(p.source?.reason ?? '', /could not be asked/)
  assert.equal(p.writable, true)
  assertAllMocked(h)
})

test('an unchanged box previews nothing, and an emptied one previews a removal', async (t) => {
  const h = mockFetch(t, [])
  const same = await ask({ source: 'jellyfin/jellyfin', current: { source: 'jellyfin/jellyfin', changelog: null } })
  assert.equal(same.source, null)
  assert.equal(same.writable, false)

  const removed = await ask({ source: '', current: { source: 'jellyfin/jellyfin', changelog: null } })
  assert.equal(removed.source?.removing, true)
  assert.equal(removed.writable, true)
  assert.equal(removed.values.source, '')
  assert.equal(h.calls.length, 0, 'a removal fetches nothing')
})

test('a notes link shows what was read, and whether the running version has a section', async (t) => {
  t.mock.method(dns.promises, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }])
  const h = mockFetch(t, [
    {
      url: 'https://notes.example/jellyfin.md',
      reply: () => text('# Changes\n## 10.9.11\n- Fixed subtitles\n## 10.9.10\n- Older', { headers: { 'content-type': 'text/markdown' } }),
    },
  ])
  const p = await ask({ changelog: 'https://notes.example/jellyfin.md' })
  assert.equal(p.changelog?.sections, 2)
  assert.equal(p.changelog?.runningSection, true)
  assert.equal(p.changelog?.excerpt, '- Fixed subtitles')
  assert.equal(p.writable, true)
  assertAllMocked(h)
})

test('a refused notes link is marked, fetched from nowhere, and not writable', async (t) => {
  const h = mockFetch(t, [])
  const p = await ask({ changelog: 'http://notes.example/jellyfin.md' })
  assert.equal(p.changelog?.ok, false)
  assert.match(p.changelog?.reason ?? '', /only https/)
  assert.equal(p.writable, false)
  assert.equal(h.calls.length, 0)
})
