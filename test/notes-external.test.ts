import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as dns from 'node:dns'

/**
 * Notes an operator linked, fetched from inside the lab: what is read, and what never is.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-external-'))
process.env.DATA_DIR = dir
delete process.env.REPO_DIR
delete process.env.GITHUB_TOKEN

const { getDb } = await import('../src/db.ts')
const { setMinSpacingForTests } = await import('../src/registry/http.ts')
const { externalNotes, githubLink } = await import('../src/notes/external.ts')
const { assembleNotes, notesInRange } = await import('../src/notes/assemble.ts')
const { versionKey } = await import('../src/versions/key.ts')
const { mockFetch, assertAllMocked, json, text, status } = await import('./helpers/http.ts')
type TestContext = import('node:test').TestContext

setMinSpacingForTests(0)
after(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => getDb().exec(`DELETE FROM http_cache;`))

const key = (t: string) => versionKey(t)!
const range = (from: string, to: string) => ({ from: key(from), to: key(to) })

/** Every name resolves publicly, except the ones named here. */
function resolver(t: TestContext, privateHosts: Record<string, string> = {}): { asked: string[] } {
  const asked: string[] = []
  t.mock.method(dns.promises, 'lookup', async (host: string) => {
    asked.push(host)
    return [{ address: privateHosts[host] ?? '93.184.216.34', family: 4 }]
  })
  return { asked }
}

const PAGE = `<h1>Release notes</h1>
<h2>1.2.0</h2><ul><li>Fixed the thing</li></ul>
<h2>1.1.0</h2><p>Older</p>
<h2>1.0.0</h2><p>Oldest</p>`

test('a vendor page is fetched, cut by version, and only the range is kept', async (t) => {
  resolver(t)
  const h = mockFetch(t, [
    { url: 'https://vendor.example/notes', reply: () => text(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } }) },
  ])
  const r = await externalNotes({ kind: 'url', url: 'https://vendor.example/notes' }, null, range('1.0.0', '1.2.0'))
  assert.ok(r.ok, JSON.stringify(r))
  assert.deepEqual(r.notes.sections.map((s) => s.heading), ['1.2.0', '1.1.0'])
  assert.match(r.notes.sections[0]!.body, /- Fixed the thing/)
  assert.equal(r.notes.totalSections, 3)
  assertAllMocked(h)
})

test('a name that resolves to a private address is never connected to', async (t) => {
  const dnsLog = resolver(t, { 'notes.example': '10.0.0.5' })
  const h = mockFetch(t, [])
  const r = await externalNotes({ kind: 'url', url: 'https://notes.example/x' }, null, range('1.0.0', '1.2.0'))
  assert.equal(r.ok, false)
  assert.match(r.ok ? '' : r.reason, /resolves to 10\.0\.0\.5, a private address/)
  assert.deepEqual(dnsLog.asked, ['notes.example'])
  assert.equal(h.calls.length, 0)
})

test('a redirect is checked again at the hop, and one into the lab goes nowhere', async (t) => {
  resolver(t, { 'internal.example': '192.168.1.10' })
  const h = mockFetch(t, [
    { url: 'https://public.example/notes', reply: () => status(302, { location: 'https://internal.example/admin' }) },
  ])
  const r = await externalNotes({ kind: 'url', url: 'https://public.example/notes' }, null, range('1.0.0', '1.2.0'))
  assert.equal(r.ok, false)
  assert.match(r.ok ? '' : r.reason, /private address/)
  assert.equal(h.calls.length, 1, 'the redirect target was never requested')

  const plain = mockFetch(t, [
    { url: 'https://public.example/other', reply: () => status(301, { location: 'http://public.example/other' }) },
  ])
  const downgraded = await externalNotes({ kind: 'url', url: 'https://public.example/other' }, null, range('1.0.0', '1.2.0'))
  assert.match(downgraded.ok ? '' : downgraded.reason, /only https/)
  assert.equal(plain.calls.length, 1)
})

test('more than 2 MB is refused while reading, and what is not text is not read at all', async (t) => {
  resolver(t)
  const big = 'x'.repeat(2 * 1024 * 1024 + 10)
  const h = mockFetch(t, [
    { url: 'https://big.example/notes.md', reply: () => text(big, { headers: { 'content-type': 'text/markdown' } }) },
    { url: 'https://pdf.example/notes.pdf', reply: () => text('%PDF', { headers: { 'content-type': 'application/pdf' } }) },
  ])
  const tooBig = await externalNotes({ kind: 'url', url: 'https://big.example/notes.md' }, null, range('1.0.0', '1.2.0'))
  assert.match(tooBig.ok ? '' : tooBig.reason, /larger than 2 MB/)
  const pdf = await externalNotes({ kind: 'url', url: 'https://pdf.example/notes.pdf' }, null, range('1.0.0', '1.2.0'))
  assert.match(pdf.ok ? '' : pdf.reason, /application\/pdf, which is not text to read/)
  assertAllMocked(h)
})

