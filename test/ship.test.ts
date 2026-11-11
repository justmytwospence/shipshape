import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Shipping, against real git: a bare origin, the live checkout cloned from it, and the
 * work clone shipshape makes for itself. What matters is the shape of the history -- a
 * merge commit with the branch as its second parent -- and everything a ship leaves
 * behind: the change record, the queued deploy, the live checkout caught up.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-ship-'))
const origin = join(dir, 'origin.git')
const live = join(dir, 'live')
process.env.DATA_DIR = join(dir, 'data')
process.env.REPO_DIR = live
process.env.GITHUB_REPO = 'me/homelab'
process.env.GITHUB_TOKEN = 'x'
process.env.GIT_REMOTE_URL = origin
process.env.POLICY_FILE = join(dir, 'policy.yaml')
delete process.env.NOTIFY_URL
delete process.env.ANTHROPIC_API_KEY
delete process.env.OPENROUTER_API_KEY
after(() => rmSync(dir, { recursive: true, force: true }))

const { getDb } = await import('../src/db.ts')
const { runShipPass } = await import('../src/gitops/ship.ts')

const g = (cwd: string, args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()

const COMPOSE = (service: string, tag: string, cls?: string) =>
  `services:\n  ${service}:\n    image: example/${service}:${tag}\n    labels:\n      shipshape.watch: "true"\n${cls ? `      shipshape.class: ${cls}\n` : ''}`

function setup(services: { name: string; cls?: string }[]) {
  rmSync(origin, { recursive: true, force: true })
  rmSync(live, { recursive: true, force: true })
  rmSync(join(dir, 'data', 'repo'), { recursive: true, force: true })
  const seed = join(dir, 'seed')
  rmSync(seed, { recursive: true, force: true })
  mkdirSync(seed, { recursive: true })
  g(seed, ['init', '-q', '-b', 'main'])
  for (const s of services) {
    mkdirSync(join(seed, s.name), { recursive: true })
    writeFileSync(join(seed, s.name, 'docker-compose.yaml'), COMPOSE(s.name, '1.0.0', s.cls))
  }
  g(seed, ['add', '-A'])
  g(seed, ['commit', '-qm', 'fixture'])
  execFileSync('git', ['clone', '-q', '--bare', seed, origin])
  execFileSync('git', ['clone', '-q', origin, live])
  g(live, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
}

function seed(name: string, cls = 'normal') {
  const db = getDb()
  db.prepare(
    `INSERT OR REPLACE INTO images (stack, service, compose_file, image_ref, registry, repository, current_tag, watched, last_seen_at)
     VALUES (?, ?, ?, ?, 'docker.io', ?, '1.0.0', 1, 'now')`,
  ).run(name, name, `${name}/docker-compose.yaml`, `example/${name}:1.0.0`, `example/${name}`)
  return Number(
    db
      .prepare(
        `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state, detected_at, updated_at)
         VALUES (?, ?, ?, '1.0.0', '1.0.1', 'patch', ?, 'detected', ?, ?)`,
      )
      .run(name, name, `example/${name}:1.0.0`, cls, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z').lastInsertRowid,
  )
}

const policy = (extra = '') => writeFileSync(process.env.POLICY_FILE!, `paused: false\nship:\n  cooldown_days: 0\n${extra}`)

beforeEach(() => {
  const db = getDb()
  for (const t of ['deploy_updates', 'deploys', 'restore_points', 'proposals', 'pr_updates', 'prs', 'updates', 'verdicts', 'images', 'events']) {
    db.prepare(`DELETE FROM ${t}`).run()
  }
  policy()
})

const originLog = () => g(origin, ['log', '--format=%P|%s', 'main'])

test('a ready update lands on main as a merge commit with the branch as its second parent', async () => {
  setup([{ name: 'web' }])
  const id = seed('web')
  const r = await runShipPass()
  assert.deepEqual([r.shipped, r.decisions, r.failed], [1, 0, 0])

  const [merge] = originLog().split('\n')
  const [parents, subject] = merge!.split('|')
  assert.equal(parents!.split(' ').length, 2, 'a merge commit, so the history keeps the branch shape')
  assert.equal(subject, 'chore(deps): web: bump web 1.0.0 -> 1.0.1')
  const body = g(origin, ['log', '-1', '--format=%b', 'main'])
  assert.match(body, /web\/web: 1\.0\.0 -> 1\.0\.1 \(patch\)/)
  assert.equal(g(origin, ['show', 'main:web/docker-compose.yaml']).match(/image: (\S+)/)![1], 'example/web:1.0.1')

  // The branch was never pushed, and is gone from the work clone.
  assert.equal(g(origin, ['branch', '--list']).trim(), '* main')
  assert.equal(g(join(dir, 'data', 'repo'), ['branch', '--list', 'shipshape/*']), '')

  // The record: a local change, merged, with the commit it merged as.
  const row = getDb().prepare(`SELECT kind, number, state, merge_commit_sha, scope FROM prs`).get() as Record<string, unknown>
  assert.deepEqual([row.kind, row.number, row.state, row.scope], ['local', 0, 'merged', 'tag-only'])
  assert.equal(row.merge_commit_sha, g(origin, ['rev-parse', 'main']))
  assert.equal((getDb().prepare(`SELECT state FROM updates WHERE id = ?`).get(id) as { state: string }).state, 'merged')

  // The deploy is queued, and the live checkout has caught up.
  const dep = getDb().prepare(`SELECT status, pr_number, stack FROM deploys`).get() as Record<string, unknown>
  assert.deepEqual([dep.status, dep.pr_number, dep.stack], ['pending', 0, 'web'])
  assert.equal(g(live, ['rev-parse', 'HEAD']), g(origin, ['rev-parse', 'main']))
  assert.match(readFileSync(join(live, 'web', 'docker-compose.yaml'), 'utf8'), /example\/web:1\.0\.1/)
})

test('an update that needs a decision commits nothing, and starts the escalation clock', async () => {
  setup([{ name: 'db', cls: 'ask' }])
  const id = seed('db', 'ask')
  const before = g(origin, ['rev-parse', 'main'])
  const r = await runShipPass()
  assert.deepEqual([r.shipped, r.decisions], [0, 1])
  assert.equal(g(origin, ['rev-parse', 'main']), before)
  const row = getDb().prepare(`SELECT decision_since, state FROM updates WHERE id = ?`).get(id) as { decision_since: string | null; state: string }
  assert.ok(row.decision_since)
  assert.equal(row.state, 'detected')
  const again = await runShipPass()
  assert.equal(again.decisions, 1)
  assert.equal((getDb().prepare(`SELECT decision_since FROM updates WHERE id = ?`).get(id) as { decision_since: string }).decision_since, row.decision_since, 'the clock does not restart')
})

test('you saying ship is enough: it overrides the hold, pause and the cooldown', async () => {
  setup([{ name: 'db', cls: 'lifeline' }])
  const id = seed('db', 'lifeline')
  policy('paused: true\n')
  writeFileSync(process.env.POLICY_FILE!, 'paused: true\nship:\n  cooldown_days: 90\n')
  getDb().prepare(`UPDATE updates SET approved_at = ? WHERE id = ?`).run(new Date().toISOString(), id)
  const r = await runShipPass()
  assert.equal(r.shipped, 1)
  assert.match(originLog().split('\n')[0]!, /bump db/)
})

test('a waiting update (cooldown, pause) is left alone and says nothing', async () => {
  setup([{ name: 'web' }])
  const id = seed('web')
  getDb().prepare(`UPDATE updates SET detected_at = ? WHERE id = ?`).run(new Date().toISOString(), id)
  writeFileSync(process.env.POLICY_FILE!, 'paused: false\nship:\n  cooldown_days: 90\n')
  const before = g(origin, ['rev-parse', 'main'])
  const r = await runShipPass()
  assert.deepEqual([r.shipped, r.decisions, r.waiting], [0, 0, 1])
  assert.equal(g(origin, ['rev-parse', 'main']), before)
})

test('ship.max_per_run caps one pass; the rest go on the next', async () => {
  setup([{ name: 'a' }, { name: 'b' }])
  seed('a')
  seed('b')
  writeFileSync(process.env.POLICY_FILE!, 'paused: false\nship:\n  cooldown_days: 0\n  max_per_run: 1\n')
  assert.equal((await runShipPass()).shipped, 1)
  assert.equal((await runShipPass()).shipped, 1)
  assert.equal((await runShipPass()).shipped, 0)
  const merges = originLog().split('\n').filter((l) => l.split('|')[0]!.split(' ').length === 2)
  assert.equal(merges.length, 2, 'one merge commit per ship')
})

test('a frozen service ships only once you approve it', async () => {
  setup([{ name: 'old', cls: 'frozen' }])
  const id = seed('old', 'frozen')
  getDb().prepare(`UPDATE updates SET state = 'frozen' WHERE id = ?`).run(id)
  assert.equal((await runShipPass()).shipped, 0)
  getDb().prepare(`UPDATE updates SET approved_at = ? WHERE id = ?`).run(new Date().toISOString(), id)
  assert.equal((await runShipPass()).shipped, 1)
})

test('an update the file already carries is retired, not shipped and not failed', async () => {
  setup([{ name: 'web' }])
  const id = seed('web')
  // Someone landed it already: main says 1.0.1.
  writeFileSync(join(live, 'web', 'docker-compose.yaml'), COMPOSE('web', '1.0.1'))
  g(live, ['commit', '-qam', 'by hand'])
  g(live, ['push', '-q', origin, 'main:main'])
  const r = await runShipPass()
  assert.equal(r.shipped, 0)
  assert.equal((getDb().prepare(`SELECT state, detail FROM updates WHERE id = ?`).get(id) as { state: string }).state, 'superseded')
})

test('a ship leaves no local branch behind and takes no restore point for a normal service', async () => {
  setup([{ name: 'web' }])
  seed('web')
  await runShipPass()
  assert.equal((getDb().prepare(`SELECT COUNT(*) c FROM restore_points`).get() as { c: number }).c, 0)
  assert.ok(existsSync(join(dir, 'data', 'repo')))
})
