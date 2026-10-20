import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Where a reference a fork waits on stands upstream, against a fake GitHub.
 *
 * Every state the Services page can show is reached here: an open pull request, a merged
 * one not yet in a release, one that shipped, an issue closed by a commit that shipped,
 * an issue closed as not planned, and a lookup GitHub refused -- which must read as
 * unknown, never as "no fix".
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-fork-res-'))
process.env.DATA_DIR = dir
process.env.GITHUB_TOKEN = 'test-token'
delete process.env.REPO_DIR

const { getDb } = await import('../src/db.ts')
const { setMinSpacingForTests } = await import('../src/registry/http.ts')
const { resolveForkRef, parseForkRef, forkRefUrl, tagContains } = await import('../src/upstream/forks.ts')
const { mockFetch, assertAllMocked, json, status } = await import('./helpers/http.ts')

setMinSpacingForTests(0)
after(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  getDb().exec(`DELETE FROM http_cache`)
})

const API = 'https://api.github.com/repos/o/r'
const issue = (n: number, body: unknown) => ({ url: `${API}/issues/${n}`, reply: () => json(body) })
const pull = (n: number, body: unknown) => ({ url: `${API}/pulls/${n}`, reply: () => json(body) })
const compare = (sha: string, tag: string, st: string) => ({
  url: `${API}/compare/${sha}...${encodeURIComponent(tag)}`,
  reply: () => json({ status: st }),
})

test('a reference is owner/repo#N and links to the issue page, which answers for pull requests too', () => {
  assert.deepEqual(parseForkRef('grimmory-tools/grimmory#2952'), { repo: 'grimmory-tools/grimmory', number: 2952 })
  assert.equal(parseForkRef('grimmory#2952'), null)
  assert.equal(forkRefUrl('o/r#7'), 'https://github.com/o/r/issues/7')
})

test('an open pull request is open, and nothing is compared', async (t) => {
  const h = mockFetch(t, [
    issue(1, { state: 'open', state_reason: null, pull_request: { merged_at: null } }),
    pull(1, { state: 'open', merged: false, merge_commit_sha: 'abc' }),
  ])
  const r = await resolveForkRef('o/r#1', 'v1.2.0')
  assert.equal(r.state, 'open')
  assert.equal(r.fixSha, null)
  assertAllMocked(h)
})

test('a merged pull request whose merge commit is not in the newest release is merged, not released', async (t) => {
  const h = mockFetch(t, [
    issue(2, { state: 'closed', state_reason: null, pull_request: { merged_at: '2026-01-01T00:00:00Z' } }),
    pull(2, { state: 'closed', merged: true, merge_commit_sha: 'f00d' }),
    compare('f00d', 'v1.2.0', 'behind'),
  ])
  const r = await resolveForkRef('o/r#2', 'v1.2.0')
  assert.equal(r.state, 'merged-unreleased')
  assert.equal(r.fixSha, 'f00d')
  assert.equal(r.comparedTo, 'v1.2.0')
  assert.equal(r.releasedIn, null)
  assertAllMocked(h)
})

test('a merged pull request whose merge commit the newest release contains is released in it', async (t) => {
  const h = mockFetch(t, [
    issue(3, { state: 'closed', state_reason: null, pull_request: { merged_at: '2026-01-01T00:00:00Z' } }),
    pull(3, { state: 'closed', merged: true, merge_commit_sha: 'cafe' }),
    compare('cafe', 'v1.3.0', 'ahead'),
  ])
  const r = await resolveForkRef('o/r#3', 'v1.3.0')
  assert.equal(r.state, 'released')
  assert.equal(r.releasedIn, 'v1.3.0')
  assert.equal(r.fixSha, 'cafe')
  assertAllMocked(h)
})

test('an issue closed by a commit is released once a release contains that commit', async (t) => {
  const h = mockFetch(t, [
    issue(4, { state: 'closed', state_reason: 'completed', pull_request: null }),
    {
      url: `${API}/issues/4/timeline?per_page=100`,
      reply: () =>
        json([
          { event: 'labeled' },
          { event: 'closed', commit_id: 'dead' },
        ]),
    },
    compare('dead', 'v1.3.0', 'identical'),
  ])
  const r = await resolveForkRef('o/r#4', 'v1.3.0')
  assert.equal(r.state, 'released')
  assert.equal(r.fixSha, 'dead')
  assert.equal(r.releasedIn, 'v1.3.0')
  assertAllMocked(h)
})

