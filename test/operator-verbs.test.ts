import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The four answers to a decision, and what each one does to every update it covers.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-verbs-'))
const repo = join(dir, 'repo')
process.env.DATA_DIR = join(dir, 'data')
process.env.REPO_DIR = repo
process.env.POLICY_FILE = 'policy.yaml'
delete process.env.ANTHROPIC_API_KEY
delete process.env.OPENROUTER_API_KEY
delete process.env.GITHUB_REPO
after(() => rmSync(dir, { recursive: true, force: true }))

const { getDb } = await import('../src/db.ts')
const { runOperatorVerb } = await import('../src/updates/operator-verbs.ts')

const g = (args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim()
const AG = 'ghcr.io/agentgateway/agentgateway'

function add(stack: string, tier: string, image = AG): number {
  getDb()
    .prepare(`INSERT OR REPLACE INTO images (stack, service, compose_file, image_ref, registry, repository, watched, last_seen_at) VALUES (?, ?, 'x', ?, 'ghcr.io', 'agentgateway/agentgateway', 1, 'now')`)
    .run(stack, stack, `${image}:v1.6.0`)
  return Number(
    getDb()
      .prepare(`INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state, detected_at, updated_at) VALUES (?, ?, ?, 'v1.6.0', 'v1.7.0', 'minor', ?, 'detected', ?, ?)`)
      .run(stack, stack, `${image}:v1.6.0`, tier, new Date().toISOString(), new Date().toISOString()).lastInsertRowid,
  )
}

const row = (id: number) => getDb().prepare(`SELECT state, approved_at, snoozed_until, decision_since FROM updates WHERE id = ?`).get(id) as Record<string, string | null>

beforeEach(() => {
  rmSync(repo, { recursive: true, force: true })
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'policy.yaml'), 'paused: false\n')
  g(['init', '-q', '-b', 'main'])
  g(['add', '-A'])
  g(['commit', '-qm', 'fixture'])
  getDb().exec(`DELETE FROM updates; DELETE FROM images; DELETE FROM proposals; DELETE FROM pr_updates; DELETE FROM prs; DELETE FROM events; DELETE FROM verdicts`)
})

test('ship approves every update the decision covers, and clears a snooze', async () => {
  const ids = [add('a', 'ask'), add('b', 'ask'), add('c', 'ask', 'ghcr.io/other/thing')]
  const r = await runOperatorVerb(ids[1]!, 'ship')
  assert.equal(r.ok, true, r.message)
  assert.match(r.message, /^Shipping a, b v1\.6\.0 -> v1\.7\.0\./)
  assert.ok(row(ids[0]!).approved_at && row(ids[1]!).approved_at)
  assert.equal(row(ids[2]!).approved_at, null, 'a different image in another stack is a different decision')

  // Shipped from the dashboard while snoozed: it comes back and ships.
  const d = add('d', 'ask', 'ghcr.io/x/d')
  getDb().prepare(`UPDATE updates SET snoozed_until = ? WHERE id = ?`).run(new Date(Date.now() + 1e9).toISOString(), d)
  assert.equal((await runOperatorVerb(d, 'ship')).ok, true)
  assert.ok(row(d).approved_at)
  assert.equal(row(d).snoozed_until, null)
})

test('snooze puts the whole decision off for a week and restarts its clock', async () => {
  const ids = [add('a', 'ask'), add('b', 'ask')]
  const r = await runOperatorVerb(ids[0]!, 'snooze')
  assert.equal(r.ok, true)
  for (const id of ids) {
    const days = (Date.parse(row(id)!.snoozed_until!) - Date.now()) / 86_400_000
    assert.ok(days > 6.9 && days <= 7, `${days}`)
    assert.equal(row(id)!.decision_since, row(id)!.snoozed_until, 'the escalation counts from when it comes back')
  }
  assert.equal((await runOperatorVerb(ids[0]!, 'snooze')).ok, false, 'already snoozed')
})

test('skip dismisses everything the decision covers, and the drafted change that carried it', async () => {
  const ids = [add('a', 'ask'), add('b', 'ask')]
  const p = Number(getDb().prepare(`INSERT INTO prs (number, branch, head_sha_pushed, state, scope, kind, created_at) VALUES (0, 'b', 'x', 'open', 'proposed', 'local', 'now')`).run().lastInsertRowid)
  getDb().prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`).run(p, ids[0])
  getDb().prepare(`INSERT INTO proposals (pr_id, update_id, ops, notes, created_at) VALUES (?, ?, '[]', '[]', 'now')`).run(p, ids[0])
  const r = await runOperatorVerb(ids[1]!, 'skip')
  assert.equal(r.ok, true)
  for (const id of ids) assert.equal(row(id)!.state, 'skipped')
  assert.equal((getDb().prepare(`SELECT state FROM prs WHERE id = ?`).get(p) as { state: string }).state, 'closed')
  assert.equal((getDb().prepare(`SELECT COUNT(*) c FROM proposals`).get() as { c: number }).c, 0)
})

test('always ship writes the rule as a commit, approves the decision, and says what it did', async () => {
  const ids = [add('a-mcp', 'ask'), add('b-mcp', 'ask')]
  const r = await runOperatorVerb(ids[0]!, 'always-ship')
  assert.equal(r.ok, true, r.message)
  assert.match(r.message, /^Always ship: every service running ghcr\.io\/agentgateway\/agentgateway, waiving ask\. Rule r1 committed \([0-9a-f]{7,}\)\./)
  assert.match(readFileSync(join(repo, 'policy.yaml'), 'utf8'), /id: r1/)
  assert.match(g(['log', '-1', '--format=%s']), /^chore\(shipshape\): rule r1: always ship/)
  for (const id of ids) assert.ok(row(id)!.approved_at, 'shipped now as well')
})

test('always ship is refused where a hold cannot be waived, and changes nothing', async () => {
  const id = add('traefik', 'lifeline', 'traefik')
  const r = await runOperatorVerb(id, 'always-ship')
  assert.equal(r.ok, false)
  assert.match(r.message, /cannot be waived/)
  assert.equal(row(id)!.approved_at, null)
  assert.equal(g(['rev-list', '--count', 'HEAD']), '1')
})

test('a verb that is not on offer answers with the reason instead of acting', async () => {
  const id = add('a', 'normal')
  getDb().prepare(`UPDATE updates SET state = 'verified' WHERE id = ?`).run(id)
  const r = await runOperatorVerb(id, 'ship')
  assert.deepEqual([r.ok, r.message.startsWith('nothing to ship')], [false, true])
})
