import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * What the changelog review is shown, against a fake GitHub, for the projects that shaped it.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-notes-'))
process.env.DATA_DIR = dir
delete process.env.REPO_DIR
delete process.env.GITHUB_TOKEN

const { getDb } = await import('../src/db.ts')
const { setMinSpacingForTests } = await import('../src/registry/http.ts')
const { assembleNotes, evidenceOf, notesInRange, fileVersion } = await import('../src/notes/assemble.ts')
const { mockFetch, assertAllMocked, json, text, status } = await import('./helpers/http.ts')
type Route = import('./helpers/http.ts').Route

setMinSpacingForTests(0)
after(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => getDb().exec(`DELETE FROM http_cache; DELETE FROM tags_seen;`))

const API = 'https://api.github.com/repos'
const high = (repo: string) => ({ repo, tier: 'annotation', confidence: 'high', detail: "the image's OCI source annotation" })

const releases = (repo: string, list: { tag: string; body?: string; prerelease?: boolean; published?: string }[]): Route => ({
  url: `${API}/${repo}/releases?per_page=100&page=1`,
  reply: () =>
    json(
      list.map((r) => ({
        tag_name: r.tag,
        name: r.tag,
        published_at: r.published ?? null,
        body: r.body ?? '',
        draft: false,
        prerelease: !!r.prerelease,
      })),
    ),
})
const contents = (repo: string, path: string, entries: { name: string; type: 'file' | 'dir' }[]): Route => ({
  url: `${API}/${repo}/contents/${path}`,
  reply: () => json(entries.map((e) => ({ ...e, path: path ? `${path}/${e.name}` : e.name }))),
})
const raw = (repo: string, path: string, body: string): Route => ({
  url: `https://raw.githubusercontent.com/${repo}/HEAD/${path}`,
  reply: () => text(body),
})
const noCompare = (repo: string): Route => ({ url: new RegExp(`^${API}/${repo}/compare/`), reply: () => status(404) })

const MINUSPOD_CHANGELOG = [
  '# Changelog',
  '## [2.96.18] - 2026-09-11',
  '### Fixed',
  '- later',
  '## [2.96.17] - 2026-09-10',
  '### Added',
  '- Transcript cache',
  '## [2.96.16] - 2026-09-10',
  '### Changed',
  '- Default model',
  '## [2.96.15] - 2026-09-09',
  '### Fixed',
  '- earlier',
].join('\n')

test('minuspod: a version with no release is read from CHANGELOG.md', async (t) => {
  const h = mockFetch(t, [
    releases('ttlequals0/MinusPod', [{ tag: 'v2.96.22', prerelease: true }, { tag: 'v2.96.15', prerelease: true }]),
    contents('ttlequals0/MinusPod', '', [{ name: 'CHANGELOG.md', type: 'file' }, { name: 'docs', type: 'dir' }]),
    raw('ttlequals0/MinusPod', 'CHANGELOG.md', MINUSPOD_CHANGELOG),
    {
      url: `${API}/ttlequals0/MinusPod/compare/v2.96.15...v2.96.17`,
      reply: () => json({ total_commits: 2, commits: [{ commit: { message: 'a' } }, { commit: { message: 'b' } }] }),
    },
  ])
  const b = await assembleNotes({
    image: 'ttlequals0/minuspod:2.96.15-cpu',
    fromTag: '2.96.15-cpu',
    toTag: '2.96.17-cpu',
    source: high('ttlequals0/MinusPod'),
  })
  assert.deepEqual(b.releases.map((r) => r.tag), [], 'neither release is in the range')
  assert.deepEqual(b.changelog?.sections.map((s) => s.heading), ['[2.96.17] - 2026-09-10', '[2.96.16] - 2026-09-10'])
  assert.equal(notesInRange(b), 2)
  assert.equal(b.incomplete, false)
  // No release names 2.96.17 and no git tag is spelled `-cpu`: the version is the tag name.
  assert.deepEqual([b.commits?.from, b.commits?.to, b.commits?.subjects], ['v2.96.15', 'v2.96.17', ['b', 'a']])
  assert.deepEqual(evidenceOf(b).changelogSections, 2)
  assertAllMocked(h)
})

