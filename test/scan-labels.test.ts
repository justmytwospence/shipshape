import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A label edit reaches the database without waiting for a scan.
 *
 * The label route commits to the compose file and the labels module leaves the images
 * table to its caller -- and no caller refreshed it, so the Services pane went on showing
 * the old value, on the very page where the edit had just been made.
 */

const data = mkdtempSync(join(tmpdir(), 'shipshape-scanlabels-data-'))
const repo = mkdtempSync(join(tmpdir(), 'shipshape-scanlabels-repo-'))
process.env.DATA_DIR = data
process.env.REPO_DIR = repo
delete process.env.GITHUB_REPO
delete process.env.GITHUB_TOKEN

const { getDb } = await import('../src/db.ts')
const { refreshServiceLabels } = await import('../src/scan.ts')

after(() => {
  rmSync(data, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

const g = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()

function writeRepo(compose: string): void {
  rmSync(repo, { recursive: true, force: true })
  mkdirSync(join(repo, 'media'), { recursive: true })
  writeFileSync(join(repo, 'media', 'docker-compose.yaml'), compose)
  g(['init', '-q'])
  g(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  g(['add', '-A'])
  g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture'])
}

function seed(service: string, o: { policy?: string | null; source?: string | null } = {}): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO images (stack, service, compose_file, image_ref, registry, repository,
             current_tag, watched, policy_label, source_label, last_seen_at)
       VALUES ('media', ?, 'media/docker-compose.yaml', 'jellyfin/jellyfin:10.9.11', 'docker.io',
               'jellyfin/jellyfin', '10.9.11', 1, ?, ?, ?)`,
    )
    .run(service, o.policy ?? null, o.source ?? null, new Date().toISOString())
}

beforeEach(() => {
  getDb().exec(`DELETE FROM images`)
})

const row = (service: string) =>
  getDb()
    .prepare(`SELECT policy_label, source_label, watched FROM images WHERE stack = 'media' AND service = ?`)
    .get(service) as { policy_label: string | null; source_label: string | null; watched: number } | undefined

test("a service's labels are read from the compose file now, not at the next scan", () => {
  writeRepo(`services:
  jellyfin:
    image: jellyfin/jellyfin:10.9.11
    labels:
      shipshape.watch: "true"
      shipshape.policy: manual
      shipshape.source: jellyfin/jellyfin
`)
  seed('jellyfin', { policy: 'auto', source: null })
  assert.equal(refreshServiceLabels('media', 'jellyfin'), true)
  assert.deepEqual(row('jellyfin'), { policy_label: 'manual', source_label: 'jellyfin/jellyfin', watched: 1 })
})

test('it touches one row and deletes nothing', () => {
  writeRepo(`services:
  jellyfin:
    image: jellyfin/jellyfin:10.9.11
    labels:
      shipshape.watch: "true"
`)
  seed('jellyfin')
  // Not in this compose file. A full inventory sync from here would delete it.
  seed('elsewhere', { policy: 'manual' })
  refreshServiceLabels('media', 'jellyfin')
  assert.equal(row('elsewhere')?.policy_label, 'manual')
})

test('a service that is no longer in the compose file is reported, not invented', () => {
  writeRepo(`services:
  jellyfin:
    image: jellyfin/jellyfin:10.9.11
`)
  assert.equal(refreshServiceLabels('media', 'gone'), false)
  assert.equal(row('gone'), undefined)
})