test('an issue closed by a merged pull request in the same repository takes that merge commit', async (t) => {
  const h = mockFetch(t, [
    issue(5, { state: 'closed', state_reason: 'completed', pull_request: null }),
    {
      url: `${API}/issues/5/timeline?per_page=100`,
      reply: () =>
        json([
          // A fork's pull request elsewhere does not put a fix into this repository's releases.
          {
            event: 'cross-referenced',
            source: { issue: { number: 9, state: 'closed', pull_request: { merged_at: '2026-01-01T00:00:00Z' }, repository: { full_name: 'someone/r' } } },
          },
          {
            event: 'cross-referenced',
            source: { issue: { number: 6, state: 'closed', pull_request: { merged_at: '2026-01-02T00:00:00Z' }, repository: { full_name: 'o/r' } } },
          },
          { event: 'closed', commit_id: null },
        ]),
    },
    pull(6, { state: 'closed', merged: true, merge_commit_sha: 'beef' }),
    compare('beef', 'v1.2.0', 'diverged'),
  ])
  const r = await resolveForkRef('o/r#5', 'v1.2.0')
  assert.equal(r.state, 'merged-unreleased')
  assert.equal(r.fixSha, 'beef')
  assert.equal(r.detail, 'merged in #6')
  assertAllMocked(h)
})

test('an issue closed as not planned, or with nothing that fixed it, has no upstream path', async (t) => {
  const h = mockFetch(t, [
    issue(7, { state: 'closed', state_reason: 'not_planned', pull_request: null }),
    issue(8, { state: 'closed', state_reason: 'completed', pull_request: null }),
    { url: `${API}/issues/8/timeline?per_page=100`, reply: () => json([{ event: 'closed', commit_id: null }]) },
    issue(9, { state: 'closed', state_reason: null, pull_request: { merged_at: null } }),
    pull(9, { state: 'closed', merged: false, merge_commit_sha: null }),
  ])
  assert.equal((await resolveForkRef('o/r#7', 'v1')).state, 'closed-unfixed')
  assert.equal((await resolveForkRef('o/r#8', 'v1')).state, 'closed-unfixed')
  const closedPr = await resolveForkRef('o/r#9', 'v1')
  assert.equal(closedPr.state, 'closed-unfixed')
  assert.match(closedPr.detail ?? '', /without being merged/)
  assertAllMocked(h)
})

test('a lookup GitHub refuses is unknown, with the reason, and never a missing fix', async (t) => {
  const h = mockFetch(t, [
    { url: `${API}/issues/10`, reply: () => status(403, { 'x-ratelimit-remaining': '0' }) },
    issue(11, { state: 'closed', state_reason: null, pull_request: { merged_at: 'x' } }),
    pull(11, { state: 'closed', merged: true, merge_commit_sha: 'aaaa' }),
    { url: `${API}/compare/aaaa...v9.9.9`, reply: () => status(500) },
  ])
  const limited = await resolveForkRef('o/r#10', 'v1')
  assert.equal(limited.state, 'unknown')
  assert.match(limited.detail ?? '', /rate limit/)
  const outage = await resolveForkRef('o/r#11', 'v9.9.9')
  assert.equal(outage.state, 'unknown')
  assert.equal(outage.fixSha, 'aaaa')
  assertAllMocked(h)
})

test('an image tag that is not the git tag is tried in its other spelling', async (t) => {
  const h = mockFetch(t, [
    { url: `${API}/compare/abc...3.4.0`, reply: () => status(404) },
    compare('abc', 'v3.4.0', 'ahead'),
  ])
  const c = await tagContains('o/r', 'abc', '3.4.0')
  assert.deepEqual(c, { ok: true, contains: true, tag: 'v3.4.0' })
  assertAllMocked(h)
})

test('a reference with no release tag to look in is merged, not released, rather than a comparison against nothing', async (t) => {
  const h = mockFetch(t, [
    issue(12, { state: 'closed', state_reason: null, pull_request: { merged_at: 'x' } }),
    pull(12, { state: 'closed', merged: true, merge_commit_sha: 'bbbb' }),
  ])
  const r = await resolveForkRef('o/r#12', null)
  assert.equal(r.state, 'merged-unreleased')
  assert.equal(r.comparedTo, null)
  assertAllMocked(h)
})

test('a reference that is not owner/repo#N is unknown without touching the network', async (t) => {
  const h = mockFetch(t, [])
  const r = await resolveForkRef('nonsense', 'v1')
  assert.equal(r.state, 'unknown')
  assertAllMocked(h)
  assert.equal(h.calls.length, 0)
})
