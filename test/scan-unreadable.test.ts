import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A compose file with a YAML error is a typo, not a stack that was taken down. */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-scan-unreadable-'))
const repo = join(dir, 'repo')
mkdirSync(join(repo, 'app'), { recursive: true })
mkdirSync(join(repo, 'web'), { recursive: true })
process.env.DATA_DIR = join(dir, 'data')
process.env.REPO_DIR = repo
process.env.GITHUB_REPO = 'me/compose'
process.env.POLICY_FILE = join(dir, 'policy.yaml')
writeFileSync(process.env.POLICY_FILE, 'paused: true\n')
after(() => rmSync(dir, { recursive: true, force: true }))

const { getDb } = await import('../src/db.ts')
const { runScan } = await import('../src/scan.ts')
const { composeFileFor } = await import('../src/images/rows.ts')

const APP = join(repo, 'app', 'docker-compose.yaml')
const services = () =>
  (getDb().prepare(`SELECT stack || '/' || service AS s FROM images ORDER BY s`).all() as { s: string }[]).map((r) => r.s)

writeFileSync(APP, 'services:\n  api:\n    image: example/api:1.0.0\n  worker:\n    image: example/worker:1.0.0\n')
writeFileSync(join(repo, 'web', 'docker-compose.yaml'), 'services:\n  web:\n    image: example/web:1.0.0\n')

test('a compose file with a syntax error keeps its services and says so', async () => {
  await runScan('manual')
  assert.deepEqual(services(), ['app/api', 'app/worker', 'web/web'])

  writeFileSync(APP, 'services:\n  api:\n    image: example/api:1.0.0\n   worker: [\n')
  await runScan('manual')
  assert.deepEqual(services(), ['app/api', 'app/worker', 'web/web'])
  const ev = getDb()
    .prepare(`SELECT level, kind, detail FROM events WHERE message = 'compose file could not be read: app/docker-compose.yaml'`)
    .all() as { level: string; kind: string; detail: string }[]
  assert.equal(ev.length, 1)
  assert.deepEqual([ev[0]!.level, ev[0]!.kind], ['warn', 'scan'])
  assert.ok(ev[0]!.detail.length > 0)
})

test('the ship pass still finds its compose file, so its updates are not retired as removed', () => {
  assert.equal(composeFileFor('app', 'worker'), 'app/docker-compose.yaml')
})

test('once the file is deleted, its services go', async () => {
  rmSync(APP)
  await runScan('manual')
  assert.deepEqual(services(), ['web/web'])
})
