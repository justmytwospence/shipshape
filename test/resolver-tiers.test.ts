import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Each tier against a fake network, with the images that motivated it: minuspod, whose repo
 * is linked only from its Docker Hub page; signal-cli, packaged on GitLab; the LinuxServer
 * images whose API names a website rather than a repository.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-tiers-'))
process.env.DATA_DIR = dir
delete process.env.REPO_DIR
delete process.env.GITHUB_TOKEN

const { getDb } = await import('../src/db.ts')
const { setMinSpacingForTests } = await import('../src/registry/http.ts')
const { lookUpImage, resolveWatched, sourceFor, sourceForSync, resetResolverMemo, RESOLVER_VERSION } = await import(
  '../src/resolver/index.ts'
)
const { mockFetch, assertAllMocked, json, text, status } = await import('./helpers/http.ts')
type Route = import('./helpers/http.ts').Route

setMinSpacingForTests(0)
after(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  getDb().exec(`DELETE FROM images; DELETE FROM resolutions; DELETE FROM budgets; DELETE FROM http_cache;`)
  resetResolverMemo()
})

const LSIO = 'https://api.linuxserver.io/api/v1/images?include_config=false&include_deprecated=false'

const repo = (name: string, o: { fullName?: string; fork?: boolean; parent?: string } = {}): Route => ({
  url: `https://api.github.com/repos/${name}`,
  reply: () => json({ full_name: o.fullName ?? name, fork: !!o.fork, archived: false, parent: o.parent ? { full_name: o.parent } : undefined }),
})
const noRepo = (name: string): Route => ({ url: `https://api.github.com/repos/${name}`, reply: () => status(404) })
const hub = (repository: string, full: string): Route => ({
  url: `https://hub.docker.com/v2/repositories/${repository}/`,
  reply: () => json({ description: '', full_description: full }),
})
const lsio = (images: { name: string; project_url: string }[]): Route => ({
  url: LSIO,
  reply: () => json({ data: { repositories: { linuxserver: images } } }),
})
const jenkinsfile = (name: string, body: string | null): Route => ({
  url: `https://raw.githubusercontent.com/linuxserver/docker-${name}/HEAD/Jenkinsfile`,
  reply: () => (body === null ? status(404) : text(body)),
})
const pulls = (h: { calls: { url: string }[] }) => h.calls.filter((c) => c.url.startsWith('https://registry-1.docker.io/')).length

