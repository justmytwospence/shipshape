import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'shipshape-decline-data-'))
const repoDir = mkdtempSync(join(tmpdir(), 'shipshape-decline-repo-'))
process.env.DATA_DIR = dataDir
process.env.REPO_DIR = repoDir

const { getDb } = await import('../src/db.ts')
const { pickCandidate } = await import('../src/propose/run.ts')

after(() => {
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(repoDir, { recursive: true, force: true })
})

/**
 * Telling "nothing to draft" apart from "something to draft, and you asked me not to".
 *
 * These were one answer for the life of the feature. `propose.mode` sat at `manual` from
 * the day it shipped, and a manual pass does not take the `off` early-out: it ran the
 * whole query every tick, found a pull request, dropped it on the mode check and returned
 * the same empty result as a pass with no work in front of it. Every logEvent in the file
 * sits downstream of a candidate being picked, so there was no event, no comment and no
 * digest line either.
 *
 * pihole #132 is the case that surfaced it. The review named a migration step, nothing was
 * drafted, and the pull request read as though shipshape had no drafting feature at all --
 * which is what the operator concluded. The bug is not that it declined; it is that
 * declining and having nothing to do were indistinguishable.
 */

function compose(service: string, proposeLabel?: string) {
  const labels = [
    '      shipshape.watch: "true"',
    '      shipshape.pattern: semver',
    ...(proposeLabel ? [`      shipshape.propose: ${proposeLabel}`] : []),
  ].join('\n')
  return `services:\n  ${service}:\n    image: example/${service}:1.0.0\n    labels:\n${labels}\n`
}

const idOf: Record<string, number> = {}

/** One watched service with a detected update and a verdict, as the query expects it. */
function seed(opts: {
  stack: string
  recommendation: string | null
  migrationSteps: string[]
}) {
  const db = getDb()
  const now = new Date('2026-09-20T09:00:00Z').toISOString()
  const image = `example/${opts.stack}`
  db.prepare(
    `INSERT INTO images (stack, service, compose_file, image_ref, registry, repository,
                         current_tag, watched, last_seen_at)
     VALUES (?, ?, ?, ?, 'docker.io', ?, '1.0.0', 1, ?)`,
  ).run(opts.stack, opts.stack, `${opts.stack}/docker-compose.yaml`, `${image}:1.0.0`, image, now)

  const u = db
    .prepare(
      `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state,
                            detected_at, updated_at)
       VALUES (?, ?, ?, '1.0.0', '1.1.0', 'minor', 'ask', 'detected', ?, ?)`,
    )
    .run(opts.stack, opts.stack, image, now, now)
  idOf[opts.stack] = Number(u.lastInsertRowid)

  db.prepare(
    `INSERT INTO verdicts (image, from_tag, to_tag, summary, severity, breaking_changes,
                           migration_steps, recommendation, confidence, sources, created_at)
     VALUES (?, '1.0.0', '1.1.0', 'a summary', 'medium', '[]', ?, ?, 'high', '[]', ?)`,
  ).run(image, JSON.stringify(opts.migrationSteps), opts.recommendation, now)
}

beforeEach(() => {
  getDb().exec(
    `DELETE FROM pr_updates; DELETE FROM prs; DELETE FROM updates;
     DELETE FROM verdicts; DELETE FROM images; DELETE FROM proposals;`,
  )
  rmSync(repoDir, { recursive: true, force: true })
  mkdirSync(repoDir, { recursive: true })
})

function writeStack(stack: string, proposeLabel?: string) {
  mkdirSync(join(repoDir, stack), { recursive: true })
  writeFileSync(join(repoDir, stack, 'docker-compose.yaml'), compose(stack, proposeLabel))
}

// ------------------------------------------------------- work exists, mode says no

test('under off, an update the review named work for is declined, not ignored', () => {
  writeStack('pihole')
  seed({ stack: 'pihole', recommendation: 'caution', migrationSteps: ['migrate X'] })

  const r = pickCandidate('off')
  assert.equal(r.candidate, null, 'off must not draft on its own')
  assert.ok(r.declined, 'but it must say there was something to draft')
  assert.equal(r.declined?.stack, 'pihole')
})

test('under auto the same update is drafted', () => {
  writeStack('pihole')
  seed({ stack: 'pihole', recommendation: 'caution', migrationSteps: ['migrate X'] })

  const r = pickCandidate('auto')
  assert.equal(r.candidate?.stack, 'pihole')
  assert.equal(r.declined, null, 'a picked candidate is not also a declined one')
})

// ---------------------------------------------------------- nothing to draft at all

test('an approved update with no steps is neither drafted nor declined', () => {
  // The distinction the operator reads: this update genuinely needs no change, and
  // must never be reported as one that was held back.
  writeStack('ddclient')
  seed({ stack: 'ddclient', recommendation: 'approve', migrationSteps: [] })

  const r = pickCandidate('off')
  assert.equal(r.candidate, null)
  assert.equal(r.declined, null)
})

