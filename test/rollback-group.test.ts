import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * Roll back, pressed on one member of a group, against a real git checkout.
 *
 * `git revert` takes the whole merge out, so the file goes back for every member -- and the
 * deploy that follows has to be of every member too, or a running sibling stays on the
 * version the file no longer pins while its update still reads verified.
 */

const root = mkdtempSync(join(tmpdir(), 'shipshape-rollback-group-'))
const data = join(root, 'data')
const repo = join(root, 'repo')
const bin = join(root, 'bin')
for (const d of [data, repo, bin]) mkdirSync(d)

// Nothing here may reach a daemon or a network: docker always refuses, and git refuses
// anything remote, so the post-rollback sync fails where it would otherwise publish.
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
writeFileSync(join(bin, 'docker'), '#!/bin/sh\necho "test docker: refused" >&2\nexit 1\n')
writeFileSync(
  join(bin, 'git'),
  `#!/bin/sh\ncase "$*" in *fetch*|*push*|*clone*|*ls-remote*|*pull*) echo "offline" >&2; exit 1;; esac\nexec ${realGit} "$@"\n`,
)
chmodSync(join(bin, 'docker'), 0o755)
chmodSync(join(bin, 'git'), 0o755)
process.env.PATH = `${bin}:${process.env.PATH}`
process.env.DATA_DIR = data
process.env.REPO_DIR = repo
process.env.GITHUB_REPO = 'you/repo'
delete process.env.POLICY_FILE
delete process.env.NTFY_URL
delete process.env.NTFY_TOKEN
delete process.env.SMTP_URL

const g = (...args: string[]) =>
  execFileSync(realGit, ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim()
const file = join(repo, 'n8n/docker-compose.yaml')
const pin = (tag: string) =>
  writeFileSync(file, `services:\n  n8n:\n    image: n8nio/n8n:${tag}\n  n8n-import:\n    image: n8nio/n8n:${tag}\n`)
g('init', '-q', '-b', 'main')
mkdirSync(join(repo, 'n8n'))
pin('2.38.5')
g('add', '-A')
g('commit', '-q', '-m', 'base')
pin('2.38.7')
g('add', '-A')
g('commit', '-q', '-m', 'chore(deps): n8n 2.38.7 (#91)')
const mergeSha = g('rev-parse', 'HEAD')

const { getDb } = await import('../src/db.ts')
const { runVerb } = await import('../src/updates/verbs.ts')
const { withGitLock } = await import('../src/gitops/repo.ts')
const { composeCalls, fakeIo } = await import('./helpers/deploy-io.ts')

after(() => rmSync(root, { recursive: true, force: true }))

const now = () => new Date().toISOString()

test('Roll back on the left-stopped member of a group puts the running sibling back too', async () => {
  const db = getDb()
  const prId = Number(
    db
      .prepare(
        `INSERT INTO prs (number, branch, head_sha_pushed, state, scope, created_at, merged_at, merge_commit_sha)
         VALUES (91, 'b91', 'sha', 'merged', 'tag-only', ?, ?, ?)`,
      )
      .run(now(), now(), mergeSha).lastInsertRowid,
  )
  const update = (service: string, state: string) => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state, detected_at, updated_at)
           VALUES ('n8n', ?, 'n8nio/n8n', '2.38.5', '2.38.7', 'patch', 'auto', ?, ?, ?)`,
        )
        .run(service, state, now(), now()).lastInsertRowid,
    )
    db.prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`).run(prId, id)
    return id
  }
  const importId = update('n8n-import', 'left-stopped')
  const n8nId = update('n8n', 'verified')
  const plan = JSON.stringify({
    v: 1,
    at: now(),
    seen: [],
    up: ['n8n'],
    left: [{ service: 'n8n-import', state: 'exited', why: 'not-running', restartPolicy: 'no', oldRef: 'n8nio/n8n:2.38.5' }],
    restored: [],
  })
  const deployed = Number(
    db
      .prepare(
        `INSERT INTO deploys (pr_number, pr_id, stack, services, strategy, ok, healthy, status, attempts,
                              created_at, finished_at, trigger, snapshot)
         VALUES (91, ?, 'n8n', 'n8n-import n8n', 'up', 1, 1, 'verified', 1, ?, ?, 'queue', ?)`,
      )
      .run(prId, now(), now(), plan).lastInsertRowid,
  )
  db.prepare(`INSERT INTO deploy_updates (deploy_id, update_id) VALUES (?, ?), (?, ?)`).run(
    deployed,
    importId,
    deployed,
    n8nId,
  )

  const io = fakeIo({
    n8n: { state: 'running', imageRef: 'n8nio/n8n:2.38.7' },
    'n8n-import': { state: 'exited', restartPolicy: 'no', exitCode: 0, imageRef: 'n8nio/n8n:2.38.5' },
  })
  const pressed = await runVerb(importId, 'rollback', { io })
  assert.equal(pressed.ok, true, pressed.message)

  type Row = { id: number; status: string; services: string }
  let row: Row | undefined
  for (let i = 0; i < 200; i++) {
    row = db.prepare(`SELECT id, status, services FROM deploys WHERE trigger = 'rollback'`).get() as Row | undefined
    if (row && row.status !== 'running') break
    await new Promise((r) => setTimeout(r, 25))
  }
  // The publish that follows holds the git lock; wait it out before the checkout goes away.
  await withGitLock('test', async () => undefined)

  assert.equal(row?.status, 'rolled-back')
  assert.match(readFileSync(file, 'utf8'), /n8n:2\.38\.5[\s\S]*n8n:2\.38\.5/, 'the revert pins both back')
  assert.deepEqual(
    composeCalls(io.calls),
    ['compose -f n8n/docker-compose.yaml up -d --no-deps n8n'],
    'n8n was running, so it goes back to 2.38.5; n8n-import was not, so it stays as it is',
  )
  assert.deepEqual(row!.services.split(' ').sort(), ['n8n', 'n8n-import'])

  const stateOf = (id: number) => (db.prepare(`SELECT state FROM updates WHERE id = ?`).get(id) as { state: string }).state
  assert.equal(stateOf(importId), 'failed')
  assert.equal(stateOf(n8nId), 'failed', 'the sibling the revert took back no longer reads verified')

  const linked = db
    .prepare(`SELECT update_id FROM deploy_updates WHERE deploy_id = ? ORDER BY update_id`)
    .all(row!.id) as { update_id: number }[]
  assert.deepEqual(
    linked.map((l) => l.update_id),
    [importId, n8nId].sort((a, b) => a - b),
  )
})
