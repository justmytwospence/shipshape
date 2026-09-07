import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isOurComment, mark } from '../src/gitops/comments.ts'

/**
 * The loop guard, and the one way it must not fail.
 *
 * shipshape's token is the operator's, so its comments carry the operator's login and
 * author identity proves nothing. These assertions are what stands between "reads its
 * own comment as an instruction" and "silently ignores the operator".
 */

test('a marker names its kind, and may name what it is about', () => {
  assert.equal(mark('superseded'), '<!-- shipshape:superseded -->')
  assert.equal(mark('reply', 42), '<!-- shipshape:reply:42 -->')
})

test('a comment shipshape wrote is recognised by its first line', () => {
  assert.equal(isOurComment(`${mark('proposal')}\n### Drafted config changes`), true)
  assert.equal(isOurComment(`${mark('reply', 7)}\nDone — pushed as a second commit.`), true)
})

test('a quote-reply to shipshape is the operator talking, not shipshape', () => {
  // GitHub's "Quote reply" copies the quoted body verbatim behind "> ", and Markdown
  // preserves HTML comments inside a blockquote. A `body.includes(MARK)` test would call
  // this ours and drop it -- and quoting the bot is how a person answers a bot. The loop
  // guard has to fail toward acting, because the loop is bounded by a rate limit and a
  // swallowed instruction is bounded by nothing.
  const quoted = [
    '> <!-- shipshape:proposal -->',
    '> ### Drafted config changes',
    '> Renamed PAPERLESS_HOST to PAPERLESS_URL.',
    '',
    'No — that variable is not set here. Drop it.',
  ].join('\n')
  assert.equal(isOurComment(quoted), false)
})

test('an ordinary comment is not ours, however it is worded', () => {
  assert.equal(isOurComment('shipshape: please hold this one'), false)
  assert.equal(isOurComment('<!-- a note to self -->\nremember to check the volume'), false)
  assert.equal(isOurComment(''), false)
  assert.equal(isOurComment(null), false)
  assert.equal(isOurComment(undefined), false)
})

test('leading whitespace does not hide a marker, and a trailing one does not create it', () => {
  assert.equal(isOurComment(`   ${mark('held')}\nheld`), true)
  // A marker that only appears at the end is not the shape anything here writes, and
  // treating it as ours would be the `includes` bug wearing a different hat.
  assert.equal(isOurComment(`I think this is fine\n${mark('held')}`), false)
})
