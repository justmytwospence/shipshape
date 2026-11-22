import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A repository whose branch is `master` ships to `master`, and nothing named main appears. */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-ship-branch-'))
const origin = join(dir, 'origin.git')
const live = join(dir, 'live')
process.env.DATA_DIR = join(dir, 'data')
process.env.REPO_DIR = live
process.env.GITHUB_REPO = 'me/compose'
process.env.GITHUB_TOKEN = 'x'
process.env.GIT_REMOTE_URL = origin
process.env.GIT_BRANCH = 'master'
process.env.POLICY_FILE = join(dir, 'policy.yaml')
delete process.env.NOTIFY_URL
delete process.env.ANTHROPIC_API_KEY
delete process.env.OPENROUTER_API_KEY
after(() => rmSync(dir, { recursive: true, force: true }))

const { getDb } = await import('../src/db.ts')
const { runShipPass } = await import('../src/gitops/ship.ts')
const { syncMain } = await import('../src/gitops/sync.ts')
const { setServiceLabel } = await import('../src/gitops/labels.ts')

const g = (cwd: string, args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()

function setup() {
  for (const p of [origin, live, join(dir, 'data', 'repo'), join(dir, 'seed')]) rmSync(p, { recursive: true, force: true })
  const seed = join(dir, 'seed')
  mkdirSync(join(seed, 'web'), { recursive: true })
  g(seed, ['init', '-q', '-b', 'master'])
  writeFileSync(join(seed, 'web', 'docker-compose.yaml'), 'services:\n  web:\n    image: example/web:1.0.0\n    labels:\n      shipshape.watch: "true"\n')
  g(seed, ['add', '-A'])
  g(seed, ['commit', '-qm', 'chore: fixture'])
  execFileSync('git', ['clone', '-q', '--bare', seed, origin])
  execFileSync('git', ['clone', '-q', origin, live])
  g(live, ['symbolic-ref', 'HEAD', 'refs/heads/master'])
}

function seedUpdate() {
  const db = getDb()
  db.prepare(
    `INSERT OR REPLACE INTO images (stack, service, compose_file, image_ref, registry, repository, current_tag, watched, last_seen_at)
     VALUES ('web', 'web', 'web/docker-compose.yaml', 'example/web:1.0.0', 'docker.io', 'example/web', '1.0.0', 1, 'now')`,
  ).run()
  db.prepare(
    `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state, detected_at, updated_at)
     VALUES ('web', 'web', 'example/web:1.0.0', '1.0.0', '1.0.1', 'patch', 'normal', 'detected', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run()
}

beforeEach(() => {
  const db = getDb()
  for (const t of ['deploy_updates', 'deploys', 'proposals', 'pr_updates', 'prs', 'updates', 'verdicts', 'images', 'events']) db.prepare(`DELETE FROM ${t}`).run()
  writeFileSync(process.env.POLICY_FILE!, 'paused: false\nship:\n  cooldown_days: 0\n')
})

test('a repository on master ships end to end', async () => {
  setup()
  seedUpdate()
  const r = await runShipPass()
  assert.deepEqual([r.shipped, r.decisions, r.failed], [1, 0, 0])
  const [parents, subject] = g(origin, ['log', '-1', '--format=%P|%s', 'master']).split('|')
  assert.equal(parents!.split(' ').length, 2)
  assert.equal(subject, 'chore(deps): web: bump web 1.0.0 -> 1.0.1')
  assert.equal(g(origin, ['branch', '--list']), '* master')
  assert.equal(g(live, ['rev-parse', 'HEAD']), g(origin, ['rev-parse', 'master']))
  assert.equal(g(origin, ['for-each-ref', 'refs/heads/main']), '')
})

test('a checkout on another branch pauses sync and names GIT_BRANCH', async () => {
  setup()
  g(live, ['checkout', '-q', '-b', 'main'])
  const r = await syncMain()
  assert.equal(r.status, 'paused')
  assert.match(r.status === 'paused' ? r.reason : '', /on "main", not "master".*GIT_BRANCH/)
})

test('a label edit refuses when the checkout is not on the shipshape branch', async () => {
  setup()
  seedUpdate()
  g(live, ['checkout', '-q', '-b', 'main'])
  const r = await setServiceLabel({ stack: 'web', service: 'web', key: 'class', value: 'ask' })
  assert.equal(r.ok, false)
  assert.match(r.message, /not master/)
})
