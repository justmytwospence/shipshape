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

const { getDb } = await import('../src/db/index.ts')
const { runShipPass, reconcilePushing, shipHooks } = await import('../src/gitops/ship.ts')

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
  const row = getDb().prepare(`SELECT number, state, merge_commit_sha, scope FROM prs`).get() as Record<string, unknown>
  assert.deepEqual([row.number, row.state, row.scope], [0, 'merged', 'tag-only'])
  assert.equal(row.merge_commit_sha, g(origin, ['rev-parse', 'main']))
  assert.equal((getDb().prepare(`SELECT state FROM updates WHERE id = ?`).get(id) as { state: string }).state, 'merged')

  // The deploy is queued, and the live checkout has caught up.
  const dep = getDb().prepare(`SELECT status, stack FROM deploys`).get() as Record<string, unknown>
  assert.deepEqual([dep.status, dep.stack], ['pending', 'web'])
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

test('one tap on a stack card ships everything in it as one merge commit', async () => {
  setup([{ name: 'web' }])
  // A stack with two services on different images and versions.
  const seedDir = join(dir, 'seed2')
  rmSync(seedDir, { recursive: true, force: true })
  execFileSync('git', ['clone', '-q', origin, seedDir])
  mkdirSync(join(seedDir, 'media'), { recursive: true })
  writeFileSync(
    join(seedDir, 'media', 'docker-compose.yaml'),
    'services:\n  app:\n    image: example/app:1.0.0\n    labels:\n      shipshape.watch: "true"\n      shipshape.class: ask\n' +
      '  db:\n    image: example/db:17\n    labels:\n      shipshape.watch: "true"\n      shipshape.class: ask\n',
  )
  g(seedDir, ['add', '-A'])
  g(seedDir, ['commit', '-qm', 'media'])
  g(seedDir, ['push', '-q', 'origin', 'HEAD:main'])
  g(live, ['pull', '-q', 'origin', 'main'])

  const db = getDb()
  const ins = (service: string, from: string, to: string) => {
    db.prepare(
      `INSERT OR REPLACE INTO images (stack, service, compose_file, image_ref, registry, repository, current_tag, watched, last_seen_at)
       VALUES ('media', ?, 'media/docker-compose.yaml', ?, 'docker.io', ?, ?, 1, 'now')`,
    ).run(service, `example/${service}:${from}`, `example/${service}`, from)
    return Number(
      db.prepare(
        `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state, detected_at, updated_at, approved_at)
         VALUES ('media', ?, ?, ?, ?, 'minor', 'ask', 'detected', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-02-02T00:00:00Z')`,
      ).run(service, `example/${service}:${from}`, from, to).lastInsertRowid,
    )
  }
  ins('app', '1.0.0', '1.1.0')
  ins('db', '17', '18')

  const r = await runShipPass()
  assert.deepEqual([r.shipped, r.failed], [1, 0])
  const [merge] = originLog().split('\n')
  assert.equal(merge!.split('|')[1], 'chore(deps): media: bump app 1.0.0 -> 1.1.0, db 17 -> 18')
  const compose = g(origin, ['show', 'main:media/docker-compose.yaml'])
  assert.match(compose, /example\/app:1\.1\.0/)
  assert.match(compose, /example\/db:18/)
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM deploys`).get() as { n: number }).n, 1, 'one deploy')
})

test('an update for a service that is in no compose file any more is retired, not retried', async () => {
  setup([{ name: 'web' }])
  const db = getDb()
  const id = Number(
    db.prepare(
      `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state, detected_at, updated_at, approved_at)
       VALUES ('media', 'app', 'example/app:1.0.0', '1.0.0', '1.1.0', 'patch', 'ask', 'detected', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-02-02T00:00:00Z')`,
    ).run().lastInsertRowid,
  )
  const r = await runShipPass()
  assert.deepEqual([r.shipped, r.failed], [0, 0])
  const row = db.prepare(`SELECT state, detail FROM updates WHERE id = ?`).get(id) as { state: string; detail: string }
  assert.deepEqual([row.state, row.detail], ['superseded', 'service removed'])
})

