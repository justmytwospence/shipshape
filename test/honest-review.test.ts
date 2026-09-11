import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A changelog review that holds a merge has to say why, truthfully, and has to be
 * answerable when it is wrong.
 *
 * On 2026-09-11 #92 (code-server) and #96 (jackett) were held on `block` verdicts with
 * `low` confidence and an empty list of breaking changes. The model had found nothing
 * that breaks. It blocked because it believed the proposed tags did not exist -- they
 * were in the registry, which is how shipshape found them -- and the digest announced
 * both as "breaking changes". Nothing could re-read them: a verdict that had arrived was
 * never offered for a second reading.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-review-'))
process.env.DATA_DIR = dir
delete process.env.REPO_DIR
delete process.env.ANTHROPIC_API_KEY

const { getDb } = await import('../src/db.ts')
const { normalise, renderPrompt } = await import('../src/analyze/claude.ts')
const { pendingAnalysis, recordFailure, recordVerdict, heldSummary } = await import('../src/analyze/run.ts')
const { canAutoMerge, verdictHolds } = await import('../src/policy.ts')
const { contextFor, runVerb } = await import('../src/updates/verbs.ts')
const { actionsFor } = await import('../src/updates/actions.ts')
const { prompt } = await import('../src/prompts/index.ts')

after(() => rmSync(dir, { recursive: true, force: true }))

// ---------------------------------------------------------------------------------------
// A block names what breaks
// ---------------------------------------------------------------------------------------

test('a block that lists no breaking change is read as caution', () => {
  // What the model actually sent for #96.
  const v = normalise({
    summary: 'The specified image tags do not appear to exist in the official repository.',
    severity: 'high',
    breaking_changes: [],
    recommendation: 'block',
    confidence: 'low',
  })
  assert.equal(v.recommendation, 'caution')
  assert.equal(v.confidence, 'low')
})

test('a block that names a breaking change stays a block', () => {
  const v = normalise({ recommendation: 'block', breaking_changes: ['POSTGRES_HOST renamed to DB_HOST'], confidence: 'high' })
  assert.equal(v.recommendation, 'block')
})

test('the backstop only ever moves toward caution, never to approve', () => {
  // A hostile changelog's best outcome is still a stopped update.
  for (const rec of ['approve', 'caution', 'block', 'nonsense', undefined]) {
    for (const breaking of [[], ['x'], 'not-an-array']) {
      const before = rec === 'approve' ? 'approve' : rec === 'block' ? 'block' : 'caution'
      const after = normalise({ recommendation: rec as never, breaking_changes: breaking as never }).recommendation
      if (before !== 'approve') assert.notEqual(after, 'approve', `${rec} with ${JSON.stringify(breaking)}`)
    }
  }
})

test('caution holds a merge exactly as block does, so the backstop changes the label only', () => {
  for (const conf of ['low', 'medium', 'high'] as const) {
    assert.equal(verdictHolds('block', conf, 'medium'), verdictHolds('caution', conf, 'medium'))
  }
})

// ---------------------------------------------------------------------------------------
// The tags are facts
// ---------------------------------------------------------------------------------------

const noBundle = { releases: [], commits: [], containerChangelog: [], notes: [] } as never

test('the prompt states both tags were read from the registry', () => {
  const text = renderPrompt(
    { image: 'linuxserver/jackett:v0.24.2551-ls23', fromTag: 'v0.24.2551-ls23', toTag: 'v0.24.2554-ls24', observedAt: '2026-09-11T09:02:45.128Z' },
    noBundle,
    'Jackett/Jackett',
  )
  assert.match(text, /Current version: v0\.24\.2551-ls23 \(running now\)/)
  assert.match(text, /Proposed version: v0\.24\.2554-ls24 \(published in the registry, first seen 2026-09-11T09:02:45\.128Z\)/)
  assert.match(text, /Both tags were read from the registry and exist/)
})

test('the system prompt forbids blocking on notes that could not be matched', () => {
  const system = prompt('verdict')
  assert.match(system, /a version "not existing" is never a finding/)
  assert.match(system, /never a\s+reason to `block`/)
  assert.match(system, /A block\s+names what breaks/)
})

// ---------------------------------------------------------------------------------------
// Which verdicts hold, asked of the gate
// ---------------------------------------------------------------------------------------

test('verdictHolds agrees with the merge gate for every verdict and confidence', () => {
  for (const verdict of ['approve', 'caution', 'block', 'unavailable'] as const) {
    for (const confidence of ['low', 'medium', 'high', null] as const) {
      for (const minConfidence of ['low', 'medium', 'high'] as const) {
        const gate = canAutoMerge({
          tier: 'auto', magnitude: 'minor', prScope: 'tag-only', verdict, confidence,
          claudeRequired: false, claudeMode: 'advisory', minConfidence,
        })
        assert.equal(verdictHolds(verdict, confidence, minConfidence), !gate.merge, `${verdict}/${confidence}/${minConfidence}`)
      }
    }
  }
})

