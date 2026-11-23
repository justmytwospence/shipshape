import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A change shipshape merged itself is a true merge commit, and undoing it is
 * `git revert -m 1` -- a squash-merged pull request from v1 is an ordinary commit and
 * keeps the plain revert. Which one applies is a property of the change record.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-rollback-local-'))
const live = join(dir, 'live')
process.env.DATA_DIR = join(dir, 'data')
process.env.REPO_DIR = live
process.env.GITHUB_REPO = 'me/homelab'
delete process.env.NOTIFY_URL
after(() => rmSync(dir, { recursive: true, force: true }))

const { getDb } = await import('../src/db.ts')
const { performRollback } = await import('../src/deploy/rollback.ts')
const { changeUrl } = await import('../src/gitops/change.ts')
const { fakeIo, composeCalls } = await import('./helpers/deploy-io.ts')

const g = (args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: live, encoding: 'utf8' }).trim()
const COMPOSE = (tag: string) => `services:\n  web:\n    image: example/web:${tag}\n`

mkdirSync(join(live, 'web'), { recursive: true })
writeFileSync(join(live, 'web', 'docker-compose.yaml'), COMPOSE('1.0.0'))
g(['init', '-q', '-b', 'main'])
g(['add', '-A'])
g(['commit', '-qm', 'fixture'])
g(['checkout', '-q', '-b', 'shipshape/web--web--1.0.1'])
writeFileSync(join(live, 'web', 'docker-compose.yaml'), COMPOSE('1.0.1'))
g(['commit', '-qam', 'chore(deps): web: bump web 1.0.0 -> 1.0.1'])
g(['checkout', '-q', 'main'])
g(['merge', '--no-ff', '-m', 'chore(deps): web: bump web 1.0.0 -> 1.0.1', 'shipshape/web--web--1.0.1'])
const mergeSha = g(['rev-parse', 'HEAD'])

function change(sha: string | null = null): number {
  return Number(
    getDb()
      .prepare(`INSERT INTO prs (number, branch, head_sha_pushed, state, scope, merge_commit_sha, created_at) VALUES (0, 'b', 'x', 'merged', 'tag-only', ?, 'now')`)
      .run(sha).lastInsertRowid,
  )
}

test('a local change points at its merge commit', () => {
  const local = change(mergeSha)
  assert.equal(changeUrl(local), `https://github.com/me/homelab/commit/${mergeSha}`)
})

test('rolling back a merge commit reverts it with -m 1 and brings the old version up', async () => {
  const io = fakeIo({ web: 'running' })
  const r = await performRollback({ stack: 'web', services: ['web'], strategy: 'up' }, mergeSha, { io })
  assert.equal(r.ok, true, r.detail)
  assert.equal(readFileSync(join(live, 'web', 'docker-compose.yaml'), 'utf8'), COMPOSE('1.0.0'))
  assert.match(g(['log', '-1', '--format=%s']), /^Revert "chore\(deps\): web: bump web 1\.0\.0 -> 1\.0\.1"/)
  assert.equal(g(['rev-list', '--count', '--merges', 'HEAD']), '1', 'the merge stays in the history; the revert sits on top')
  assert.deepEqual(composeCalls(io.calls), ['compose -f web/docker-compose.yaml up -d --no-deps web'])
})

test('a single-parent commit is reverted without -m', async () => {
  writeFileSync(join(live, 'web', 'docker-compose.yaml'), COMPOSE('1.0.2'))
  g(['commit', '-qam', 'chore(deps): web: bump web 1.0.0 -> 1.0.2'])
  const plain = g(['rev-parse', 'HEAD'])
  const r = await performRollback({ stack: 'web', services: ['web'], strategy: 'up' }, plain, { io: fakeIo({ web: 'running' }) })
  assert.equal(r.ok, true, r.detail)
  assert.equal(readFileSync(join(live, 'web', 'docker-compose.yaml'), 'utf8'), COMPOSE('1.0.0'))
})
