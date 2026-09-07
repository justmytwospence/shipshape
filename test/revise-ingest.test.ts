import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ingestable,
  prNumberOf,
  BREAKER_PER_HOUR,
  type CommentFacts,
  type IngestContext,
} from '../src/revise/ingest.ts'
import { mark } from '../src/gitops/comments.ts'

const EPOCH = '2026-09-01T00:00:00Z'

const facts = (over: Partial<CommentFacts> = {}): CommentFacts => ({
  id: 101,
  kind: 'issue',
  body: 'drop the PAPERLESS_HOST change, that variable is not set here',
  author: 'operator',
  authorType: 'User',
  association: 'OWNER',
  createdAt: '2026-09-07T10:00:00Z',
  ...over,
})

const ctx = (over: Partial<IngestContext> = {}): IngestContext => ({
  allow: new Set(['operator']),
  epoch: EPOCH,
  known: () => false,
  recentOnPr: 0,
  ...over,
})

test('an allowlisted owner’s comment is taken, with a namespaced id', () => {
  assert.deepEqual(ingestable(facts(), ctx()), { take: true, commentId: 'issue:101' })
  // The two id spaces are independent sequences, so the namespace is load-bearing: an
  // issue comment 101 and a review comment 101 are different comments.
  assert.deepEqual(ingestable(facts({ kind: 'review' }), ctx()), {
    take: true,
    commentId: 'review:101',
  })
})

test('someone else is refused, and the reason names them', () => {
  const r = ingestable(facts({ author: 'drive-by' }), ctx())
  assert.equal(r.take, false)
  assert.match(r.take === false ? r.why : '', /drive-by/)
})

test('a bot is refused even when it wears an allowlisted name', () => {
  // A GitHub App can be called anything. `user.type` is not something it chooses.
  const r = ingestable(facts({ authorType: 'Bot' }), ctx())
  assert.equal(r.take, false)
  assert.match(r.take === false ? r.why : '', /Bot/)
})

test('a non-writer is refused however friendly the association sounds', () => {
  // The only identity check that still discriminates once the token's login and the
  // operator's login are the same string.
  for (const association of ['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR']) {
    const r = ingestable(facts({ association }), ctx())
    assert.equal(r.take, false, association)
    assert.match(r.take === false ? r.why : '', new RegExp(association))
  }
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    assert.equal(ingestable(facts({ association }), ctx()).take, true, association)
  }
})

test('shipshape does not answer itself', () => {
  const own = `${mark('reply', 12)}\nDone — pushed as a second commit.`
  assert.equal(ingestable(facts({ body: own }), ctx()).take, false)
})

test('a quote-reply to shipshape IS an instruction', () => {
  // The regression that matters most. Quoting the bot is how a person answers a bot,
  // and Markdown keeps the HTML comment inside the blockquote -- so an `includes` test
  // would drop the operator's actual instruction and say nothing.
  const quoted = [`> ${mark('proposal')}`, '> ### Drafted config changes', '', 'No, revert that.'].join('\n')
  assert.equal(ingestable(facts({ body: quoted }), ctx()).take, true)
})

test('the ledger refuses a comment that has already been seen', () => {
  const r = ingestable(facts(), ctx({ known: (id) => id === 'issue:101' }))
  assert.equal(r.take, false)
  assert.match(r.take === false ? r.why : '', /already seen/)
})

test('the backlog is refused on created_at, so editing an old comment does not revive it', () => {
  // `since` is a payload window and an edit brings an old comment back through it. The
  // decision reads created_at precisely so that does not replay months of history.
  const r = ingestable(facts({ createdAt: '2026-08-01T00:00:00Z' }), ctx())
  assert.equal(r.take, false)
  assert.match(r.take === false ? r.why : '', /watermark/)
})

test('an empty comment is not an instruction', () => {
  for (const body of ['', '   \n  ', null, undefined]) {
    assert.equal(ingestable(facts({ body }), ctx()).take, false, JSON.stringify(body))
  }
})

test('the breaker stops a runaway thread, and says so', () => {
  assert.equal(ingestable(facts(), ctx({ recentOnPr: BREAKER_PER_HOUR - 1 })).take, true)
  const r = ingestable(facts(), ctx({ recentOnPr: BREAKER_PER_HOUR }))
  assert.equal(r.take, false)
  assert.match(r.take === false ? r.why : '', /in an hour/)
})

test('the pull request number comes out of the issue url', () => {
  assert.equal(prNumberOf('https://api.github.com/repos/o/r/issues/12'), 12)
  assert.equal(prNumberOf('https://api.github.com/repos/o/r/pulls/12'), null)
  assert.equal(prNumberOf(null), null)
})
