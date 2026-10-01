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

/** One watched service with an open pull request and a verdict, as the query expects it. */
function seed(opts: {
  number: number
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
       VALUES (?, ?, ?, '1.0.0', '1.1.0', 'minor', 'manual', 'pr_open', ?, ?)`,
    )
    .run(opts.stack, opts.stack, image, now, now)

  const p = db
    .prepare(
      `INSERT INTO prs (number, branch, head_sha_pushed, state, user_owned, scope, created_at)
       VALUES (?, ?, 'abc123', 'open', 0, 'tag-only', ?)`,
    )
    .run(opts.number, `shipshape/${opts.stack}`, now)

  db.prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`).run(
    p.lastInsertRowid,
    u.lastInsertRowid,
  )
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

test('under off, a pull request the review named work for is declined, not ignored', () => {
  writeStack('pihole')
  seed({ number: 132, stack: 'pihole', recommendation: 'caution', migrationSteps: ['migrate X'] })

  const r = pickCandidate('off')
  assert.equal(r.candidate, null, 'off must not draft on its own')
  assert.ok(r.declined, 'but it must say there was something to draft')
  assert.equal(r.declined?.number, 132)
})

test('under auto the same pull request is drafted', () => {
  writeStack('pihole')
  seed({ number: 132, stack: 'pihole', recommendation: 'caution', migrationSteps: ['migrate X'] })

  const r = pickCandidate('auto')
  assert.equal(r.candidate?.number, 132)
  assert.equal(r.declined, null, 'a picked candidate is not also a declined one')
})

// ---------------------------------------------------------- nothing to draft at all

test('an approved update with no steps is neither drafted nor declined', () => {
  // The distinction the operator reads: this pull request genuinely needs no change, and
  // must never be reported as one that was held back.
  writeStack('ddclient')
  seed({ number: 82, stack: 'ddclient', recommendation: 'approve', migrationSteps: [] })

  const r = pickCandidate('off')
  assert.equal(r.candidate, null)
  assert.equal(r.declined, null)
})

test('a service that opted out is not reported as declined by mode', () => {
  // `shipshape.propose: none` is the operator's own answer, already given per service.
  // Reporting it every day as work waiting on them would be noise, not news.
  writeStack('pihole', 'none')
  seed({ number: 132, stack: 'pihole', recommendation: 'caution', migrationSteps: ['migrate X'] })

  const r = pickCandidate('off')
  assert.equal(r.candidate, null)
  assert.equal(r.declined, null)
})

// --------------------------------------------------------------- the button bypass

test('the per-PR button bypasses the mode check and nothing else', () => {
  writeStack('pihole')
  seed({ number: 132, stack: 'pihole', recommendation: 'caution', migrationSteps: ['migrate X'] })

  const r = pickCandidate('off', 132)
  assert.equal(r.candidate?.number, 132, 'pressing the button drafts whatever the mode says')
  assert.equal(r.declined, null)
})

test('the button still refuses a service that opted out', () => {
  writeStack('pihole', 'none')
  seed({ number: 132, stack: 'pihole', recommendation: 'caution', migrationSteps: ['migrate X'] })

  assert.equal(pickCandidate('off', 132).candidate, null)
})

// --------------------------------------------------------- only the first is reported

test('declined names one pull request, not the backlog', () => {
  // A pass drafts at most one, so it reports at most one. The count is the thing that
  // would have to be kept accurate as the backlog moves, and nothing reads it.
  writeStack('homepage')
  writeStack('n8n')
  seed({ number: 62, stack: 'homepage', recommendation: 'block', migrationSteps: ['a'] })
  seed({ number: 91, stack: 'n8n', recommendation: 'block', migrationSteps: ['a', 'b'] })

  const r = pickCandidate('off')
  assert.equal(r.declined?.number, 62, 'the one it would have drafted: lowest number first')
})

// ------------------------------------------------------- what counts as work

test('a caution that names no steps is not drafting work', () => {
  // "Read this first" -- or "the notes could not be found" -- is a reason to hold, not a
  // configuration change. Each of these used to cost a code-model call that came back
  // with nothing to do.
  writeStack('homepage')
  seed({ number: 62, stack: 'homepage', recommendation: 'caution', migrationSteps: [] })
  assert.equal(pickCandidate('auto').candidate, null)
})

// ------------------------------------------------------------- failed drafts

function failedDraft(number: number, attempts: number, nextAttemptAt: string | null) {
  const db = getDb()
  const pr = db.prepare(`SELECT id FROM prs WHERE number = ?`).get(number) as { id: number }
  const u = db.prepare(`SELECT update_id FROM pr_updates WHERE pr_id = ?`).get(pr.id) as { update_id: number }
  db.prepare(
    `INSERT INTO proposals (pr_id, update_id, ops, notes, changed, error, created_at, retryable, attempts, next_attempt_at)
     VALUES (?, ?, '[]', '[]', '[]', 'rate limited', ?, 1, ?, ?)`,
  ).run(pr.id, u.update_id, new Date().toISOString(), attempts, nextAttemptAt)
}

test('a draft that failed waits out its backoff before it is tried again', () => {
  writeStack('pihole')
  seed({ number: 132, stack: 'pihole', recommendation: 'caution', migrationSteps: ['migrate X'] })
  failedDraft(132, 1, new Date(Date.now() + 60_000).toISOString())
  assert.equal(pickCandidate('auto').candidate, null, 'not every tick')

  getDb().exec(`DELETE FROM proposals`)
  failedDraft(132, 1, new Date(Date.now() - 60_000).toISOString())
  assert.equal(pickCandidate('auto').candidate?.number, 132, 'tried again once the wait is over')
})

test('a draft that gave up is not retried on its own, but the button still works', () => {
  writeStack('pihole')
  seed({ number: 132, stack: 'pihole', recommendation: 'caution', migrationSteps: ['migrate X'] })
  failedDraft(132, 3, null)
  assert.equal(pickCandidate('auto').candidate, null)
  assert.equal(pickCandidate('auto', 132).candidate?.number, 132)
})

test('a refused draft is final, for the button too', () => {
  writeStack('pihole')
  seed({ number: 132, stack: 'pihole', recommendation: 'caution', migrationSteps: ['migrate X'] })
  const db = getDb()
  const pr = db.prepare(`SELECT id FROM prs WHERE number = 132`).get() as { id: number }
  const u = db.prepare(`SELECT update_id FROM pr_updates WHERE pr_id = ?`).get(pr.id) as { update_id: number }
  db.prepare(
    `INSERT INTO proposals (pr_id, update_id, ops, notes, changed, error, created_at)
     VALUES (?, ?, '[]', '[]', '[]', 'touches a forbidden path', ?)`,
  ).run(pr.id, u.update_id, new Date().toISOString())
  assert.equal(pickCandidate('auto').candidate, null)
  assert.equal(pickCandidate('auto', 132).candidate, null)
})