function draft(id: number, opts: { steps: string[] }) {
  const db = getDb()
  const pr = Number(
    db
      .prepare(
        `INSERT INTO prs (number, branch, head_sha_pushed, state, group_key, scope, created_at)
         VALUES (0, 'shipshape/app--app--1.0.1', '', 'open', NULL, 'proposed', '2026-01-02T00:00:00Z')`,
      )
      .run().lastInsertRowid,
  )
  db.prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`).run(pr, id)
  db.prepare(
    `INSERT INTO proposals (pr_id, update_id, ops, notes, summary, sources, changed, model, error, hunks, created_at)
     VALUES (?, ?, '[]', '[]', NULL, '[]', '[]', 'm', NULL, '[]', '2026-01-02T00:00:00Z')`,
  ).run(pr, id)
  db.prepare(
    `INSERT INTO verdicts (image, from_tag, to_tag, recommendation, confidence, breaking_changes, migration_steps, sources, source, created_at)
     VALUES ('example/app:1.0.0', '1.0.0', '1.0.1', 'approve', 'high', '[]', ?, '[]', 'reader', '2026-01-03T00:00:00Z')`,
  ).run(JSON.stringify(opts.steps))
  return pr
}

test('a draft whose review was read again with no work is closed, not merged', async () => {
  setup([{ name: 'app' }])
  const id = seed('app')
  const pr = draft(id, { steps: [] })
  const before = g(origin, ['rev-parse', 'main'])
  await runShipPass()
  const row = getDb().prepare(`SELECT state FROM prs WHERE id = ?`).get(pr) as { state: string }
  assert.equal(row.state, 'closed')
  assert.equal((getDb().prepare(`SELECT COUNT(*) c FROM proposals WHERE pr_id = ?`).get(pr) as { c: number }).c, 0)
  const ev = getDb().prepare(`SELECT detail FROM events WHERE message = 'a drafted change was closed'`).get() as { detail: string }
  assert.match(ev.detail, /read again/)
  assert.notEqual(g(origin, ['rev-parse', 'main']), before, 'the tag-only change shipped instead')
  assert.match(g(origin, ['log', '-1', '--format=%s', 'main']), /bump app/)
})

test('a draft still justified by its review waits for you', async () => {
  setup([{ name: 'app' }])
  const id = seed('app')
  const pr = draft(id, { steps: ['set X'] })
  const before = g(origin, ['rev-parse', 'main'])
  await runShipPass()
  assert.equal(g(origin, ['rev-parse', 'main']), before)
  assert.equal((getDb().prepare(`SELECT state FROM prs WHERE id = ?`).get(pr) as { state: string }).state, 'open')
  assert.ok((getDb().prepare(`SELECT decision_since FROM updates WHERE id = ?`).get(id) as { decision_since: string | null }).decision_since)
})

// ------------------------------------------------------------------ crash between push and record

function crashAfterPush<T>(run: () => Promise<T>): Promise<T> {
  shipHooks.afterPush = () => {
    throw new Error('simulated crash')
  }
  return run().finally(() => {
    shipHooks.afterPush = null
  })
}

const prState = () => getDb().prepare(`SELECT id, state, scope FROM prs`).all() as { id: number; state: string; scope: string }[]

/** A `pushing` row for `updateId` whose merge commit is `sha`, as a crash would leave it. */
function pushingRow(updateId: number, sha: string, scope = 'tag-only'): number {
  const db = getDb()
  const id = Number(
    db
      .prepare(
        `INSERT INTO prs (number, branch, head_sha_pushed, state, group_key, scope, created_at, merge_commit_sha)
         VALUES (0, 'shipshape/app--app--1.0.1', 'x', 'pushing', NULL, ?, '2026-01-02T00:00:00Z', ?)`,
      )
      .run(scope, sha).lastInsertRowid,
  )
  db.prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`).run(id, updateId)
  return id
}

test('a crash after the push is reconciled into a shipped change and a queued deploy', async () => {
  setup([{ name: 'web' }])
  const id = seed('web')
  const r = await crashAfterPush(() => runShipPass())
  assert.equal(r.failed, 1)
  assert.deepEqual(prState().map((p) => p.state), ['pushing'])
  assert.equal((getDb().prepare(`SELECT COUNT(*) c FROM deploys`).get() as { c: number }).c, 0)

  const out = await reconcilePushing()
  assert.deepEqual(out, { landed: 1, dropped: 0, unknown: 0 })
  assert.deepEqual(prState().map((p) => p.state), ['merged'])
  assert.equal((getDb().prepare(`SELECT state FROM updates WHERE id = ?`).get(id) as { state: string }).state, 'merged')
  const dep = getDb().prepare(`SELECT status, stack FROM deploys`).get() as { status: string; stack: string }
  assert.deepEqual([dep.status, dep.stack], ['pending', 'web'])
  assert.deepEqual(await reconcilePushing(), { landed: 0, dropped: 0, unknown: 0 }, 'and a second look has nothing to do')
})

test('an update whose ship is being confirmed is never retired as applied elsewhere', async () => {
  setup([{ name: 'web' }])
  const id = seed('web')
  await crashAfterPush(() => runShipPass())
  const again = await runShipPass()
  assert.deepEqual([again.shipped, again.failed], [0, 0])
  const u = getDb().prepare(`SELECT state, detail FROM updates WHERE id = ?`).get(id) as { state: string; detail: string | null }
  assert.equal(u.state, 'detected')
  assert.notEqual(u.detail, 'applied elsewhere')
})

test('a ship that never reached origin is dropped and ships again', async () => {
  setup([{ name: 'web' }])
  const id = seed('web')
  const pr = pushingRow(id, '0'.repeat(40))
  assert.deepEqual(await reconcilePushing(), { landed: 0, dropped: 1, unknown: 0 })
  assert.equal(prState().find((p) => p.id === pr)!.state, 'closed')
  const r = await runShipPass()
  assert.equal(r.shipped, 1)
})

test('a drafted change whose push did not land goes back to open', async () => {
  setup([{ name: 'web' }])
  const id = seed('web')
  const pr = pushingRow(id, '0'.repeat(40), 'proposed')
  assert.equal((await reconcilePushing()).dropped, 1)
  assert.equal(prState().find((p) => p.id === pr)!.state, 'open')
})

test('a failed push closes the change it recorded', async () => {
  setup([{ name: 'web' }])
  seed('web')
  const hook = join(origin, 'hooks', 'pre-receive')
  mkdirSync(join(origin, 'hooks'), { recursive: true })
  writeFileSync(hook, '#!/bin/sh\necho no >&2\nexit 1\n', { mode: 0o755 })
  try {
    const r = await runShipPass()
    assert.equal(r.shipped, 0)
  } finally {
    rmSync(hook, { force: true })
  }
  assert.equal(prState().filter((p) => p.state === 'pushing').length, 0)
  assert.deepEqual(prState().map((p) => p.state), ['closed'])
})
