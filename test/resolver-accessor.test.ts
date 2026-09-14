import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The one way to ask which repository an image comes from.
 *
 * Two failures this replaces. `shipshape.source` was applied by some callers and not
 * others, so a labelled service was reviewed as if its upstream were unknown. And every
 * answer was cached forever -- a Docker Hub budget stop during the manifest walk became a
 * permanent "none".
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-resolver-'))
process.env.DATA_DIR = dir
delete process.env.REPO_DIR
delete process.env.GITHUB_TOKEN

const { getDb } = await import('../src/db.ts')
const { setMinSpacingForTests } = await import('../src/registry/http.ts')
const { sourceFor, sourceForSync, resetResolverMemo } = await import('../src/resolver/index.ts')
const { mockFetch, assertAllMocked, json, status } = await import('./helpers/http.ts')

setMinSpacingForTests(0)
after(() => rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  getDb().exec(`DELETE FROM images; DELETE FROM resolutions; DELETE FROM budgets;`)
  resetResolverMemo()
})

const HUB = { registry: 'docker.io', repository: 'ttlequals0/minuspod' }
const MANIFEST = 'https://registry-1.docker.io/v2/ttlequals0/minuspod/manifests/2.96.17-cpu'
const LSIO = 'https://api.linuxserver.io/api/v1/images?include_config=false&include_deprecated=false'