test('the digest says what kind of hold it is, and nothing for a verdict that merges', () => {
  assert.equal(heldSummary(96, 'v0.24.2554-ls24', { recommendation: 'block', confidence: 'high' }, 'medium'), '#96 held — breaking changes in v0.24.2554-ls24')
  assert.equal(heldSummary(92, '4.137.0', { recommendation: 'caution', confidence: 'low' }, 'medium'), '#92 held — worth a read before 4.137.0')
  assert.equal(heldSummary(5, '1.2.3', { recommendation: 'approve', confidence: 'low' }, 'medium'), '#5 held — approved, but only at low confidence')
  assert.equal(heldSummary(5, '1.2.3', { recommendation: 'approve', confidence: 'medium' }, 'medium'), null)
})

// ---------------------------------------------------------------------------------------
// Reading again, without ever loosening a hold
// ---------------------------------------------------------------------------------------

const now = () => new Date().toISOString()
const pair = { image: 'linuxserver/jackett:v0.24.2551-ls23', from_tag: 'v0.24.2551-ls23', to_tag: 'v0.24.2554-ls24' }

beforeEach(() => {
  const db = getDb()
  for (const t of ['pr_updates', 'prs', 'updates', 'verdicts']) db.prepare(`DELETE FROM ${t}`).run()
})

function seedHeldPr(): number {
  const db = getDb()
  const u = Number(
    db.prepare(
      `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state, detail, detected_at, updated_at)
       VALUES ('servarr', 'jackett', ?, ?, ?, 'patch', 'auto', 'pr_open', NULL, ?, ?)`,
    ).run(pair.image, pair.from_tag, pair.to_tag, now(), now()).lastInsertRowid,
  )
  const p = Number(
    db.prepare(
      `INSERT INTO prs (number, branch, head_sha_pushed, state, scope, created_at) VALUES (96, 'b', 'sha', 'open', 'tag-only', ?)`,
    ).run(now()).lastInsertRowid,
  )
  db.prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`).run(p, u)
  return u
}

const blockVerdict = { summary: 'tags do not exist', severity: 'high', breaking_changes: ['Version does not exist'], migration_steps: [], recommendation: 'block', confidence: 'low', sources: [] } as const

function stored() {
  return getDb()
    .prepare(`SELECT recommendation, error, rerun_requested_at FROM verdicts WHERE image = ? AND from_tag = ? AND to_tag = ?`)
    .get(pair.image, pair.from_tag, pair.to_tag) as { recommendation: string | null; error: string | null; rerun_requested_at: string | null }
}

test('a held pull request offers a second reading, and asking for one flags rather than deletes', async () => {
  const id = seedHeldPr()
  recordVerdict(pair, blockVerdict as never)

  const ctx = contextFor(id)!.ctx
  assert.equal(ctx.verdictHolds, true)
  assert.ok(actionsFor(ctx).includes('rerun-review'))

  const r = await runVerb(id, 'rerun-review')
  assert.equal(r.ok, true, r.message)
  const v = stored()
  assert.equal(v.recommendation, 'block', 'the hold stays in force while it is re-read')
  assert.ok(v.rerun_requested_at)
})

test('a flagged verdict is analysed again, ahead of everything else', () => {
  seedHeldPr()
  recordVerdict(pair, blockVerdict as never)
  assert.equal(pendingAnalysis(10).length, 0, 'a verdict that arrived is not pending')

  getDb().prepare(`UPDATE verdicts SET rerun_requested_at = ?`).run(now())
  const pending = pendingAnalysis(10)
  assert.equal(pending.length, 1)
  assert.equal(pending[0]!.rerun, 1)
  assert.ok(pending[0]!.detected_at)
})

test('a re-read that fails leaves the verdict it was replacing exactly where it was', () => {
  // The failure this exists to prevent: writing the error over the block would make the
  // gate see "no verdict", fall back to static policy, and merge an auto-rung update.
  seedHeldPr()
  recordVerdict(pair, blockVerdict as never)
  getDb().prepare(`UPDATE verdicts SET rerun_requested_at = ?`).run(now())

  recordFailure(pair, 'overloaded')
  const v = stored()
  assert.equal(v.recommendation, 'block')
  assert.equal(v.error, null)
  assert.equal(v.rerun_requested_at, null, 'and it is not retried forever')
})

test('a re-read that succeeds replaces the verdict and clears the request', () => {
  seedHeldPr()
  recordVerdict(pair, blockVerdict as never)
  getDb().prepare(`UPDATE verdicts SET rerun_requested_at = ?`).run(now())

  recordVerdict(pair, { ...blockVerdict, recommendation: 'approve', confidence: 'high', breaking_changes: [] } as never)
  const v = stored()
  assert.equal(v.recommendation, 'approve')
  assert.equal(v.rerun_requested_at, null)
})

test('a first reading that fails is still recorded as an error, as before', () => {
  seedHeldPr()
  recordFailure(pair, 'overloaded')
  const v = stored()
  assert.equal(v.recommendation, null)
  assert.equal(v.error, 'overloaded')
})