test('n8n: commits are compared between its own release tags, and the newest are kept', async (t) => {
  const subjects = Array.from({ length: 75 }, (_, i) => ({ commit: { message: `c${i + 1}\n\nbody` } }))
  const h = mockFetch(t, [
    releases('n8n-io/n8n', [
      { tag: 'n8n@2.39.0', prerelease: true },
      { tag: 'n8n@2.38.5', body: 'Bug fixes and a new node.' },
      { tag: 'n8n@2.38.4' },
    ]),
    contents('n8n-io/n8n', '', [{ name: 'README.md', type: 'file' }]),
    {
      url: `${API}/n8n-io/n8n/compare/n8n%402.38.4...n8n%402.38.5`,
      reply: () => json({ total_commits: 75, commits: subjects }),
    },
  ])
  const b = await assembleNotes({ image: 'n8nio/n8n:2.38.4', fromTag: '2.38.4', toTag: '2.38.5', source: high('n8n-io/n8n') })
  assert.deepEqual(b.releases.map((r) => r.tag), ['n8n@2.38.5'])
  assert.deepEqual([b.commits?.from, b.commits?.to, b.commits?.total], ['n8n@2.38.4', 'n8n@2.38.5', 75])
  assert.equal(b.commits?.subjects.length, 60)
  assert.equal(b.commits?.subjects[0], 'c75', 'newest first: the end nearest the proposed version')
  assert.equal(b.commits?.subjects[59], 'c16')
  assertAllMocked(h)
})

test('code-server: a changelog section a release body already covers is not repeated, and container changes come along', async (t) => {
  const body = 'Code v1.104.0 update. '.repeat(20)
  const h = mockFetch(t, [
    {
      url: 'https://api.linuxserver.io/api/v1/images?include_config=false&include_deprecated=false',
      reply: () =>
        json({ data: { repositories: { linuxserver: [{ name: 'code-server', changelog: [{ date: '11.09.26', desc: 'Rebase to noble.' }] }] } } }),
    },
    releases('coder/code-server', [{ tag: 'v4.137.0', body }, { tag: 'v4.136.2', body }]),
    contents('coder/code-server', '', [{ name: 'CHANGELOG.md', type: 'file' }]),
    raw('coder/code-server', 'CHANGELOG.md', '# Changelog\n## [4.137.0] - 2026-09-11\n- same as the release\n## [4.136.2] - 2026-09-08\n- older'),
    noCompare('coder/code-server'),
  ])
  const b = await assembleNotes({
    image: 'lscr.io/linuxserver/code-server:4.136.2-ls363',
    fromTag: '4.136.2-ls363',
    toTag: '4.137.0-ls364',
    source: { repo: 'coder/code-server', tier: 'lsio-build', confidence: 'high', detail: 'linuxserver/docker-code-server builds from its releases' },
  })
  assert.deepEqual(b.releases.map((r) => r.tag), ['v4.137.0'], "the packaging build is not part of upstream's version")
  assert.deepEqual(b.changelog?.sections, [], 'the release body already says it')
  assert.deepEqual(b.container, [{ date: '11.09.26', desc: 'Rebase to noble.' }])
  assertAllMocked(h)
})

test('grocy: a directory of one file per version is read for the versions in range', async (t) => {
  const h = mockFetch(t, [
    {
      url: 'https://api.linuxserver.io/api/v1/images?include_config=false&include_deprecated=false',
      reply: () => json({ data: { repositories: { linuxserver: [{ name: 'grocy' }] } } }),
    },
    releases('grocy/grocy', []),
    contents('grocy/grocy', '', [{ name: 'changelog', type: 'dir' }, { name: 'docs', type: 'dir' }]),
    contents('grocy/grocy', 'changelog', [
      { name: '81_4.6.0_2026-06-01.md', type: 'file' },
      { name: '82_4.7.0_2026-08-01.md', type: 'file' },
      { name: '83_4.7.1_2026-09-04.md', type: 'file' },
      { name: '__TEMPLATE.md', type: 'file' },
    ]),
    raw('grocy/grocy', 'changelog/82_4.7.0_2026-08-01.md', '### New features\n- Recipes'),
    raw('grocy/grocy', 'changelog/83_4.7.1_2026-09-04.md', '### Fixes\n- Stock'),
    noCompare('grocy/grocy'),
  ])
  const b = await assembleNotes({ image: 'linuxserver/grocy:v4.6.0', fromTag: 'v4.6.0', toTag: 'v4.7.1', source: high('grocy/grocy') })
  assert.deepEqual(b.changelog?.sections.map((s) => s.heading), ['83_4.7.1_2026-09-04.md', '82_4.7.0_2026-08-01.md'])
  assert.equal(b.changelog?.file, 'changelog/')
  assert.match(b.notes.join('\n'), /grocy\/grocy publishes no GitHub releases/)
  assert.equal(fileVersion('__TEMPLATE.md', 'semver'), null)
  assertAllMocked(h)
})

