import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'shipshape-test-'))

const { getDb } = await import('../src/db.ts')
const { reconcile, render, renderHtml, outcomesFor } = await import('../src/notify/digest.ts')
type Outcome = import('../src/notify/digest.ts').Outcome

/**
 * The digest must not describe a pull request at a stage it has already left.
 *
 * It did, on 2026-09-11: #93 merged at 03:05, its deploy failed at 03:06, and the 08:00
 * email listed it under "1 pull request opened". Nothing was racing -- everything had
 * been still for five hours. The digest was built only from routine items, a merge is
 * not recorded for pull requests that deploy themselves, and a failed deploy records an
 * alert rather than an item. So "opened" was the last thing it had heard.
 */

type Row = Parameters<typeof render>[0][number]

let seq = 0
const row = (over: Partial<Row> = {}): Row => ({
  id: ++seq,
  at: '2026-09-11T09:03:00.000Z',
  category: 'opened',
  stack: null,
  service: null,
  summary: 'something happened',
  detail: null,
  url: null,
  ...over,
})

const pr = (n: number) => `https://github.com/justmytwospence/homelab/pull/${n}`

const outcome = (merged: boolean, status?: string, detail: string | null = null): Outcome => ({
  merged,
  deploy: status ? { status, detail } : null,
})

// ---------------------------------------------------------------------------------------
// The morning it happened
// ---------------------------------------------------------------------------------------

test('the batch from 2026-09-11 renders as what actually happened', () => {
  const compose = [
    'compose failed',
    '226fee4701b7 Pull complete 0B',
    'Image ttlequals0/minuspod:2.96.17-cpu Pulled',
    'Container minuspod Recreate',
    'healthcheck.start_interval requires healthcheck.start_period to be set',
  ].join('\n')

  const batch = [
    row({ category: 'opened', stack: 'minuspod', service: 'minuspod', summary: '2.96.15-cpu -> 2.96.17-cpu (#93)', url: pr(93) }),
    row({ category: 'opened', stack: 'openclaw', service: 'openclaw', summary: '2026.9.3 -> 2026.9.4 (#94)', url: pr(94) }),
    row({ category: 'opened', stack: 'plex', service: 'plex', summary: '1.43.3 -> 1.43.4 (#95)', url: pr(95) }),
    row({ category: 'retargeted', stack: 'wireguard', service: 'wireguard', summary: '1.0.20260223-r0-ls120 -> 1.0.20260223-r0-ls122 (#64)', url: pr(64) }),
    row({ category: 'retargeted', stack: 'n8n', summary: 'n8n-import, n8n 2.38.5 -> 2.38.7 (#91)', url: pr(91) }),
    row({ category: 'deployed', stack: 'openclaw', summary: '#94 deployed — openclaw up in 188s', url: pr(94) }),
    row({ category: 'deployed', stack: 'plex', summary: '#95 deployed — plex up in 84s', url: pr(95) }),
    row({ category: 'held', stack: 'code-server', service: 'code-server', summary: '#92 held — breaking changes in 4.137.0', url: pr(92) }),
    row({ category: 'held', stack: 'servarr', service: 'jackett', summary: '#96 held — breaking changes in v0.24.2554-ls24', url: pr(96) }),
  ]
  const outcomes = new Map<number, Outcome>([
    [93, outcome(true, 'failed', compose)],
    [94, outcome(true, 'verified', 'openclaw up in 188s')],
    [95, outcome(true, 'verified', 'plex up in 84s')],
    [64, outcome(false)],
    [91, outcome(false)],
    [92, outcome(false)],
    [96, outcome(false)],
  ])

  const m = render(reconcile(batch, outcomes))!

  // What it said: "1 pull request opened / minuspod/minuspod: ... (#93)".
  assert.doesNotMatch(m.body, /opened/)
  assert.match(
    m.body,
    /1 went wrong after merging\n  minuspod\/minuspod: #93 merged, but did not deploy: healthcheck\.start_interval requires healthcheck\.start_period to be set/,
  )
  assert.match(m.body, /2 deployed/)
  assert.match(m.body, /2 retargeted/)
  assert.match(m.body, /2 waiting on you/)
  // Seven pull requests, one line each.
  assert.equal(m.title, 'shipshape: 7 updates')
})

