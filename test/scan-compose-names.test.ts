import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A scan that finds no compose files says so and leaves the inventory alone. */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-scan-names-'))
const repo = join(dir, 'repo')
mkdirSync(repo)
process.env.DATA_DIR = join(dir, 'data')
process.env.REPO_DIR = repo
process.env.GITHUB_REPO = 'me/compose'
process.env.POLICY_FILE = join(dir, 'policy.yaml')
writeFileSync(process.env.POLICY_FILE, 'paused: true\n')
after(() => rmSync(dir, { recursive: true, force: true }))

const { getDb } = await import('../src/db/index.ts')
const { runScan } = await import('../src/scan/index.ts')

const composeFiles = () =>
  (getDb().prepare(`SELECT value FROM budgets WHERE key = 'scan.compose_files'`).get() as { value: number } | undefined)
    ?.value

test('a repository with no compose files logs one error, records zero, and keeps the inventory', async () => {
  getDb()
    .prepare(
      `INSERT INTO images (stack, service, compose_file, image_ref, registry, repository, current_tag, watched, last_seen_at)
       VALUES ('web', 'web', 'web/compose.yaml', 'x:1', 'docker.io', 'x', '1', 1, 'then')`,
    )
    .run()
  await runScan('manual')
  assert.equal((getDb().prepare(`SELECT COUNT(*) c FROM images`).get() as { c: number }).c, 1)
  const ev = getDb()
    .prepare(`SELECT level, kind FROM events WHERE message LIKE 'no compose files found in %'`)
    .get() as { level: string; kind: string }
  assert.deepEqual([ev.level, ev.kind], ['error', 'system'])
  assert.equal(composeFiles(), 0)
})

test('a directory with two compose files logs a warning naming the ignored one', async () => {
  mkdirSync(join(repo, 'app'))
  writeFileSync(join(repo, 'app', 'compose.yaml'), 'services:\n  app:\n    image: example/app:1.0.0\n')
  writeFileSync(join(repo, 'app', 'docker-compose.yml'), 'services:\n  app:\n    image: example/app:1.0.0\n')
  await runScan('manual')
  const ev = getDb()
    .prepare(`SELECT detail FROM events WHERE message = 'app has more than one compose file; using compose.yaml'`)
    .get() as { detail: string }
  assert.match(ev.detail, /docker-compose\.yml/)
  assert.equal(composeFiles(), 1)
})
