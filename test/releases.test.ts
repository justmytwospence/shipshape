import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The releases feed is the updates table read for a different reason, and the two things
 * that make it a feed rather than a second worklist are pinned here: it is ordered by
 * when a release turned up rather than by how big it is, and every row can link out to a
 * changelog whether or not anything ever reviewed it.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-releases-'))
process.env.DATA_DIR = dir
process.env.GITHUB_REPO = 'you/repo'
delete process.env.REPO_DIR

const { getDb } = await import('../src/db.ts')
const { listReleases } = await import('../src/updates/queries.ts')

after(() => rmSync(dir, { recursive: true, force: true }))

const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()

let seq = 0
function addUpdate(o: {
  service: string
  magnitude: string
  state?: string
  detectedAt: string
  image?: string
}): number {
  seq++
  const info = getDb()
    .prepare(
      `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state,
                            detail, detected_at, updated_at, acked_at)
       VALUES ('media', ?, ?, ?, ?, ?, 'auto', ?, NULL, ?, ?, NULL)`,
    )
    .run(
      o.service,
      o.image ?? 'ghcr.io/acme/thing',
      `1.0.${seq}`,
      `1.1.${seq}`,
      o.magnitude,
      o.state ?? 'verified',
      o.detectedAt,
      o.detectedAt,
    )
  return Number(info.lastInsertRowid)
}

function addImage(service: string, registry: string, repository: string): void {
  getDb()
    .prepare(
      `INSERT INTO images (stack, service, compose_file, image_ref, registry, repository,
                           watched, last_seen_at)
       VALUES ('media', ?, 'docker-compose.yaml', 'ref', ?, ?, 1, ?)`,
    )
    .run(service, registry, repository, ago(1))
}

function resolve(registry: string, repository: string, sourceUrl: string): void {
  getDb()
    .prepare(
      `INSERT INTO resolutions (registry, repository, source_url, tier, resolved_at)
       VALUES (?, ?, ?, 'claude', ?)`,
    )
    .run(registry, repository, sourceUrl, ago(1))
}

test('a release feed is ordered by when it turned up, not by how big it is', () => {
  // The updates list puts majors first because a major is the thing most likely to need
  // a decision. A feed is read top to bottom, so the newest thing has to be at the top
  // even when something bigger landed last week.
  addUpdate({ service: 'old-major', magnitude: 'major', detectedAt: ago(72) })
  addUpdate({ service: 'new-patch', magnitude: 'patch', detectedAt: ago(1) })
  addUpdate({ service: 'mid-minor', magnitude: 'minor', detectedAt: ago(24) })

  const feed = listReleases()
  assert.deepEqual(
    feed.map((r) => r.service),
    ['new-patch', 'mid-minor', 'old-major'],
  )
})

test('the feed carries every state, not a slice of the pipeline', () => {
  addUpdate({ service: 'shipped', magnitude: 'minor', state: 'verified', detectedAt: ago(3) })
  addUpdate({ service: 'waiting', magnitude: 'minor', state: 'pr_open', detectedAt: ago(2) })
  addUpdate({ service: 'gone-wrong', magnitude: 'minor', state: 'failed', detectedAt: ago(4) })

  const services = new Set(listReleases().map((r) => r.service))
  for (const s of ['shipped', 'waiting', 'gone-wrong']) {
    assert.ok(services.has(s), `${s} should be in the feed`)
  }
})

test('a release links to its changelog even though nothing reviewed it', () => {
  // The common case: it applied without a pull request, so no verdict exists. The links
  // come from the image reference and the resolved source repo, so they exist anyway.
  addImage('linked', 'ghcr.io', 'acme/thing')
  resolve('ghcr.io', 'acme/thing', 'acme/thing')
  addUpdate({ service: 'linked', magnitude: 'minor', detectedAt: ago(5) })

  const row = listReleases().find((r) => r.service === 'linked')
  assert.ok(row, 'the release should be in the feed')
  assert.equal(row.verdict, null, 'this fixture has no review, which is the point')
  assert.ok(row.links.releases?.includes('acme/thing'), 'it should still link to releases')
})

test('a release whose service was deleted keeps its place in the history', () => {
  // No images row: the service is gone from the compose file. An inner join here would
  // quietly drop the releases it did have, which is history disappearing.
  addUpdate({ service: 'retired', magnitude: 'minor', detectedAt: ago(6) })

  const row = listReleases().find((r) => r.service === 'retired')
  assert.ok(row, 'a retired service keeps its releases')
  assert.equal(row.links.releases, null, 'with nothing resolved there is no changelog link')
})

test('the feed can still be narrowed by size and search', () => {
  addUpdate({ service: 'filterable', magnitude: 'major', detectedAt: ago(7) })

  const majors = listReleases({ magnitude: 'major' })
  assert.ok(majors.every((r) => r.magnitude === 'major'))
  assert.ok(majors.some((r) => r.service === 'filterable'))

  const searched = listReleases({ q: 'filterable' })
  assert.deepEqual(
    searched.map((r) => r.service),
    ['filterable'],
  )
})
