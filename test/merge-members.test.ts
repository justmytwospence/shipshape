import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The merge gate asks every member of a pull request, and waits for a review that is on
 * its way.
 *
 * Two holes this closes. The group fold started from approve/high and only replaced it on
 * a strictly worse recommendation, so an approve at low confidence carried `high` and
 * merged -- on single pull requests as well as groups. And an update whose review had not
 * been reached yet read as "unavailable" and merged unread in the same tick it was opened.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'shipshape-members-'))
// A provider must look configured, or a review is never "expected" and nothing is pending.
process.env.OPENROUTER_API_KEY = 'test-key'
delete process.env.ANTHROPIC_API_KEY
delete process.env.REPO_DIR

const { getDb } = await import('../src/db.ts')
const { PolicySchema } = await import('../src/config.ts')
const { decide, memberVerdict, REVIEW_WAIT_MS } = await import('../src/gitops/automerge.ts')

const policy = PolicySchema.parse({ paused: false })

beforeEach(() => {
  getDb().exec(`DELETE FROM prs; DELETE FROM updates; DELETE FROM pr_updates; DELETE FROM verdicts;`)
})

let seq = 0
function update(service: string, opts: { detectedAt?: string; magnitude?: string } = {}): {
  id: number
  image: string
} {
  seq++
  const at = opts.detectedAt ?? new Date().toISOString()
  const image = `img/${service}-${seq}`
  const info = getDb()
    .prepare(
      `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state,
                            detected_at, updated_at)
       VALUES ('demo', ?, ?, '1.0.0', '1.0.1', ?, 'auto', 'pr_open', ?, ?)`,
    )
    .run(service, image, opts.magnitude ?? 'patch', at, at)
  return { id: Number(info.lastInsertRowid), image }
}

function pr(number: number, updateIds: number[], createdAt = new Date().toISOString()): number {
  const info = getDb()
    .prepare(
      `INSERT INTO prs (number, branch, head_sha_pushed, state, user_owned, created_at, scope)
       VALUES (?, ?, 'sha', 'open', 0, ?, 'tag-only')`,
    )
    .run(number, `shipshape/demo--${number}`, createdAt)
  const id = Number(info.lastInsertRowid)
  for (const u of updateIds) getDb().prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`).run(id, u)
  return id
}

function verdict(image: string, recommendation: string, confidence: string): void {
  getDb()
    .prepare(
      `INSERT INTO verdicts (image, from_tag, to_tag, summary, severity, breaking_changes, migration_steps,
                             new_features, recommendation, confidence, sources, model, created_at)
       VALUES (?, '1.0.0', '1.0.1', '', 'none', '[]', '[]', '[]', ?, ?, '[]', 'm', ?)`,
    )
    .run(image, recommendation, confidence, new Date().toISOString())
}

function failed(image: string): void {
  getDb()
    .prepare(
      `INSERT INTO verdicts (image, from_tag, to_tag, error, created_at, attempts)
       VALUES (?, '1.0.0', '1.0.1', 'boom', ?, 1)`,
    )
    .run(image, new Date().toISOString())
}

test('an approval at low confidence does not merge on its own', () => {
  const a = update('a')
  verdict(a.image, 'approve', 'low')
  const d = decide(pr(1, [a.id]), 1, 'tag-only', false, policy)
  assert.equal(d.merge, false)
  assert.match(d.reason, /low confidence/)
})

test('an approval at low confidence holds the whole group', () => {
  // The regression: the fold kept approve/high because approve is not "worse" than
  // approve, so the low member's confidence never reached the gate.
  const a = update('a')
  const b = update('b')
  verdict(a.image, 'approve', 'high')
  verdict(b.image, 'approve', 'low')
  const d = decide(pr(2, [a.id, b.id]), 2, 'tag-only', false, policy)
  assert.equal(d.merge, false)
  assert.match(d.reason, /^b: /)
})

test('every member approving with enough confidence merges', () => {
  const a = update('a')
  const b = update('b')
  verdict(a.image, 'approve', 'high')
  verdict(b.image, 'approve', 'medium')
  assert.equal(decide(pr(3, [a.id, b.id]), 3, 'tag-only', false, policy).merge, true)
})

test('an update whose review has not run yet waits for it', () => {
  const a = update('a')
  const d = decide(pr(4, [a.id]), 4, 'tag-only', false, policy)
  assert.equal(d.merge, false)
  assert.match(d.reason, /has not run yet/)
})

test('the wait is bounded, so an outage still degrades to static policy', () => {
  const old = new Date(Date.now() - REVIEW_WAIT_MS - 60_000).toISOString()
  const a = update('a', { detectedAt: old })
  assert.equal(decide(pr(5, [a.id], old), 5, 'tag-only', false, policy).merge, true)
})

test('a review that was tried and failed follows static policy, as before', () => {
  const a = update('a')
  failed(a.image)
  assert.equal(decide(pr(6, [a.id]), 6, 'tag-only', false, policy).merge, true)
})

test('nothing waits for a review that is switched off', () => {
  const a = update('a')
  const off = PolicySchema.parse({ paused: false, claude: { mode: 'off' } })
  assert.equal(decide(pr(7, [a.id]), 7, 'tag-only', false, off).merge, true)
})

test('memberVerdict: the clock is the later of the pull request and the update', () => {
  const now = Date.now()
  const longAgo = new Date(now - REVIEW_WAIT_MS * 2).toISOString()
  const recent = new Date(now - 60_000).toISOString()
  const row = { verdict_row: null, verdict_error: null, recommendation: null }
  // A pull request opened long ago and retargeted a minute ago is still waiting.
  assert.equal(memberVerdict({ ...row, pr_created_at: longAgo, detected_at: recent }, true, now), 'pending')
  assert.equal(memberVerdict({ ...row, pr_created_at: longAgo, detected_at: longAgo }, true, now), 'unavailable')
  // No review can be expected: nothing to wait for.
  assert.equal(memberVerdict({ ...row, pr_created_at: recent, detected_at: recent }, false, now), 'unavailable')
  // A row decides by itself.
  assert.equal(
    memberVerdict({ verdict_row: 'x', verdict_error: null, recommendation: 'caution', pr_created_at: recent, detected_at: recent }, true, now),
    'caution',
  )
  assert.equal(
    memberVerdict({ verdict_row: 'x', verdict_error: 'boom', recommendation: null, pr_created_at: recent, detected_at: recent }, true, now),
    'unavailable',
  )
})
