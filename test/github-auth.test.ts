import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'shipshape-test-'))
process.env.GITHUB_REPO = 'you/repo'
process.env.GITHUB_TOKEN = 'test-token'
delete process.env.GIT_REMOTE_URL
delete process.env.GIT_TOKEN

const { classifyProbe, looksLikeGitAuthFailure, authHealth, resetAuthHealth } = await import(
  '../src/health/github-auth.ts'
)

/**
 * Saying so when GitHub stops accepting the credentials.
 *
 * The outage this covers lasted six days behind a healthy container: a token expired,
 * every call came back 401, and the only trace was one warning line per poll. Its
 * replacement failed for minutes in the same shape -- it authenticated perfectly and
 * could not see a private repository, so everything answered 404 and said nothing.
 */

beforeEach(resetAuthHealth)

test('a refused token is a credential fault', () => {
  const s = classifyProbe(401, 'Bad credentials')
  assert.equal(s.ok, false)
  assert.equal(s.ok === false && s.kind, 'rejected')
})

test('a token that cannot see the repository is a fault too, and names it', () => {
  // The second outage. Authentication succeeded; the scope did not cover the private
  // repository, so every call answered 404 and nothing said why.
  const s = classifyProbe(404, 'Not Found')
  assert.equal(s.ok, false)
  assert.equal(s.ok === false && s.kind, 'unreachable')
  assert.match(s.ok === false ? s.reason : '', /you\/repo/)
})

test('a rate limit is not a credential fault', () => {
  // 403 is overwhelmingly the hourly budget. Crying about the token every time it runs
  // out is how an operator learns to ignore the one message this exists to send.
  assert.equal(classifyProbe(403, 'API rate limit exceeded for user ID 1').ok, true)
  assert.equal(classifyProbe(403, 'Bad credentials').ok, false)
})

test('success is success', () => {
  assert.equal(classifyProbe(200, '').ok, true)
  assert.equal(classifyProbe(204, '').ok, true)
})

test('an unexpected status is not reported as a credential fault', () => {
  // A 500 from GitHub, or a proxy answering oddly, must not read as "your token is dead".
  // The alert is worth having only while it means one specific thing.
  assert.equal(classifyProbe(500, 'Server Error').ok, true)
  assert.equal(classifyProbe(502, '').ok, true)
})

test('the dialects a remote operation refuses us in', () => {
  for (const line of [
    'remote: Invalid username or token. Password authentication is not supported for Git operations.',
    "fatal: Authentication failed for 'https://github.com/you/repo.git/'",
    'remote: Bad credentials',
    'fatal: could not read Username for https://github.com: terminal prompts disabled',
  ]) {
    assert.equal(looksLikeGitAuthFailure(line), true, line)
  }
})

test('an ordinary failure is not mistaken for a credential one', () => {
  for (const line of [
    'error: failed to push some refs',
    '! [rejected] main -> main (stale info)',
    "fatal: couldn't find remote ref refs/heads/nope",
    'error: could not lock config file',
  ]) {
    assert.equal(looksLikeGitAuthFailure(line), false, line)
  }
})

test('health starts clean, and is what the Status page reads', () => {
  assert.deepEqual(authHealth(), { ok: true })
})

test('probeMethod: the API only with GITHUB_TOKEN as the git credential, ls-remote otherwise', async () => {
  const { probeMethod } = await import('../src/health/github-auth.ts')
  const { parseRemote } = await import('../src/env.ts')
  const gh = parseRemote('', 'me/c')
  assert.equal(probeMethod({ remote: gh, githubRepo: 'me/c', gitToken: 'g', githubToken: 'g' }), 'api')
  assert.equal(probeMethod({ remote: gh, githubRepo: 'me/c', gitToken: 'x', githubToken: 'g' }), 'ls-remote')
  assert.equal(
    probeMethod({
      remote: parseRemote('https://git.example.test/a/b', ''),
      githubRepo: '',
      gitToken: 'x',
      githubToken: 'g',
    }),
    'ls-remote',
  )
  assert.equal(probeMethod({ remote: parseRemote('/r', ''), githubRepo: '', gitToken: '', githubToken: '' }), 'none')
  assert.equal(probeMethod({ remote: gh, githubRepo: 'me/c', gitToken: '', githubToken: '' }), 'none')
})

test('the API probe maps GitHub failures to credential faults, and outages to nothing', async (t) => {
  const { probeRemoteAuth } = await import('../src/health/github-auth.ts')
  const { setMinSpacingForTests } = await import('../src/registry/http.ts')
  const { mockFetch, assertAllMocked, status } = await import('./helpers/http.ts')
  setMinSpacingForTests(0)
  for (const [code, want] of [
    [401, 'rejected'],
    [404, 'unreachable'],
    [500, 'ok'],
  ] as const) {
    const h = mockFetch(t, [{ url: 'https://api.github.com/repos/you/repo', reply: () => status(code) }])
    const s = await probeRemoteAuth()
    assert.equal(s.ok ? 'ok' : s.kind, want, String(code))
    assert.equal(h.calls.at(-1)!.headers.get('authorization'), 'Bearer test-token')
    assertAllMocked(h)
    t.mock.restoreAll()
  }
})
