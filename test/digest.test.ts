import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render, renderHtml } from '../src/notify/digest.ts'
import { wants } from '../src/notify/index.ts'

/**
 * The digest is the whole point of batching, so what it says is worth asserting on.
 * `render` is pure and takes rows, so none of this needs a database or a network.
 */

let seq = 0
const row = (over: Partial<Parameters<typeof render>[0][number]> = {}) => ({
  id: ++seq,
  at: '2026-08-04T03:14:00.000Z',
  category: 'opened' as const,
  stack: null,
  service: null,
  summary: 'something happened',
  detail: null,
  url: null,
  ...over,
})

test('an empty batch renders nothing at all', () => {
  // null rather than an empty string, so "nothing to send" is a state the caller has to
  // handle rather than a message it might accidentally send. A scheduled "0 things"
  // push is how a person learns to ignore the channel.
  assert.equal(render([]), null)
})

test('one item names itself in the title rather than counting to one', () => {
  const m = render([row({ summary: 'radarr 5.28.0 -> 5.29.0 (#16)' })])!
  assert.equal(m.title, 'shipshape: radarr 5.28.0 -> 5.29.0 (#16)')
})

test('several items are counted in the title and listed under headings', () => {
  const m = render([
    row({ category: 'opened', stack: 'servarr', service: 'radarr', summary: 'a (#1)' }),
    row({ category: 'opened', stack: 'grafana', summary: 'b (#2)' }),
    row({ category: 'merged', stack: 'glances', summary: 'c (#3)' }),
  ])!
  assert.equal(m.title, 'shipshape: 3 updates')
  assert.match(m.body, /^2 pull requests opened$/m)
  assert.match(m.body, /^ {2}servarr\/radarr: a \(#1\)$/m)
  assert.match(m.body, /^ {2}grafana: b \(#2\)$/m)
  assert.match(m.body, /^1 merged$/m)
})

test('sections read in the order an update travels', () => {
  // The digest should tell the same story as the pipeline: what appeared, what landed,
  // what is still waiting on you.
  const m = render([
    row({ category: 'held', summary: 'h' }),
    row({ category: 'deployed', summary: 'd' }),
    row({ category: 'opened', summary: 'o' }),
    row({ category: 'merged', summary: 'm' }),
    row({ category: 'drafted', summary: 'p' }),
    row({ category: 'retargeted', summary: 'r' }),
  ])!
  const order = [
    'opened',
    'retargeted',
    'merged',
    'deployed',
    'carried drafted',
    'waiting on you',
  ].map((h) => m.body.indexOf(h))
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    m.body,
  )
})

test('a pull request moved onto a newer target gets its own heading', () => {
  // Not folded into "superseded and closed": nothing was closed, and a section heading
  // that says otherwise is how the digest stops describing what actually happened. An
  // unlisted category is silently dropped, so this is also the test that it is listed.
  const m = render([
    row({ category: 'retargeted', stack: 'servarr', service: 'radarr', summary: '5.28 -> 5.30 (#16)' }),
  ])!
  assert.match(m.body, /^1 retargeted$/m)
  assert.match(m.body, /^ {2}servarr\/radarr: 5\.28 -> 5\.30 \(#16\)$/m)
})

test('a heading agrees with itself on plurals', () => {
  assert.match(render([row()])!.body, /^1 pull request opened$/m)
  assert.match(render([row(), row()])!.body, /^2 pull requests opened$/m)
})

test('a long batch is truncated rather than becoming a log', () => {
  const m = render(Array.from({ length: 30 }, (_, i) => row({ summary: `item ${i}` })))!
  assert.equal(m.title, 'shipshape: 30 updates')
  assert.match(m.body, /^ {2}\.\.\.and 18 more$/m)
  // The heading still reports the true count, not the truncated one.
  assert.match(m.body, /^30 pull requests opened$/m)
  assert.ok(m.body.split('\n').length < 20, 'still readable on a phone')
})

test('an item with no stack does not render a stray separator', () => {
  const m = render([row({ stack: null, service: null, summary: 'bare' })])!
  assert.match(m.body, /^ {2}bare$/m)
  assert.ok(!m.body.includes(': bare'))
})

test('a stack with no service renders just the stack', () => {
  const m = render([row({ stack: 'immich', service: null, summary: 'x' })])!
  assert.match(m.body, /^ {2}immich: x$/m)
})

// ------------------------------------------------------------------------- html

test('the html digest links each item at the pull request it is about', () => {
  // The one reason a second renderer earns its keep: a push has a single click target
  // for the whole message, so the plain-text body leaves the per-item URLs out.
  const html = renderHtml([
    row({ stack: 'servarr', service: 'radarr', summary: '5.28 -> 5.29 (#18)', url: 'https://gh/18' }),
    row({ stack: 'grafana', summary: '12.4 -> 13.0 (#19)', url: 'https://gh/19' }),
  ])!
  assert.match(html, /<a href="https:\/\/gh\/18"[^>]*>servarr\/radarr: 5\.28 -&gt; 5\.29 \(#18\)<\/a>/)
  assert.match(html, /<a href="https:\/\/gh\/19"/)
  assert.match(html, /1 pull request opened|2 pull requests opened/)
})

test('an item with no url renders as text rather than an empty link', () => {
  const html = renderHtml([row({ url: null, summary: 'no link here' })])!
  assert.ok(!html.includes('href=""'), html)
  assert.match(html, /no link here/)
})

test('html output escapes everything that came from outside', () => {
  // Summaries carry tag names and, through them, whatever an upstream chose to publish.
  const html = renderHtml([
    row({
      stack: '<b>evil</b>',
      summary: 'a & b "quoted" <script>alert(1)</script>',
      url: 'https://x/?a=1&b=2',
      detail: '<img src=x>',
    }),
  ])!
  assert.ok(!html.includes('<script>'), html)
  assert.ok(!html.includes('<b>evil</b>'))
  assert.ok(!html.includes('<img src=x>'))
  assert.match(html, /&amp;/)
  assert.match(html, /href="https:\/\/x\/\?a=1&amp;b=2"/)
})

test('an empty batch has no html either', () => {
  assert.equal(renderHtml([]), null)
})

test('html and text agree on what was truncated', () => {
  const many = Array.from({ length: 30 }, (_, i) => row({ summary: `item ${i}` }))
  assert.match(render(many)!.body, /\.\.\.and 18 more/)
  assert.match(renderHtml(many)!, /and 18 more/)
})

// ---------------------------------------------------------------------- routing

test('channel routing: what each mode wants', () => {
  assert.equal(wants('all', 'alert'), true)
  assert.equal(wants('all', 'routine'), true)
  assert.equal(wants('off', 'alert'), false)
  assert.equal(wants('off', 'routine'), false)
  // The split that makes two channels worth having: push for what broke, mail for the
  // summary.
  assert.equal(wants('alerts', 'alert'), true)
  assert.equal(wants('alerts', 'routine'), false)
  assert.equal(wants('routine', 'routine'), true)
  assert.equal(wants('routine', 'alert'), false)
})

/**
 * The digest reports outcomes, not transitions.
 *
 * It used to replay every recorded step, so an update that opened, merged and deployed
 * overnight appeared three times and the 08:00 summary announced pull requests as
 * "opened" that had been running since 03:00.
 */

const pr = (n: number) => `https://github.com/o/r/pull/${n}`

test('a pull request that opened and then deployed is reported once, as deployed', () => {
  const m = render([
    row({ category: 'opened', stack: 'changedetection', service: 'changedetection', summary: 'a (#90)', url: pr(90) }),
    row({ category: 'deployed', stack: 'changedetection', summary: 'changedetection up in 51s', url: pr(90) }),
  ])!
  assert.match(m.body, /1 deployed/)
  assert.doesNotMatch(m.body, /opened/)
  // ...and counted once, not twice.
  assert.equal(m.title, 'shipshape: changedetection up in 51s')
})

test('the whole pipeline for one update collapses to its last stage', () => {
  const steps = ['opened', 'retargeted', 'drafted', 'held', 'merged', 'deployed'] as const
  const m = render(steps.map((category) => row({ category, summary: `${category} (#7)`, url: pr(7) })))!
  assert.match(m.body, /1 deployed/)
  for (const gone of ['opened', 'retargeted', 'drafted', 'waiting on you', 'merged']) {
    assert.doesNotMatch(m.body, new RegExp(gone))
  }
})

test('different pull requests stay separate, even for the same service', () => {
  // The case that makes the pull request the key rather than the service: one update
  // deployed and a second is waiting. Collapsing by service would hide the actionable
  // one behind the finished one.
  const m = render([
    row({ category: 'deployed', stack: 'paperless', service: 'litellm', summary: 'deployed (#66)', url: pr(66) }),
    row({ category: 'held', stack: 'paperless', service: 'litellm', summary: 'held (#70)', url: pr(70) }),
  ])!
  assert.match(m.body, /1 deployed/)
  assert.match(m.body, /1 waiting on you/)
})

test('the service name survives even when the winning row never knew it', () => {
  // A verdict hold records neither stack nor service; the row that opened the pull
  // request has both. Losing them would print a bare summary with no service prefix.
  const m = render([
    row({ category: 'opened', stack: 'paperless', service: 'litellm', summary: 'opened (#66)', url: pr(66) }),
    row({ category: 'held', stack: null, service: null, summary: 'held for review (#66)', url: pr(66) }),
  ])!
  assert.match(m.body, /paperless\/litellm: held for review/)
})

test('two records of the same stage keep the later one', () => {
  // #79 retargeted twice in one night, onto 2.96.7 and then 2.96.9.
  const m = render([
    row({ category: 'retargeted', stack: 'minuspod', summary: 'now 2.96.7 (#79)', url: pr(79) }),
    row({ category: 'retargeted', stack: 'minuspod', summary: 'now 2.96.9 (#79)', url: pr(79) }),
  ])!
  assert.match(m.body, /1 retargeted/)
  assert.match(m.body, /2\.96\.9/)
  assert.doesNotMatch(m.body, /2\.96\.7/)
})

test('an item with no pull request is never merged into another', () => {
  const m = render([
    row({ category: 'deployed', stack: 'a', summary: 'one', url: null }),
    row({ category: 'deployed', stack: 'b', summary: 'two', url: null }),
  ])!
  assert.match(m.body, /2 deployed/)
})

test('the html renderer collapses identically', () => {
  const rows = [
    row({ category: 'opened', stack: 'servarr', service: 'jackett', summary: 'opened (#89)', url: pr(89) }),
    row({ category: 'deployed', stack: 'servarr', summary: 'jackett up in 59s', url: pr(89) }),
  ]
  const html = renderHtml(rows)!
  assert.match(html, /1 deployed/)
  assert.doesNotMatch(html, /opened/)
})