function image(
  stack: string,
  service: string,
  img: { registry: string; repository: string },
  o: { tag?: string; label?: string | null } = {},
): void {
  getDb()
    .prepare(
      `INSERT INTO images (stack, service, compose_file, image_ref, registry, repository,
                           current_tag, watched, source_label, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(stack, service, `${stack}/docker-compose.yaml`, `${img.repository}:${o.tag ?? '1.0'}`,
      img.registry, img.repository, o.tag ?? '1.0', o.label ?? null, new Date().toISOString())
}

function cached(
  img: { registry: string; repository: string },
  o: { source_url?: string | null; tier?: string; next_check_at?: string | null; resolver_version?: number } = {},
): void {
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO resolutions (registry, repository, source_url, tier, confidence, resolved_at,
                                checked_at, next_check_at, attempts, resolver_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(img.registry, img.repository, o.source_url ?? null, o.tier ?? 'none',
      o.source_url ? 'high' : null, now, now, o.next_check_at ?? null, o.resolver_version ?? 1)
}

function stored(img: { registry: string; repository: string }) {
  return getDb()
    .prepare(`SELECT source_url, tier, confidence, attempts, error, next_check_at FROM resolutions WHERE registry = ? AND repository = ?`)
    .get(img.registry, img.repository) as
    | { source_url: string | null; tier: string; confidence: string | null; attempts: number; error: string | null; next_check_at: string | null }
    | undefined
}

const past = () => new Date(Date.now() - 60_000).toISOString()
const annotated = (repo: string) =>
  json({ annotations: { 'org.opencontainers.image.source': `https://github.com/${repo}` } })

// -------------------------------------------------------------------------------------
// Labels, per image
// -------------------------------------------------------------------------------------

const N8N = { registry: 'docker.io', repository: 'n8nio/n8n' }

test("a service's own label wins over a sibling's, and the disagreement is reported", () => {
  image('n8n', 'n8n', N8N, { label: 'n8n-io/n8n' })
  image('n8n', 'n8n-import', N8N, { label: 'someone/else' })
  const s = sourceForSync(N8N, { service: { stack: 'n8n', service: 'n8n' } })
  assert.equal(s.repo, 'n8n-io/n8n')
  assert.equal(s.tier, 'label')
  assert.deepEqual(s.label?.conflicts, [{ stack: 'n8n', service: 'n8n-import', value: 'someone/else' }])
})

test('an unlabelled service shares the label of another service on the same image', () => {
  image('n8n', 'n8n', N8N, { label: 'n8n-io/n8n' })
  image('n8n', 'n8n-import', N8N)
  const s = sourceForSync(N8N, { service: { stack: 'n8n', service: 'n8n-import' } })
  assert.equal(s.repo, 'n8n-io/n8n')
  assert.deepEqual(s.label?.from, { stack: 'n8n', service: 'n8n' })
  assert.deepEqual(s.label?.conflicts, [])
  assert.match(s.detail ?? '', /on n8n\/n8n, which runs the same image/)
})

test('siblings that disagree settle the same way every time', () => {
  image('a', 'one', N8N, { label: 'x/first' })
  image('b', 'two', N8N, { label: 'x/second' })
  image('c', 'three', N8N)
  const s = sourceForSync(N8N, { service: { stack: 'c', service: 'three' } })
  assert.equal(s.repo, 'x/first')
  assert.deepEqual(s.label?.conflicts, [{ stack: 'b', service: 'two', value: 'x/second' }])
})

test('an invalid label is flagged and does not hide what was found', () => {
  image('minuspod', 'minuspod', HUB, { label: 'https://gitlab.com/o/r' })
  cached(HUB, { source_url: 'ttlequals0/MinusPod', tier: 'annotation' })
  const s = sourceForSync(HUB, { service: { stack: 'minuspod', service: 'minuspod' } })
  assert.equal(s.repo, 'ttlequals0/MinusPod')
  assert.equal(s.tier, 'annotation')
  assert.match(s.invalidLabel?.reason ?? '', /not a GitHub repository/)
})

test('the live label, when the caller passes it, beats the last scan', () => {
  image('minuspod', 'minuspod', HUB, { label: 'old/stale' })
  const svc = { stack: 'minuspod', service: 'minuspod' }
  assert.equal(sourceForSync(HUB, { service: svc, ownLabel: 'ttlequals0/MinusPod' }).repo, 'ttlequals0/MinusPod')
  assert.equal(sourceForSync(HUB, { service: svc, ownLabel: null }).repo, null)
})

test('a labelled image is never looked up, and the label is never cached', async (t) => {
  const h = mockFetch(t, [])
  image('minuspod', 'minuspod', HUB, { label: 'ttlequals0/MinusPod' })
  const s = await sourceFor(HUB, { service: { stack: 'minuspod', service: 'minuspod' } })
  assert.equal(s.repo, 'ttlequals0/MinusPod')
  assert.equal(stored(HUB), undefined)
  assert.equal(h.calls.length, 0)
  assertAllMocked(h)
})

test("signal-cli: a label beats the none that was cached before it", () => {
  const img = { registry: 'registry.gitlab.com', repository: 'packaging/signal-cli/signal-cli-native' }
  image('openclaw', 'signal-cli', img, { label: 'https://github.com/AsamK/signal-cli' })
  cached(img, { tier: 'none' })
  const s = sourceForSync(img, { service: { stack: 'openclaw', service: 'signal-cli' } })
  assert.equal(s.repo, 'AsamK/signal-cli')
  assert.equal(s.tier, 'label')
})

// -------------------------------------------------------------------------------------
// The cache
// -------------------------------------------------------------------------------------

test('the synchronous answer never touches the network', (t) => {
  const h = mockFetch(t, [])
  image('minuspod', 'minuspod', HUB)
  const s = sourceForSync(HUB, { service: { stack: 'minuspod', service: 'minuspod' } })
  assert.equal(s.repo, null)
  assert.equal(s.pending, true)
  assert.equal(h.calls.length, 0)
  assertAllMocked(h)
})

test('a curated image needs no network at all, and is kept for good', async (t) => {
  const h = mockFetch(t, [])
  const pg = { registry: 'docker.io', repository: 'library/postgres' }
  const s = await sourceFor(pg, { tag: '17' })
  assert.equal(s.repo, 'postgres/postgres')
  assert.equal(s.tier, 'override')
  assert.deepEqual({ ...stored(pg), next_check_at: stored(pg)?.next_check_at }, {
    source_url: 'postgres/postgres', tier: 'override', confidence: 'high', attempts: 0, error: null, next_check_at: null,
  })
  assertAllMocked(h)
})

test('a Docker Hub budget stop is recorded as a failure and retried, not cached as none', async (t) => {
  image('minuspod', 'minuspod', HUB, { tag: '2.96.17-cpu' })
  getDb().prepare(`INSERT INTO budgets (key, value, window, updated_at) VALUES ('dockerhub.pulls', 10, NULL, ?)`).run(new Date().toISOString())
  const h = mockFetch(t, [{ url: MANIFEST, reply: () => annotated('ttlequals0/MinusPod') }])

  const first = await sourceFor(HUB)
  assert.equal(first.repo, null)
  const row = stored(HUB)!
  assert.equal(row.tier, 'none')
  assert.equal(row.attempts, 1)
  assert.match(row.error ?? '', /budget/)
  assert.ok(Date.parse(row.next_check_at!) > Date.now(), 'retried later, not never')
  assert.equal(h.calls.length, 0, 'the budget stopped it before any request')

  // Within the backoff nothing is asked again.
  await sourceFor(HUB)
  assert.equal(h.calls.length, 0)

  // Once due, with budget to spend, the image is looked up and the failure cleared.
  getDb().exec(`UPDATE budgets SET value = 150`)
  getDb().prepare(`UPDATE resolutions SET next_check_at = ?`).run(past())
  const later = await sourceFor(HUB)
  assert.equal(later.repo, 'ttlequals0/MinusPod')
  assert.deepEqual({ tier: stored(HUB)!.tier, error: stored(HUB)!.error, attempts: stored(HUB)!.attempts }, {
    tier: 'annotation', error: null, attempts: 0,
  })
  assertAllMocked(h)
})

test('a failed lookup never downgrades a repository already found', async (t) => {
  image('minuspod', 'minuspod', HUB, { tag: '2.96.17-cpu' })
  cached(HUB, { source_url: 'ttlequals0/MinusPod', tier: 'annotation', next_check_at: past() })
  const h = mockFetch(t, [
    {
      url: MANIFEST,
      reply: () => {
        throw new TypeError('fetch failed')
      },
    },
  ])
  const s = await sourceFor(HUB)
  assert.equal(s.repo, 'ttlequals0/MinusPod')
  assert.equal(s.error, 'fetch failed')
  assert.equal(stored(HUB)!.source_url, 'ttlequals0/MinusPod')
  assertAllMocked(h)
})

test('a clean "nothing found" is kept for a week, then looked at again', async (t) => {
  image('minuspod', 'minuspod', HUB, { tag: '2.96.17-cpu' })
  let annotate = false
  const h = mockFetch(t, [
    { url: MANIFEST, reply: () => (annotate ? annotated('ttlequals0/MinusPod') : status(404)) },
  ])

  await sourceFor(HUB)
  const row = stored(HUB)!
  assert.deepEqual({ tier: row.tier, error: row.error }, { tier: 'none', error: null })
  const inDays = (Date.parse(row.next_check_at!) - Date.now()) / 86_400_000
  assert.ok(inDays > 6.9 && inDays <= 7, `next look in ${inDays} days`)

  await sourceFor(HUB)
  assert.equal(h.calls.length, 1, 'inside the week, nothing is asked again')

  annotate = true
  getDb().prepare(`UPDATE resolutions SET next_check_at = ?`).run(past())
  assert.equal((await sourceFor(HUB)).repo, 'ttlequals0/MinusPod')
  assertAllMocked(h)
})

test('rows written by an older resolver are looked at again', async (t) => {
  image('minuspod', 'minuspod', HUB, { tag: '2.96.17-cpu' })
  cached(HUB, { tier: 'none', resolver_version: 0 })
  const h = mockFetch(t, [{ url: MANIFEST, reply: () => annotated('ttlequals0/MinusPod') }])
  assert.equal((await sourceFor(HUB)).repo, 'ttlequals0/MinusPod')
  assertAllMocked(h)
})

test('a LinuxServer API outage is a failure, never the packaging repo, and is not remembered', async (t) => {
  const heimdall = { registry: 'docker.io', repository: 'linuxserver/heimdall' }
  image('heimdall', 'heimdall', heimdall, { tag: '2.8.3' })
  let up = false
  const h = mockFetch(t, [
    {
      url: LSIO,
      reply: () =>
        up
          ? json({ data: { repositories: { linuxserver: [{ name: 'heimdall', project_url: 'https://github.com/linuxserver/Heimdall' }] } } })
          : status(503),
    },
    // The manifest walk would find linuxserver/docker-heimdall. It must not be reached.
  ])

  const down = await sourceFor(heimdall)
  assert.equal(down.repo, null)
  assert.match(stored(heimdall)!.error ?? '', /LinuxServer API answered 503/)

  up = true
  getDb().prepare(`UPDATE resolutions SET next_check_at = ?`).run(past())
  const s = await sourceFor(heimdall)
  assert.equal(s.repo, 'linuxserver/Heimdall')
  assert.equal(s.tier, 'lsio')
  assert.equal(h.calls.length, 2, 'the failed fetch was not memoised')
  assertAllMocked(h)
})
