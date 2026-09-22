import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'shipshape-budget-'))
process.env.DATA_DIR = dir

const { getDb } = await import('../src/db.ts')
const { classifyBudget, resumesOn, mergedUnreviewedSince, budgetHealth, resetBudgetHealth } =
  await import('../src/health/analysis-budget.ts')

after(() => rmSync(dir, { recursive: true, force: true }))

/**
 * Saying so when the analysis budget runs out.
 *
 * The silence this covers ran twice: the cap was reached on 2026-08-27 and again on
 * 2026-09-14, and each time the only trace was a single warning line. 39 of the 40 pull
 * requests merged in the week after the second one were merged with no changelog read.
 *
 * The mechanism is the part worth a regression test. The warning lived in `recordCost`,
 * which only runs when a model call is made, so it stopped being emitted at exactly the
 * moment the condition it reported began -- a message that goes quiet because the problem
 * got worse.
 */

beforeEach(() => {
  resetBudgetHealth()
  getDb().exec(`DELETE FROM pr_updates; DELETE FROM prs; DELETE FROM updates; DELETE FROM verdicts;`)
})

// ------------------------------------------------------------------ is it spent

test('the budget is spent when it is reached, not merely when it is passed', () => {
  // Both real incidents crossed it by pennies: $10.04 and $10.10 of $10. `>=` is what
  // makes the second of those count.
  assert.equal(classifyBudget(10.04, 10).exhausted, true)
  assert.equal(classifyBudget(10, 10).exhausted, true)
  assert.equal(classifyBudget(9.99, 10).exhausted, false)
})

test('an unset ceiling is not an exhausted one', () => {
  // Zero reads as "no ceiling configured". Alerting every tick of every install that never
  // set a budget is how the channel this uses would get muted.
  assert.equal(classifyBudget(50, 0).exhausted, false)
  assert.equal(classifyBudget(0, 0).exhausted, false)
  assert.equal(classifyBudget(50, -1).exhausted, false)
})

// ------------------------------------------------------------- when it comes back

test('it says which day analysis resumes on its own', () => {
  // monthlySpend returns 0 once the recorded window is not the current month, so the stop
  // clears at midnight on the 1st with nothing to reset. That makes the date sayable, and
  // a date is what lets the operator choose to wait rather than guess.
  assert.equal(resumesOn(new Date('2026-09-14T09:03:58Z')), '2026-10-01')
  assert.equal(resumesOn(new Date('2026-09-30T23:59:59Z')), '2026-10-01')
})

test('the year rolls over with the month', () => {
  assert.equal(resumesOn(new Date('2026-12-05T00:00:00Z')), '2027-01-01')
  assert.equal(resumesOn(new Date('2026-12-31T23:59:00Z')), '2027-01-01')
})

// ------------------------------------------------------- how much went through unread

const now = '2026-09-15T09:00:00.000Z'

function merged(number: number, at: string, reviewed: boolean): void {
  const db = getDb()
  const pr = db
    .prepare(
      `INSERT INTO prs (number, branch, head_sha_pushed, state, created_at, merged_at)
       VALUES (?, ?, 'sha', 'merged', ?, ?)`,
    )
    .run(number, `b${number}`, at, at)
  const u = db
    .prepare(
      `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state,
                            detected_at, updated_at)
       VALUES ('s', ?, ?, '1.0', '2.0', 'minor', 'auto', 'merged', ?, ?)`,
    )
    .run(`svc${number}`, `img${number}`, at, at)
  db.prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`).run(
    Number(pr.lastInsertRowid),
    Number(u.lastInsertRowid),
  )
  if (reviewed) {
    db.prepare(
      `INSERT INTO verdicts (image, from_tag, to_tag, recommendation, confidence, created_at)
       VALUES (?, '1.0', '2.0', 'approve', 'high', ?)`,
    ).run(`img${number}`, at)
  }
}

test('it counts the pull requests that merged unread, and only those', () => {
  merged(1, '2026-09-15T09:00:00.000Z', false)
  merged(2, '2026-09-16T09:00:00.000Z', false)
  merged(3, '2026-09-17T09:00:00.000Z', true) // reviewed: not counted
  assert.equal(mergedUnreviewedSince('2026-09-14T09:03:00.000Z'), 2)
})

test('merges from before the budget ran out are not blamed on it', () => {
  merged(1, '2026-09-10T09:00:00.000Z', false)
  merged(2, '2026-09-15T09:00:00.000Z', false)
  assert.equal(mergedUnreviewedSince('2026-09-14T09:03:00.000Z'), 1)
})

test('a verdict that errored is not a review', () => {
  // A failed analysis leaves a row behind. Counting it as read would under-report exactly
  // the updates most worth naming.
  merged(1, now, false)
  getDb()
    .prepare(
      `INSERT INTO verdicts (image, from_tag, to_tag, recommendation, error, created_at)
       VALUES ('img1', '1.0', '2.0', NULL, 'rate limited', ?)`,
    )
    .run(now)
  assert.equal(mergedUnreviewedSince('2026-09-14T09:03:00.000Z'), 1)
})

test('nothing merged unread is zero, not an error', () => {
  assert.equal(mergedUnreviewedSince('2026-09-14T09:03:00.000Z'), 0)
})

// --------------------------------------------------------------- the standing state

test('nothing is standing until something says so', () => {
  assert.equal(budgetHealth().ok, true)
  assert.equal(budgetHealth().since, undefined)
})