function image(stack: string, service: string, img: { registry: string; repository: string }, tag: string, label?: string): void {
  getDb()
    .prepare(
      `INSERT INTO images (stack, service, compose_file, image_ref, registry, repository,
                           current_tag, watched, source_label, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(stack, service, `${stack}/docker-compose.yaml`, `${img.repository}:${tag}`, img.registry, img.repository, tag,
      label ?? null, new Date().toISOString())
}

const MINUSPOD = { registry: 'docker.io', repository: 'ttlequals0/minuspod' }

test('minuspod: its Docker Hub page links the repo, which settles it without a single pull', async (t) => {
  const h = mockFetch(t, [
    hub('ttlequals0/minuspod', 'Removes ads.\n\nSee https://github.com/ttlequals0/MinusPod and https://github.com/openai/whisper.'),
    repo('ttlequals0/MinusPod'),
  ])
  const l = await lookUpImage(MINUSPOD, '2.96.17-cpu', { allowBilled: true })
  assert.deepEqual([l.repo, l.tier, l.confidence], ['ttlequals0/MinusPod', 'description', 'high'])
  assert.equal(l.detail, 'linked from its description on Docker Hub')
  assert.equal(pulls(h), 0, 'the free tier settled it before the billed walk')
  assertAllMocked(h)
})

test('n8n: the one repository matching name and owner, of the three its page links', async (t) => {
  const h = mockFetch(t, [
    hub('n8nio/n8n', 'https://github.com/n8n-io/n8n-hosting · https://github.com/n8n-io/n8n · https://github.com/n8n-io/localtunnel'),
    repo('n8n-io/n8n'),
  ])
  const l = await lookUpImage({ registry: 'docker.io', repository: 'n8nio/n8n' }, '2.38.5', { ignoreOverrides: true })
  assert.deepEqual([l.repo, l.tier, l.confidence], ['n8n-io/n8n', 'description', 'high'])
  assertAllMocked(h)
})

test('glance: a repository with the image name is only likely, and the billed walk is left for later', async (t) => {
  const glance = { registry: 'docker.io', repository: 'glanceapp/glance' }
  image('glance', 'glance', glance, 'v0.8.6')
  const h = mockFetch(t, [
    hub('glanceapp/glance', 'A self-hosted dashboard.'),
    repo('glanceapp/glance'),
    { url: 'https://registry-1.docker.io/v2/glanceapp/glance/manifests/v0.8.6', reply: () => status(404) },
  ])

  const swept = await resolveWatched({ allowBilled: false })
  assert.deepEqual({ looked: swept.looked, linked: swept.linked }, { looked: 1, linked: 0 })
  const s = sourceForSync(glance)
  assert.deepEqual([s.repo, s.tier, s.confidence], ['glanceapp/glance', 'lookup', 'medium'])
  assert.equal(pulls(h), 0)

  // Another sweep has nothing to do: the skipped walk is not a reason to look again unbilled.
  assert.equal((await resolveWatched({ allowBilled: false })).due, 0)

  // Something that may spend pulls does look again, walk included.
  const billed = await sourceFor(glance)
  assert.equal(billed.repo, 'glanceapp/glance')
  assert.equal(pulls(h), 1)
  const asked = h.calls.length
  await sourceFor(glance)
  assert.equal(h.calls.length, asked, 'once walked, it is not walked again')
  assertAllMocked(h)
})

test('opencode and whisper.cpp: a ghcr.io path names the repository', async (t) => {
  const h = mockFetch(t, [
    { url: /^https:\/\/ghcr\.io\/v2\/.*\/manifests\//, reply: () => status(404) },
    repo('anomalyco/opencode'),
    repo('ggml-org/whisper.cpp'),
  ])
  const opencode = await lookUpImage({ registry: 'ghcr.io', repository: 'anomalyco/opencode' }, '1.18.30')
  assert.deepEqual([opencode.repo, opencode.tier, opencode.confidence], ['anomalyco/opencode', 'ghcr-path', 'high'])
  const whisper = await lookUpImage({ registry: 'ghcr.io', repository: 'ggml-org/whisper.cpp' }, 'main')
  assert.deepEqual([whisper.repo, whisper.tier, whisper.confidence], ['ggml-org/whisper.cpp', 'ghcr-path', 'high'])
  assertAllMocked(h)
})

test('signal-cli: the GitLab project that packages it names the repo, as a likely match', async (t) => {
  const h = mockFetch(t, [
    { url: 'https://registry.gitlab.com/v2/packaging/signal-cli/signal-cli-native/manifests/v0-14-7-1', reply: () => status(404) },
    { url: 'https://gitlab.com/api/v4/projects/packaging%2Fsignal-cli%2Fsignal-cli-native', reply: () => status(404) },
    {
      url: 'https://gitlab.com/api/v4/projects/packaging%2Fsignal-cli',
      reply: () => json({ description: 'Ubuntu packages for https://github.com/AsamK/signal-cli\r\nDocumentation: https://packaging.gitlab.io/signal-cli' }),
    },
    repo('AsamK/signal-cli'),
    // No GitHub lookup of packaging/signal-cli: a GitLab image's project lives on GitLab.
  ])
  const l = await lookUpImage({ registry: 'registry.gitlab.com', repository: 'packaging/signal-cli/signal-cli-native' }, 'v0-14-7-1')
  assert.deepEqual([l.repo, l.tier, l.confidence], ['AsamK/signal-cli', 'description', 'medium'])
  assertAllMocked(h)
})

test("LinuxServer: the build file names coder's and Tautulli's repos, where the API names websites", async (t) => {
  const h = mockFetch(t, [
    lsio([
      { name: 'code-server', project_url: 'https://coder.com' },
      { name: 'tautulli', project_url: 'http://tautulli.com' },
      { name: 'qbittorrent', project_url: 'https://www.qbittorrent.org/' },
    ]),
    jenkinsfile('qbittorrent', `curl -sL https://api.github.com/repos/userdocs/qbittorrent-nox-static/releases/latest`),
    repo('userdocs/qbittorrent-nox-static'),
    jenkinsfile('code-server', `EXT_RELEASE = sh(script: '''curl -sX GET https://api.github.com/repos/coder/code-server/releases/latest''')`),
    jenkinsfile('tautulli', `    EXT_USER = 'Tautulli'\n    EXT_REPO = 'Tautulli'\n`),
    repo('coder/code-server'),
    repo('Tautulli/Tautulli'),
  ])
  const cs = await lookUpImage({ registry: 'lscr.io', repository: 'linuxserver/code-server' }, '4.136.2')
  assert.deepEqual([cs.repo, cs.tier, cs.confidence, cs.packagingRepo], ['coder/code-server', 'lsio-build', 'high', 'linuxserver/docker-code-server'])
  const tt = await lookUpImage({ registry: 'docker.io', repository: 'linuxserver/tautulli' }, '2.18.1')
  assert.deepEqual([tt.repo, tt.tier], ['Tautulli/Tautulli', 'lsio-build'])
  // qbittorrent's build file reads a static-binary distributor, not qBittorrent itself: a
  // repository named for something else is only likely.
  const qb = await lookUpImage({ registry: 'docker.io', repository: 'linuxserver/qbittorrent' }, '5.1.4-r3-ls453')
  assert.deepEqual([qb.repo, qb.tier, qb.confidence], ['userdocs/qbittorrent-nox-static', 'lsio-build', 'medium'])
  assert.equal(pulls(h), 0)
  assertAllMocked(h)
})

