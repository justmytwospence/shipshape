import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The one-time move from pull requests to merge commits: every v1 pull request still open
 * is closed with a note, its update goes back to `detected`, and nothing is left behind
 * that a GitHub reader would think still needs them. It is guarded so it runs once, and
 * only counts as done when every pull request was handled.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-cutover-'))
const origin = join(dir, 'origin.git')
process.env.DATA_DIR = join(dir, 'data')
process.env.GITHUB_REPO = 'me/homelab'
process.env.GITHUB_TOKEN = 'x'
process.env.GIT_REMOTE_URL = origin
delete process.env.REPO_DIR
delete process.env.NOTIFY_URL
after(() => rmSync(dir, { recursive: true, force: true }))

const seed = join(dir, 'seed')
mkdirSync(seed, { recursive: true })
const g = (cwd: string, args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()
g(seed, ['init', '-q', '-b', 'main'])
writeFileSync(join(seed, 'f'), 'x')
g(seed, ['add', '-A'])
g(seed, ['commit', '-qm', 'fixture'])
execFileSync('git', ['clone', '-q', '--bare', seed, origin])

const { getDb } = await import('../src/db.ts')
const { runCutover, cutoverDone, branchOwnership, CUTOVER_COMMENT } = await import('../src/gitops/cutover.ts')
const { mockFetch, assertAllMocked, json } = await import('./helpers/http.ts')

function pr(n: number, branch: string): { prId: number; updateId: number } {
  const db = getDb()
  const u = Number(
    db
      .prepare(
        `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state, detected_at, updated_at)
         VALUES ('s', ?, 'img', '1', ?, 'minor', 'normal', 'pr_open', 'now', 'now')`,
      )
      .run(`svc${n}`, `2.${n}`).lastInsertRowid,
  )
  const p = Number(
    db
      .prepare(`INSERT INTO prs (number, branch, head_sha_pushed, state, scope, kind, created_at) VALUES (?, ?, 'sha', 'open', 'tag-only', 'github', 'now')`)
      .run(n, branch).lastInsertRowid,
  )
  db.prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`).run(p, u)
  db.prepare(`INSERT INTO proposals (pr_id, update_id, ops, notes, created_at) VALUES (?, ?, '[]', '[]', 'now')`).run(p, u)
  return { prId: p, updateId: u }
}

beforeEach(() => {
  const db = getDb()
  for (const t of ['proposals', 'pr_updates', 'prs', 'updates', 'incidents']) db.prepare(`DELETE FROM ${t}`).run()
  db.prepare(`DELETE FROM budgets WHERE key = 'cutover.v2'`).run()
})

const api = (failPull?: number) => [
  { method: 'POST', url: /\/repos\/me\/homelab\/issues\/(\d+)\/comments$/, reply: () => json({ id: 1 }, { status: 201 }) },
  {
    method: 'PATCH',
    url: /\/repos\/me\/homelab\/pulls\/(\d+)$/,
    reply: (_req: Request, m: RegExpExecArray | null) =>
      Number(m![1]) === failPull ? json({ message: 'Validation Failed' }, { status: 422 }) : json({ number: Number(m![1]), state: 'closed' }),
  },
]

test('every open pull request is closed with a note, and its update goes back to detected', async (t) => {
  const a = pr(41, 'shipshape/a')
  const b = pr(42, 'shipshape/b')
  const h = mockFetch(t, api() as never)
  const r = await runCutover()
  assert.deepEqual([r.closed, r.failed, r.done], [2, 0, true])
  assert.equal(h.calls.filter((c) => c.method === 'POST').length, 2, 'a comment on each')
  for (const x of [a, b]) {
    assert.equal((getDb().prepare(`SELECT state FROM prs WHERE id = ?`).get(x.prId) as { state: string }).state, 'closed')
    assert.equal((getDb().prepare(`SELECT state FROM updates WHERE id = ?`).get(x.updateId) as { state: string }).state, 'detected')
    assert.equal((getDb().prepare(`SELECT COUNT(*) c FROM proposals WHERE pr_id = ?`).get(x.prId) as { c: number }).c, 0, 'drafts on GitHub branches are gone')
  }
  assert.equal(cutoverDone(), true)
  assertAllMocked(h)
})

test('the comment says where the update went', () => {
  assert.match(CUTOVER_COMMENT, /no longer uses pull requests/)
  assert.match(CUTOVER_COMMENT, /merge commit/)
})

test('once done it never touches GitHub again', async (t) => {
  pr(43, 'shipshape/c')
  mockFetch(t, api() as never)
  await runCutover()
  const h = mockFetch(t, [])
  pr(44, 'shipshape/d')
  const r = await runCutover()
  assert.deepEqual([r.closed, r.done], [0, true])
  assert.equal(h.calls.length, 0)
})

test('one pull request GitHub refuses leaves the rest handled, and the cutover not done', async (t) => {
  const bad = pr(45, 'shipshape/bad')
  const ok = pr(46, 'shipshape/ok')
  mockFetch(t, api(45) as never)
  const r = await runCutover()
  assert.deepEqual([r.closed, r.failed, r.done], [1, 1, false])
  assert.equal((getDb().prepare(`SELECT state FROM prs WHERE id = ?`).get(bad.prId) as { state: string }).state, 'open', 'tried again next tick')
  assert.equal((getDb().prepare(`SELECT state FROM prs WHERE id = ?`).get(ok.prId) as { state: string }).state, 'closed')
  assert.equal(cutoverDone(), false)
  // The next tick finishes it, without touching the one already closed.
  const h = mockFetch(t, api() as never)
  const again = await runCutover()
  assert.deepEqual([again.closed, again.done], [1, true])
  assert.equal(h.calls.filter((c) => c.url.endsWith('/issues/46/comments')).length, 0)
})

test('v2 change records are not pull requests and are left alone', async (t) => {
  const db = getDb()
  db.prepare(`INSERT INTO prs (number, branch, head_sha_pushed, state, scope, kind, created_at) VALUES (0, 'shipshape/x', 'sha', 'open', 'proposed', 'local', 'now')`).run()
  const h = mockFetch(t, [])
  await runCutover()
  assert.equal(h.calls.length, 0)
  assert.equal((db.prepare(`SELECT state FROM prs WHERE kind = 'local'`).get() as { state: string }).state, 'open')
})

test('a branch is deleted only when the tip is one shipshape pushed', () => {
  const db = getDb()
  db.prepare(`INSERT INTO prs (number, branch, head_sha_pushed, state, scope, kind, user_owned, created_at) VALUES (1, 'b', 'abc', 'closed', 'tag-only', 'github', 0, 'now')`).run()
  assert.equal(branchOwnership('b', 'abc'), 'ours')
  assert.equal(branchOwnership('b', 'def'), 'theirs', 'somebody pushed to it')
  db.prepare(`INSERT INTO prs (number, branch, head_sha_pushed, state, scope, kind, user_owned, created_at) VALUES (2, 'c', 'abc', 'open', 'tag-only', 'github', 1, 'now')`).run()
  assert.equal(branchOwnership('c', 'abc'), 'theirs', 'an open pull request somebody took over')
})