test('postgres: publishing no releases is an answer; a rate limit is a gap to read again', async (t) => {
  let limited = false
  const reset = String(Math.floor(Date.now() / 1000) + 900)
  const limit = () => status(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset })
  const h = mockFetch(t, [
    { url: `${API}/postgres/postgres/releases?per_page=100&page=1`, reply: () => (limited ? limit() : json([])) },
    { url: `${API}/postgres/postgres/contents/`, reply: () => (limited ? limit() : json([{ name: 'HISTORY', path: 'HISTORY', type: 'file' }])) },
    raw('postgres/postgres', 'HISTORY', 'Release notes for all versions of PostgreSQL can be found on-line.\n'),
    { url: /compare/, reply: () => (limited ? limit() : status(404)) },
  ])
  const opts = { image: 'library/postgres:16.1', fromTag: '16.1', toTag: '16.2', source: high('postgres/postgres') }

  const empty = await assembleNotes(opts)
  assert.equal(empty.incomplete, false)
  assert.deepEqual(empty.fetches.find((f) => f.what === 'releases')?.outcome, 'none')
  assert.match(empty.notes.join('\n'), /publishes no GitHub releases/)
  assert.equal(empty.changelog?.sections.length, 0, 'a pointer file is not a changelog')

  getDb().exec(`DELETE FROM http_cache`)
  limited = true
  const gap = await assembleNotes(opts)
  assert.equal(gap.incomplete, true)
  assert.equal(gap.fetches.find((f) => f.what === 'releases')?.outcome, 'rate-limited')
  assert.match(gap.notes.join('\n'), /rate limit was reached \(it resets .+\), so postgres\/postgres's GitHub releases could not be read/)
  assert.doesNotMatch(gap.notes.join('\n'), /publishes no GitHub releases/)
  assertAllMocked(h)
})

function seen(repository: string, tag: string, digest: string, publishedAt: string): void {
  getDb()
    .prepare(
      `INSERT INTO tags_seen (registry, repository, tag, digest, published_at, first_seen_at) VALUES ('docker.io', ?, ?, ?, ?, ?)`,
    )
    .run(repository, tag, digest, publishedAt, publishedAt)
}

test('a floating tag is made concrete through a version tag on the same digest', async (t) => {
  seen('acme/agent', 'v1.4.0', 'sha256:aaa', '2026-09-01T00:00:00Z')
  seen('acme/agent', 'v1.6.0', 'sha256:bbb', '2026-09-10T00:00:00Z')
  const h = mockFetch(t, [
    releases('acme/agent', [{ tag: 'v1.7.0' }, { tag: 'v1.6.0', body: 'six' }, { tag: 'v1.5.0', body: 'five' }, { tag: 'v1.4.0' }]),
    contents('acme/agent', '', []),
    { url: `${API}/acme/agent/compare/v1.4.0...v1.6.0`, reply: () => json({ total_commits: 1, commits: [{ commit: { message: 'x' } }] }) },
  ])
  const b = await assembleNotes({ image: 'acme/agent:latest', fromTag: 'latest@sha256:aaa', toTag: 'latest@sha256:bbb', source: high('acme/agent') })
  assert.equal(b.range.approximate, false)
  assert.match(b.range.basis, /also tagged v1\.4\.0 and v1\.6\.0/)
  assert.deepEqual(b.releases.map((r) => r.tag), ['v1.6.0', 'v1.5.0'])
  assertAllMocked(h)
})

test('a digest with no version tag gets a window of dates, and says it is approximate', async (t) => {
  seen('acme/agent', 'latest', 'sha256:bbb', '2026-09-10T00:00:00Z')
  const h = mockFetch(t, [
    releases('acme/agent', [
      { tag: 'v1.7.0', published: '2026-09-12T00:00:00Z' },
      { tag: 'v1.6.0', published: '2026-09-09T00:00:00Z' },
      { tag: 'v1.5.0', published: '2026-09-01T00:00:00Z' },
    ]),
  ])
  const b = await assembleNotes({ image: 'acme/agent:latest', fromTag: 'latest@sha256:aaa', toTag: 'latest@sha256:bbb', source: high('acme/agent') })
  assert.equal(b.range.approximate, true)
  assert.match(b.range.basis, /the tags float/)
  assert.deepEqual(b.releases.map((r) => r.tag), ['v1.6.0', 'v1.5.0'], 'nothing published after the new digest')
  assert.equal(b.commits, null)
  assert.equal(b.fetches.find((f) => f.what === 'changelog')?.outcome, 'skipped')
  assertAllMocked(h)
})
