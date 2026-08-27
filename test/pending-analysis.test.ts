import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Which updates get paid for.
 *
 * A changelog review costs a model call, so the set that gets one is a budget decision
 * as much as a product one. Open pull requests are the original set: a person is waiting
 * on the answer. Updates that applied on their own were added so the releases feed has
 * something to say about them, and patches were left out of that because they are most
 * of the volume and least of the interest.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-pending-'))
process.env.DATA_DIR = dir
process.env.GITHUB_REPO = 'you/repo'
delete process.env.REPO_DIR

const { getDb } = await import('../src/db.ts')
const { pendingAnalysis } = await import('../src/analyze/run.ts')

after(() => rmSync(dir, { recursive: true, force: true }))

const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()

let seq = 0
function addUpdate(o: { service: string; magnitude: string; detectedAt?: string }): number {
  seq++
  const at = o.detectedAt ?? ago(1)
  const info = getDb()
    .prepare(
      `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state,
                            detail, detected_at, updated_at, acked_at)
       VALUES ('media', ?, ?, ?, ?, ?, 'auto', 'verified', NULL, ?, ?, NULL)`,
    )
    .run(o.service, `img/${o.service}`, `1.0.${seq}`, `1.1.${seq}`, o.magnitude, at, at)
  return Number(info.lastInsertRowid)
}

function openPrFor(updateId: number, number: number): void {
  const db = getDb()
  const pr = db
    .prepare(
      `INSERT INTO prs (number, branch, head_sha_pushed, state, scope, created_at)
       VALUES (?, 'b', 'sha', 'open', 'tag-only', ?)`,
    )
    .run(number, ago(1))
  db.prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`).run(
    Number(pr.lastInsertRowid),
    updateId,
  )
}

test('a patch that applied without a pull request is not worth a model call', () => {
  addUpdate({ service: 'patchy', magnitude: 'patch' })
  const picked = pendingAnalysis(50).map((p) => p.service)
  assert.ok(!picked.includes('patchy'), 'patches are link-only')
})

test('a minor or major that applied on its own does get reviewed', () => {
  addUpdate({ service: 'minory', magnitude: 'minor' })
  addUpdate({ service: 'majory', magnitude: 'major' })
  const picked = pendingAnalysis(50).map((p) => p.service)
  assert.ok(picked.includes('minory'), 'a minor with no PR still gets read')
  assert.ok(picked.includes('majory'), 'so does a major')
})

test('a patch with an open pull request is still reviewed, because a decision waits on it', () => {
  // The magnitude rule is about what is worth reading unprompted. It must not remove the
  // review from something a person is being asked to merge.
  const id = addUpdate({ service: 'patch-with-pr', magnitude: 'patch' })
  openPrFor(id, 101)
  const row = pendingAnalysis(50).find((p) => p.service === 'patch-with-pr')
  assert.ok(row, 'an open pull request always wants a verdict')
  assert.equal(row.has_pr, 1)
})

test('open pull requests are analysed before anything nobody is waiting on', () => {
  const id = addUpdate({ service: 'blocking', magnitude: 'minor', detectedAt: ago(200) })
  openPrFor(id, 102)
  addUpdate({ service: 'just-reading', magnitude: 'major', detectedAt: ago(1) })

  const picked = pendingAnalysis(50)
  const blocking = picked.findIndex((p) => p.service === 'blocking')
  const reading = picked.findIndex((p) => p.service === 'just-reading')
  assert.ok(blocking >= 0 && reading >= 0, 'both are candidates')
  assert.ok(blocking < reading, 'the one with a decision waiting on it goes first')
})

test('the unreviewed backfill is bounded, so shipping this is not a one-off bill', () => {
  addUpdate({ service: 'ancient', magnitude: 'major', detectedAt: ago(24 * 400) })
  const picked = pendingAnalysis(50).map((p) => p.service)
  assert.ok(!picked.includes('ancient'), 'old releases keep their links, not a model call')
})