test('plex: nothing on GitHub to name, so none -- with the packaging repo, and why', async (t) => {
  const plex = { registry: 'docker.io', repository: 'linuxserver/plex' }
  image('plex', 'plex', plex, '1.43.4')
  const h = mockFetch(t, [
    lsio([{ name: 'plex', project_url: 'https://plex.tv' }]),
    jenkinsfile('plex', `EXT_RELEASE = sh(script: '''curl -s 'https://plex.tv/api/downloads/5.json' | jq -r '.computer.Linux.version'''')`),
  ])
  const s = await sourceFor(plex)
  assert.equal(s.repo, null)
  assert.equal(s.packagingRepo, 'linuxserver/docker-plex')
  assert.match(s.detail ?? '', /names https:\/\/plex\.tv as its home/)
  assert.equal(s.error, null)
  assertAllMocked(h)
})

test('a row naming a packaging repository is looked at again, and never shown as the answer', async (t) => {
  const heimdall = { registry: 'docker.io', repository: 'linuxserver/heimdall' }
  image('heimdall', 'heimdall', heimdall, '2.8.3')
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO resolutions (registry, repository, source_url, tier, confidence, resolved_at, checked_at, resolver_version)
       VALUES ('docker.io', 'linuxserver/heimdall', 'linuxserver/docker-heimdall', 'annotation', 'high', ?, ?, ?)`,
    )
    .run(now, now, RESOLVER_VERSION)

  const cached = sourceForSync(heimdall)
  assert.equal(cached.repo, null, 'the stored string alone rules it out')
  assert.equal(cached.packagingRepo, 'linuxserver/docker-heimdall')

  const h = mockFetch(t, [
    lsio([{ name: 'heimdall', project_url: 'https://heimdall.site' }]),
    jenkinsfile('heimdall', `EXT_USER = 'linuxserver'\nEXT_REPO = 'Heimdall'`),
    repo('linuxserver/Heimdall'),
  ])
  const s = await sourceFor(heimdall)
  assert.deepEqual([s.repo, s.tier, s.confidence], ['linuxserver/Heimdall', 'lsio-build', 'high'])
  assertAllMocked(h)
})

test('equally good links are ambiguity, and give nothing', async (t) => {
  const h = mockFetch(t, [
    hub('acme/widget', 'Server: https://github.com/acme/widget-server. Desktop: https://github.com/acme/widgets.'),
    repo('acme/widget-server'),
    repo('acme/widgets'),
    noRepo('acme/widget'),
  ])
  const l = await lookUpImage({ registry: 'docker.io', repository: 'acme/widget' }, '1.0.0', { allowBilled: false })
  assert.equal(l.repo, null)
  assert.ok(l.evidence.candidates.some((c) => /linked alongside/.test(c.why)), JSON.stringify(l.evidence))
  assertAllMocked(h)
})

test("a deleted repository and someone else's fork are both turned down", async (t) => {
  const h = mockFetch(t, [
    hub('ttlequals0/minuspod', 'Old home: https://github.com/ttlequals0/minuspod-legacy. Mirror: https://github.com/someone/minuspod.'),
    noRepo('ttlequals0/minuspod-legacy'),
    repo('someone/minuspod', { fork: true, parent: 'ttlequals0/MinusPod' }),
    noRepo('ttlequals0/minuspod'),
  ])
  const l = await lookUpImage(MINUSPOD, '2.96.17-cpu', { allowBilled: false })
  assert.equal(l.repo, null)
  const why = l.evidence.candidates.map((c) => `${c.repo}: ${c.why}`)
  assert.ok(why.includes('ttlequals0/minuspod-legacy: GitHub has no such repository'), why.join('\n'))
  assert.ok(why.includes('someone/minuspod: a fork of ttlequals0/MinusPod'), why.join('\n'))
  assertAllMocked(h)
})

test('a config label the image inherited is set aside; the same repository as an annotation is not', async (t) => {
  const widget = { registry: 'docker.io', repository: 'acme/widget' }
  const registry = 'https://registry-1.docker.io/v2/acme/widget'
  let annotated = false
  const h = mockFetch(t, [
    hub('acme/widget', ''),
    {
      url: `${registry}/manifests/1.4.2`,
      reply: () =>
        json(
          annotated
            ? { annotations: { 'org.opencontainers.image.source': 'https://github.com/acme/base' }, config: { digest: 'sha256:cfg' } }
            : { config: { digest: 'sha256:cfg' } },
        ),
    },
    {
      url: `${registry}/blobs/sha256:cfg`,
      reply: () =>
        json({ config: { Labels: { 'org.opencontainers.image.source': 'https://github.com/acme/base', 'org.opencontainers.image.version': '22.04' } } }),
    },
    repo('acme/base'),
    noRepo('acme/widget'),
  ])

  const label = await lookUpImage(widget, '1.4.2')
  assert.equal(label.repo, null)
  assert.ok(label.evidence.candidates.some((c) => /inherited/.test(c.why)), JSON.stringify(label.evidence))

  annotated = true
  const annotation = await lookUpImage(widget, '1.4.2')
  assert.deepEqual([annotation.repo, annotation.tier, annotation.confidence], ['acme/base', 'annotation', 'high'])
  assertAllMocked(h)
})

test('two tiers arriving at the same repository make it certain', async (t) => {
  // The Docker Hub namespace kept the project's old name; GitHub followed the rename.
  const h = mockFetch(t, [
    hub('oldname/glance', 'Code: https://github.com/glanceapp/glance'),
    repo('glanceapp/glance'),
    repo('oldname/glance', { fullName: 'glanceapp/glance' }),
  ])
  const l = await lookUpImage({ registry: 'docker.io', repository: 'oldname/glance' }, 'v1.0.0', { allowBilled: false })
  assert.deepEqual([l.repo, l.tier, l.confidence], ['glanceapp/glance', 'description', 'high'])
  assert.match(l.detail ?? '', /; also a GitHub repository with the image's owner and name/)
  assertAllMocked(h)
})

test("GitHub's rate limit is a failure to look, retried within the hour, never a week-long none", async (t) => {
  image('minuspod', 'minuspod', MINUSPOD, '2.96.17-cpu')
  const reset = String(Math.floor(Date.now() / 1000) + 600)
  const h = mockFetch(t, [
    hub('ttlequals0/minuspod', 'https://github.com/ttlequals0/MinusPod'),
    { url: /^https:\/\/api\.github\.com\/repos\//, reply: () => status(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }) },
  ])
  const s = await sourceFor(MINUSPOD, { allowBilled: false })
  assert.equal(s.repo, null)
  assert.match(s.error ?? '', /rate limit/)
  const inMinutes = (Date.parse(s.nextCheckAt!) - Date.now()) / 60_000
  assert.ok(inMinutes > 0 && inMinutes <= 61, `next look in ${inMinutes} minutes`)
  assertAllMocked(h)
})

test('the sweep skips labelled images and curated ones cost nothing', async (t) => {
  image('db', 'postgres', { registry: 'docker.io', repository: 'library/postgres' }, '17')
  image('openclaw', 'signal-cli', { registry: 'registry.gitlab.com', repository: 'packaging/signal-cli/signal-cli-native' }, 'v0-14-7-1', 'AsamK/signal-cli')
  const h = mockFetch(t, [])
  const r = await resolveWatched({ allowBilled: false })
  assert.deepEqual(r, { looked: 1, linked: 1, failed: 0, due: 1 })
  assert.equal(h.calls.length, 0)
  assertAllMocked(h)
})

test('the sweep stops at its limit, and takes the images never looked up first', async (t) => {
  image('a', 'one', { registry: 'docker.io', repository: 'library/postgres' }, '17')
  image('b', 'two', { registry: 'docker.io', repository: 'library/redis' }, '7')
  const h = mockFetch(t, [])
  const first = await resolveWatched({ limit: 1 })
  assert.deepEqual({ looked: first.looked, due: first.due }, { looked: 1, due: 2 })
  const second = await resolveWatched({ limit: 1 })
  assert.deepEqual({ looked: second.looked, due: second.due }, { looked: 1, due: 1 })
  assert.equal((await resolveWatched({ limit: 1 })).due, 0)
  assertAllMocked(h)
})
