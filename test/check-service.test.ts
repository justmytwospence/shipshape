import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * "Check this service" re-reads its labels from git before anything else. A review reads
 * labels from the images table, so without this a label committed after the last scan
 * stayed invisible to the check and to every review it led to.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-check-'))
const repo = join(dir, 'repo')
mkdirSync(join(repo, 'docs'), { recursive: true })
process.env.DATA_DIR = join(dir, 'data')
process.env.REPO_DIR = repo
mkdirSync(process.env.DATA_DIR)

// An interpolated image has no ref, so the check touches no registry or upstream.
writeFileSync(
  join(repo, 'docs', 'docker-compose.yaml'),
  `services:
  tika:
    image: \${TIKA_IMAGE}
    labels:
      shipshape.changelog: https://example.com/CHANGES.txt
      shipshape.source: apache/tika
`,
)

const { getDb } = await import('../src/db.ts')
const { checkService } = await import('../src/web/server.ts')

after(() => rmSync(dir, { recursive: true, force: true }))

test('a check picks up labels committed since the last scan', async () => {
  getDb()
    .prepare(
      `INSERT INTO images (stack, service, compose_file, image_ref, registry, repository, last_seen_at)
       VALUES ('docs', 'tika', 'docs/docker-compose.yaml', 'apache/tika:1', 'docker.io', 'apache/tika', ?)`,
    )
    .run(new Date().toISOString())
  assert.equal(await checkService('docs', 'tika'), true)
  const row = getDb()
    .prepare(`SELECT changelog_label, source_label FROM images WHERE stack = 'docs' AND service = 'tika'`)
    .get() as { changelog_label: string | null; source_label: string | null }
  assert.equal(row.changelog_label, 'https://example.com/CHANGES.txt')
  assert.equal(row.source_label, 'apache/tika')
})

test('a service no longer in the compose files says so', async () => {
  assert.equal(await checkService('docs', 'gone'), false)
})
