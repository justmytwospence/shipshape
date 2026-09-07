import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The ledger's two jobs: never act on the same comment twice, and hold the merge while
 * anything is outstanding.
 *
 * Both are properties of the schema rather than of any function, so they are worth
 * asserting against a real database. The idempotency in particular is load-bearing --
 * ingestion runs every tick and re-reads a window of comments each time, so "seen a
 * hundred times, acted on once" has to be true by construction.
 */

let dir: string
let db: typeof import('../src/db.ts')

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shipshape-ledger-'))
  process.env.DATA_DIR = dir
  delete process.env.REPO_DIR
  db = await import('../src/db.ts')
  const d = db.getDb()
  d.prepare(
    `INSERT INTO prs (id, number, branch, head_sha_pushed, state, created_at)
     VALUES (1, 7, 'shipshape/x--y', 'abc', 'open', datetime('now'))`,
  ).run()
})

after(() => rmSync(dir, { recursive: true, force: true }))

const add = (commentId: string, status = 'new') =>
  db
    .getDb()
    .prepare(
      `INSERT OR IGNORE INTO instructions
         (pr_id, comment_id, kind, author, body, commented_at, status, created_at)
       VALUES (1, ?, 'issue', 'operator', 'do the thing', datetime('now'), ?, datetime('now'))`,
    )
    .run(commentId, status)

const count = () =>
  (db.getDb().prepare(`SELECT COUNT(*) c FROM instructions`).get() as { c: number }).c

test('the migration lands the whole shape', () => {
  const cols = (t: string) =>
    (db.getDb().prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
  for (const c of ['pr_id', 'comment_id', 'kind', 'author', 'body', 'status', 'attempts', 'action']) {
    assert.ok(cols('instructions').includes(c), c)
  }
  assert.ok(cols('proposals').includes('instruction_id'))
  assert.ok(cols('prs').includes('hold_reason'))
  assert.ok(cols('prs').includes('hold_at'))
})

test('the rollout watermark exists, so the first tick has something to compare against', () => {
  const rows = db
    .getDb()
    .prepare(`SELECT key, window FROM budgets WHERE key LIKE 'revise.%'`)
    .all() as { key: string; window: string }[]
  assert.deepEqual(rows.map((r) => r.key).sort(), ['revise.epoch', 'revise.since'])
  // Written by SQLite at migration time, so it is the moment the feature arrived rather
  // than whenever the process next happened to start.
  for (const r of rows) assert.match(r.window, /^\d{4}-\d{2}-\d{2}T/)
})

test('the same comment recorded twice is recorded once', () => {
  const before = count()
  add('issue:500')
  add('issue:500')
  add('issue:500')
  assert.equal(count(), before + 1)
})

test('the two id spaces do not collide', () => {
  const before = count()
  add('issue:900')
  add('review:900')
  assert.equal(count(), before + 2)
})

test('an outstanding comment holds the merge; a finished one does not', async () => {
  const { holdReason } = await import('../src/gitops/automerge.ts')
  const d = db.getDb()
  d.prepare(`DELETE FROM instructions`).run()
  assert.equal(holdReason(1), null)

  add('issue:1', 'new')
  assert.match(holdReason(1) ?? '', /waiting on an answer/)

  d.prepare(`UPDATE instructions SET status = 'working' WHERE comment_id = 'issue:1'`).run()
  assert.match(holdReason(1) ?? '', /waiting on an answer/, 'still held while it is being worked')

  // Done, but the quiet period is still running -- a comment posted moments ago must not
  // be merged out from under, whatever it turned out to say.
  d.prepare(`UPDATE instructions SET status = 'done' WHERE comment_id = 'issue:1'`).run()
  assert.match(holdReason(1) ?? '', /last few minutes/)

  d.prepare(
    `UPDATE instructions SET created_at = datetime('now', '-1 hour') WHERE comment_id = 'issue:1'`,
  ).run()
  assert.equal(holdReason(1), null)
})

test('a standing hold outlives the comment that asked for it', async () => {
  const { holdReason } = await import('../src/gitops/automerge.ts')
  const d = db.getDb()
  d.prepare(`DELETE FROM instructions`).run()
  assert.equal(holdReason(1), null)
  // Otherwise "don't merge this yet" would last exactly as long as it took to reply.
  d.prepare(`UPDATE prs SET hold_reason = 'you asked shipshape to hold this' WHERE id = 1`).run()
  assert.equal(holdReason(1), 'you asked shipshape to hold this')
  d.prepare(`UPDATE prs SET hold_reason = NULL WHERE id = 1`).run()
  assert.equal(holdReason(1), null)
})

test("shipshape's own replies sit in the ledger without holding anything", async () => {
  const { holdReason } = await import('../src/gitops/automerge.ts')
  const d = db.getDb()
  d.prepare(`DELETE FROM instructions`).run()
  add('issue:42', 'ours')
  d.prepare(
    `UPDATE instructions SET created_at = datetime('now', '-1 hour') WHERE comment_id = 'issue:42'`,
  ).run()
  // Recorded so it is recognised on the way back in, but it is not an instruction and
  // must not hold a merge or the bot would block itself forever.
  assert.equal(holdReason(1), null)
})
