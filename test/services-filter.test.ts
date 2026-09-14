import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The Services list's Unlinked filter: watched services whose release notes have no certain
 * source. A likely match is still unlinked -- it is the one a label would confirm.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-services-filter-'))
process.env.DATA_DIR = dir
delete process.env.REPO_DIR

const { getDb } = await import('../src/db.ts')
const { serviceRows, filterServices } = await import('../src/updates/services.ts')
const { RESOLVER_VERSION } = await import('../src/resolver/index.ts')

after(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => getDb().exec(`DELETE FROM images; DELETE FROM resolutions;`))

function image(service: string, repository: string, o: { watched?: boolean; label?: string } = {}): void {
  getDb()
    .prepare(
      `INSERT INTO images (stack, service, compose_file, image_ref, registry, repository,
                           current_tag, watched, source_label, last_seen_at)
       VALUES ('lab', ?, 'lab/docker-compose.yaml', ?, 'docker.io', ?, '1.0', ?, ?, ?)`,
    )
    .run(service, `${repository}:1.0`, repository, o.watched === false ? 0 : 1, o.label ?? null, new Date().toISOString())
}

function resolved(repository: string, source: string | null, tier: string, confidence: string | null): void {
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO resolutions (registry, repository, source_url, tier, confidence, resolved_at, checked_at, resolver_version)
       VALUES ('docker.io', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(repository, source, tier, confidence, now, now, RESOLVER_VERSION)
}

test('only watched services without a certain upstream are unlinked', () => {
  image('certain', 'acme/certain')
  resolved('acme/certain', 'acme/certain', 'annotation', 'high')
  image('likely', 'acme/likely')
  resolved('acme/likely', 'acme/likely', 'lookup', 'medium')
  image('missing', 'acme/missing')
  resolved('acme/missing', null, 'none', null)
  image('unseen', 'acme/unseen')
  image('labelled', 'acme/labelled', { label: 'acme/labelled' })
  // Written before packaging repositories were told apart: never counted as the upstream.
  image('packaged', 'linuxserver/thing')
  resolved('linuxserver/thing', 'linuxserver/docker-thing', 'annotation', 'high')
  image('ignored', 'acme/ignored', { watched: false })

  const rows = serviceRows()
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.service, r.upstream])), {
    certain: 'linked',
    likely: 'likely',
    missing: 'none',
    unseen: 'none',
    labelled: 'linked',
    packaged: 'none',
    ignored: 'none',
  })
  assert.deepEqual(
    filterServices(rows, { filter: 'unlinked' }).map((r) => r.service).sort(),
    ['likely', 'missing', 'packaged', 'unseen'],
  )
})