// ---------------------------------------------------------------------------------------
// Every way a merge can end badly
// ---------------------------------------------------------------------------------------

for (const [status, words] of [
  ['failed', 'merged, but did not deploy'],
  ['error', 'merged, but its deploy could not be run'],
  ['rolled-back', 'deployed, failed verification, and was rolled back'],
  ['degraded', 'deployed, then stopped being healthy'],
] as const) {
  test(`a deploy that ended ${status} is reported as going wrong`, () => {
    const batch = [row({ category: 'opened', stack: 'jellyfin', summary: 'a -> b (#10)', url: pr(10) })]
    const m = render(reconcile(batch, new Map([[10, outcome(true, status, 'the reason')]])))!
    assert.equal(m.title, `shipshape: #10 ${words}: the reason`)
  })
}

test('a recorded deploy that later degraded does not stay "deployed"', () => {
  // Passing the verify window records `deployed`; failing the soak half an hour later
  // records only an alert. The later truth has to win.
  const batch = [
    row({ category: 'opened', stack: 'scanopy', summary: 'a -> b (#87)', url: pr(87) }),
    row({ category: 'deployed', stack: 'scanopy', summary: '#87 deployed — scanopy up in 20s', url: pr(87) }),
  ]
  const m = render(
    reconcile(batch, new Map([[87, outcome(true, 'degraded', 'soak failed — scanopy: restarting')]])),
  )!
  assert.doesNotMatch(m.body, /deployed —/)
  assert.match(m.body, /#87 deployed, then stopped being healthy: soak failed — scanopy: restarting/)
})

test('a failure that a retry fixed is history', () => {
  // The outcome is the latest attempt. A verified retry means the digest says deployed.
  const batch = [
    row({ category: 'opened', stack: 'minuspod', summary: 'a -> b (#93)', url: pr(93) }),
    row({ category: 'deployed', stack: 'minuspod', summary: '#93 deployed — minuspod up in 40s', url: pr(93) }),
  ]
  const m = render(reconcile(batch, new Map([[93, outcome(true, 'verified')]])))!
  assert.equal(m.title, 'shipshape: #93 deployed — minuspod up in 40s')
})

// ---------------------------------------------------------------------------------------
// Merges that have not finished
// ---------------------------------------------------------------------------------------

for (const [status, words] of [
  ['pending', 'merged, deploy queued'],
  ['running', 'merged, deploy still running'],
  ['ready', 'merged, ready to deploy'],
  ['superseded', 'merged, its deploy folded into a later one'],
] as const) {
  test(`a merge whose deploy is ${status} is not "opened"`, () => {
    const batch = [row({ category: 'opened', stack: 'plex', summary: 'a -> b (#95)', url: pr(95) })]
    const m = render(reconcile(batch, new Map([[95, outcome(true, status)]])))!
    assert.equal(m.title, `shipshape: #95 ${words}`)
  })
}

test('a merge with no deploy at all still reads as merged', () => {
  const batch = [row({ category: 'opened', summary: 'a -> b (#5)', url: pr(5) })]
  const m = render(reconcile(batch, new Map([[5, outcome(true)]])))!
  assert.equal(m.title, 'shipshape: #5 merged')
})

test('an already-recorded merge is not said twice', () => {
  // Attended merges record `merged — ready to deploy` themselves. Reconciling must not
  // add a second line saying the same thing.
  const batch = [
    row({ category: 'opened', summary: 'a -> b (#64)', url: pr(64) }),
    row({ category: 'merged', summary: '#64 merged — ready to deploy', url: pr(64) }),
  ]
  const out = reconcile(batch, new Map([[64, outcome(true, 'ready')]]))
  assert.equal(out.length, batch.length)
  assert.equal(render(out)!.title, 'shipshape: #64 merged — ready to deploy')
})

// ---------------------------------------------------------------------------------------
// What it must leave alone
// ---------------------------------------------------------------------------------------

test('an open pull request keeps its recorded stage', () => {
  const batch = [row({ category: 'held', summary: '#92 held — read first', url: pr(92) })]
  assert.deepEqual(reconcile(batch, new Map([[92, outcome(false)]])), batch)
})

test('an outcome for a pull request not in the batch adds nothing', () => {
  // This corrects what the digest says about what it already mentions. It must never
  // decide what the digest is about.
  const batch = [row({ category: 'opened', summary: 'a -> b (#1)', url: pr(1) })]
  const out = reconcile(batch, new Map([[99, outcome(true, 'failed', 'x')]]))
  assert.deepEqual(out, batch)
})

test('items with no pull request are untouched', () => {
  const batch = [row({ category: 'drafted', summary: 'config drafted for grafana' })]
  assert.deepEqual(reconcile(batch, new Map([[1, outcome(true, 'failed')]])), batch)
})

test('the quoted reason is the last line, and a long one is cut', () => {
  const long = 'x'.repeat(140)
  const batch = [row({ category: 'opened', summary: 'a (#7)', url: pr(7) })]
  const m = render(reconcile(batch, new Map([[7, outcome(true, 'failed', `first\n\n  ${long}  \n`)]])))!
  assert.match(m.title, /did not deploy: x{99}…$/)
  const bare = render(reconcile(batch, new Map([[7, outcome(true, 'failed', null)]])))!
  assert.equal(bare.title, 'shipshape: #7 merged, but did not deploy')
})

// ---------------------------------------------------------------------------------------
// Where the reader should look
// ---------------------------------------------------------------------------------------

test('the email says which channel failures went to', () => {
  const batch = [row({ summary: 'a (#1)', url: pr(1) }), row({ summary: 'b (#2)', url: pr(2) })]
  assert.match(renderHtml(batch, { alertChannels: ['ntfy'] })!, /sent on their own, the moment they happen, by ntfy\./)
  assert.match(renderHtml(batch, { alertChannels: ['ntfy', 'email'] })!, /by ntfy and email\./)
  assert.match(renderHtml(batch, { alertChannels: [] })!, /this digest is the only place they appear/)
  assert.doesNotMatch(renderHtml(batch)!, /never in a digest/)
})

// ---------------------------------------------------------------------------------------
// Reading outcomes from the database
// ---------------------------------------------------------------------------------------

beforeEach(() => {
  getDb().exec(`DELETE FROM deploys; DELETE FROM prs;`)
})

function insertPr(number: number, state: string): number {
  return Number(
    getDb()
      .prepare(
        `INSERT INTO prs (number, branch, head_sha_pushed, state, created_at)
         VALUES (?, ?, 'sha', ?, datetime('now'))`,
      )
      .run(number, `b${number}`, state).lastInsertRowid,
  )
}

function insertDeploy(prId: number, number: number, status: string, detail: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO deploys (pr_number, pr_id, stack, services, strategy, ok, healthy, status,
                            attempts, created_at, detail)
       VALUES (?, ?, 'minuspod', 'minuspod', 'up', 0, 0, ?, 1, datetime('now'), ?)`,
    )
    .run(number, prId, status, detail)
}

test('outcomes come from the latest deploy, not the first', () => {
  const id = insertPr(93, 'merged')
  insertDeploy(id, 93, 'failed', 'compose failed\nhealthcheck broke')
  insertDeploy(id, 93, 'verified', 'minuspod up in 40s')

  const o = outcomesFor([row({ url: pr(93) })])
  assert.deepEqual(o.get(93), { merged: true, deploy: { status: 'verified', detail: 'minuspod up in 40s' } })
})

test('an open pull request with no deploy reads as not merged', () => {
  insertPr(92, 'open')
  assert.deepEqual(outcomesFor([row({ url: pr(92) })]).get(92), { merged: false, deploy: null })
})

test('only pull requests in the batch are looked up, and unknown ones are skipped', () => {
  const id = insertPr(50, 'merged')
  insertDeploy(id, 50, 'failed', 'x')
  const o = outcomesFor([row({ url: pr(51) }), row({ summary: 'no pr' })])
  assert.equal(o.size, 0)
})