test('a service that opted out is not reported as declined by mode', () => {
  // `shipshape.propose: none` is the operator's own answer, already given per service.
  // Reporting it every day as work waiting on them would be noise, not news.
  writeStack('pihole', 'none')
  seed({ stack: 'pihole', recommendation: 'caution', migrationSteps: ['migrate X'] })

  const r = pickCandidate('off')
  assert.equal(r.candidate, null)
  assert.equal(r.declined, null)
})

// --------------------------------------------------------------- the button bypass

test('the button bypasses the mode check and nothing else', () => {
  writeStack('pihole')
  seed({ stack: 'pihole', recommendation: 'caution', migrationSteps: ['migrate X'] })

  const r = pickCandidate('off', idOf.pihole)
  assert.equal(r.candidate?.stack, 'pihole', 'pressing the button drafts whatever the mode says')
  assert.equal(r.declined, null)
})

test('the button still refuses a service that opted out', () => {
  writeStack('pihole', 'none')
  seed({ stack: 'pihole', recommendation: 'caution', migrationSteps: ['migrate X'] })

  assert.equal(pickCandidate('off', idOf.pihole).candidate, null)
})

// --------------------------------------------------------- only the first is reported

test('declined names one update, not the backlog', () => {
  // A pass drafts at most one, so it reports at most one. The count is the thing that
  // would have to be kept accurate as the backlog moves, and nothing reads it.
  writeStack('homepage')
  writeStack('n8n')
  seed({ stack: 'homepage', recommendation: 'block', migrationSteps: ['a'] })
  seed({ stack: 'n8n', recommendation: 'block', migrationSteps: ['a', 'b'] })

  const r = pickCandidate('off')
  assert.equal(r.declined?.stack, 'homepage', 'the one it would have drafted: lowest id first')
})

// ------------------------------------------------------- what counts as work

test('a caution that names no steps is not drafting work', () => {
  // "Read this first" -- or "the notes could not be found" -- is a reason to hold, not a
  // configuration change. Each of these used to cost a code-model call that came back
  // with nothing to do.
  writeStack('homepage')
  seed({ stack: 'homepage', recommendation: 'caution', migrationSteps: [] })
  assert.equal(pickCandidate('auto').candidate, null)
})

// ------------------------------------------------------------- failed drafts

function failedDraft(stack: string, attempts: number, nextAttemptAt: string | null) {
  const db = getDb()
  const updateId = idOf[stack]!
  const info = db
    .prepare(
      `INSERT INTO prs (number, branch, head_sha_pushed, state, scope, kind, created_at)
       VALUES (0, ?, '', 'open', 'tag-only', 'local', ?)`,
    )
    .run(`shipshape/${stack}--draft`, new Date().toISOString())
  db.prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`).run(info.lastInsertRowid, updateId)
  db.prepare(
    `INSERT INTO proposals (pr_id, update_id, ops, notes, changed, error, created_at, retryable, attempts, next_attempt_at)
     VALUES (?, ?, '[]', '[]', '[]', 'rate limited', ?, 1, ?, ?)`,
  ).run(info.lastInsertRowid, updateId, new Date().toISOString(), attempts, nextAttemptAt)
}

test('a draft that failed waits out its backoff before it is tried again', () => {
  writeStack('pihole')
  seed({ stack: 'pihole', recommendation: 'caution', migrationSteps: ['migrate X'] })
  failedDraft('pihole', 1, new Date(Date.now() + 60_000).toISOString())
  assert.equal(pickCandidate('auto').candidate, null, 'not every tick')

  getDb().exec(`DELETE FROM proposals`)
  failedDraft('pihole', 1, new Date(Date.now() - 60_000).toISOString())
  assert.equal(pickCandidate('auto').candidate?.stack, 'pihole', 'tried again once the wait is over')
})

test('a draft that gave up is not retried on its own, but the button still works', () => {
  writeStack('pihole')
  seed({ stack: 'pihole', recommendation: 'caution', migrationSteps: ['migrate X'] })
  failedDraft('pihole', 3, null)
  assert.equal(pickCandidate('auto').candidate, null)
  assert.equal(pickCandidate('auto', idOf.pihole).candidate?.stack, 'pihole')
})

test('a refused draft is final, for the button too', () => {
  writeStack('pihole')
  seed({ stack: 'pihole', recommendation: 'caution', migrationSteps: ['migrate X'] })
  const db = getDb()
  const info = db
    .prepare(
      `INSERT INTO prs (number, branch, head_sha_pushed, state, scope, kind, created_at)
       VALUES (0, 'shipshape/pihole--draft', '', 'open', 'tag-only', 'local', ?)`,
    )
    .run(new Date().toISOString())
  db.prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`).run(info.lastInsertRowid, idOf.pihole)
  db.prepare(
    `INSERT INTO proposals (pr_id, update_id, ops, notes, changed, error, created_at)
     VALUES (?, ?, '[]', '[]', '[]', 'touches a forbidden path', ?)`,
  ).run(info.lastInsertRowid, idOf.pihole, new Date().toISOString())
  assert.equal(pickCandidate('auto').candidate, null)
  assert.equal(pickCandidate('auto', idOf.pihole).candidate, null)
})
