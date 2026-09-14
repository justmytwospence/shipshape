import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSourceLabel, normaliseSourceUrl } from '../src/resolver/labels.ts'

/**
 * `shipshape.source`, as an operator writes it.
 *
 * It used to accept only full GitHub URLs and to ignore everything else without a word, so a
 * label that looked right -- `ttlequals0/MinusPod` -- could be doing nothing at all.
 */

test('the repository may be written any of the ways people write it', () => {
  const cases: [string, string][] = [
    ['ttlequals0/MinusPod', 'ttlequals0/MinusPod'],
    ['  ggml-org/whisper.cpp  ', 'ggml-org/whisper.cpp'],
    ['github.com/AsamK/signal-cli', 'AsamK/signal-cli'],
    ['https://github.com/AsamK/signal-cli', 'AsamK/signal-cli'],
    ['https://www.github.com/o/r/', 'o/r'],
    ['https://github.com/grocy/grocy/tree/master/changelog', 'grocy/grocy'],
    ['https://github.com/o/r?tab=readme-ov-file#install', 'o/r'],
    ['git@github.com:o/r.git', 'o/r'],
    ['git+https://github.com/o/r.git', 'o/r'],
  ]
  for (const [input, repo] of cases) assert.deepEqual(parseSourceLabel(input), { ok: true, repo }, input)
})

test('anything else is refused with a reason, never silently ignored', () => {
  for (const input of [
    '',
    'minuspod',
    'https://gitlab.com/packaging/signal-cli',
    'https://api.github.com/repos/coder/code-server',
    'docker.io/ttlequals0/minuspod',
    'owner/repo/extra',
    'github.com/owner',
    '-owner/repo',
    'owner/..',
    '${SOURCE}',
  ]) {
    const r = parseSourceLabel(input)
    assert.equal(r.ok, false, input)
    assert.ok(!r.ok && r.reason.length > 0, input)
  }
})

test('an image annotation must be a github.com URL', () => {
  // Docker Official Images use a git fragment naming a commit and a directory.
  assert.equal(normaliseSourceUrl('https://github.com/docker-library/postgres.git#9a8c:17/bookworm'), 'docker-library/postgres')
  assert.equal(normaliseSourceUrl('https://github.com/o/r?x=1'), 'o/r')
  // The old pattern turned this into `repos/coder`.
  assert.equal(normaliseSourceUrl('https://api.github.com/repos/coder/code-server'), null)
  // A bare owner/repo is fine from an operator, but it is not evidence inside an image.
  assert.equal(normaliseSourceUrl('owner/repo'), null)
})