test('a page read within the last six hours is not fetched again', async (t) => {
  resolver(t)
  const h = mockFetch(t, [
    { url: 'https://vendor.example/notes.md', reply: () => text('## 1.2.0\n- a\n## 1.1.0\n- b', { headers: { 'content-type': 'text/markdown' } }) },
  ])
  const link = { kind: 'url' as const, url: 'https://vendor.example/notes.md' }
  await externalNotes(link, null, range('1.1.0', '1.2.0'))
  const again = await externalNotes(link, null, range('1.1.0', '1.2.0'))
  assert.ok(again.ok)
  assert.deepEqual(again.notes.sections.map((s) => s.heading), ['1.2.0'])
  assert.equal(h.calls.length, 1)
})

test('a page with no version headings is shown from the top, and says so', async (t) => {
  resolver(t)
  const h = mockFetch(t, [
    { url: 'https://vendor.example/news', reply: () => text('Big improvements this month.\n\nMore to come.', { headers: { 'content-type': 'text/plain' } }) },
  ])
  const r = await externalNotes({ kind: 'url', url: 'https://vendor.example/news' }, null, range('1.0.0', '1.2.0'))
  assert.ok(r.ok)
  assert.deepEqual(r.notes.sections, [])
  assert.match(r.notes.excerpt ?? '', /^Big improvements this month/)
  assertAllMocked(h)
})

test('GitHub links are read through GitHub, at the ref they name', async (t) => {
  const dnsLog = resolver(t)
  assert.deepEqual(githubLink('https://github.com/o/r/blob/v2/docs/NEWS.md'), { kind: 'blob', repo: 'o/r', ref: 'v2', path: 'docs/NEWS.md' })
  assert.deepEqual(githubLink('https://github.com/o/r/tree/main/changelog'), { kind: 'tree', repo: 'o/r', ref: 'main', path: 'changelog' })
  assert.deepEqual(githubLink('https://github.com/o/r/releases/tag/v1'), { kind: 'releases', repo: 'o/r' })
  assert.deepEqual(githubLink('https://github.com/o/r.git'), { kind: 'repo', repo: 'o/r' })
  assert.equal(githubLink('https://gitlab.com/o/r'), null)

  const h = mockFetch(t, [
    { url: 'https://raw.githubusercontent.com/o/r/v2/docs/NEWS.md', reply: () => text('## 1.2.0\n- a\n## 1.1.0\n- b') },
  ])
  const r = await externalNotes({ kind: 'url', url: 'https://github.com/o/r/blob/v2/docs/NEWS.md' }, null, range('1.1.0', '1.2.0'))
  assert.ok(r.ok)
  assert.deepEqual(r.notes.sections.map((s) => s.heading), ['1.2.0'])
  assert.deepEqual(dnsLog.asked, [], 'no name was resolved: nothing went through the open fetch')
  assertAllMocked(h)
})

test('plex: with no repository known at all, the linked page is the notes', async (t) => {
  resolver(t)
  const h = mockFetch(t, [
    {
      url: 'https://api.linuxserver.io/api/v1/images?include_config=false&include_deprecated=false',
      reply: () => json({ data: { repositories: { linuxserver: [{ name: 'plex' }] } } }),
    },
    {
      url: 'https://forums.plex.example/notes',
      reply: () => text('<h3>1.43.5</h3><p>New</p><h3>1.43.4</h3><p>Running</p>', { headers: { 'content-type': 'text/html' } }),
    },
  ])
  const b = await assembleNotes({
    image: 'linuxserver/plex:1.43.4',
    fromTag: '1.43.4',
    toTag: '1.43.5',
    source: {
      repo: null,
      tier: 'none',
      confidence: null,
      detail: null,
      packagingRepo: 'linuxserver/docker-plex',
      changelog: { value: 'https://forums.plex.example/notes', target: { kind: 'url', url: 'https://forums.plex.example/notes' } },
    },
  })
  assert.deepEqual(b.external?.sections.map((s) => s.heading), ['1.43.5'])
  assert.equal(notesInRange(b), 1)
  assert.match(b.notes.join('\n'), /the notes linked by shipshape\.changelog are what there is/)
  assertAllMocked(h)
})

test('a path in shipshape.changelog replaces discovery', async (t) => {
  const h = mockFetch(t, [
    { url: 'https://api.github.com/repos/o/r/releases?per_page=100&page=1', reply: () => json([]) },
    { url: 'https://raw.githubusercontent.com/o/r/HEAD/docs/HISTORY.md', reply: () => text('## 2.1.0\n- new\n## 2.0.0\n- old') },
    { url: /compare/, reply: () => status(404) },
    // No contents listing: the path is not searched for.
  ])
  const b = await assembleNotes({
    image: 'o/r:2.0.0',
    fromTag: '2.0.0',
    toTag: '2.1.0',
    source: { repo: 'o/r', tier: 'label', confidence: 'high', detail: null, changelog: { value: 'docs/HISTORY.md', target: { kind: 'path', path: 'docs/HISTORY.md' } } },
  })
  assert.deepEqual(b.changelog?.sections.map((s) => s.heading), ['2.1.0'])
  assert.equal(b.changelog?.file, 'docs/HISTORY.md')
  assertAllMocked(h)
})
