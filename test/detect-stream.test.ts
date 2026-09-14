import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Detection end to end, against a fake registry and a fake GitHub: the two services the
 * stream rule exists for.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-detect-stream-'))
process.env.DATA_DIR = dir
process.env.GITHUB_TOKEN = 'test-token'
delete process.env.REPO_DIR

const { getDb } = await import('../src/db.ts')
const { setMinSpacingForTests } = await import('../src/registry/http.ts')
const { detect } = await import('../src/detect.ts')
const { resetResolverMemo } = await import('../src/resolver/index.ts')
const { parseImageRef } = await import('../src/images/ref.ts')
const { mockFetch, assertAllMocked, json, status, text } = await import('./helpers/http.ts')
type ScannedService = import('../src/compose/scan.ts').ScannedService

setMinSpacingForTests(0)
after(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  getDb().exec(`DELETE FROM http_cache; DELETE FROM resolutions; DELETE FROM images;`)
  resetResolverMemo()
})

function svc(stack: string, service: string, image: string, pattern: string): ScannedService {
  return {
    stack,
    service,
    composeFile: `${stack}/docker-compose.yaml`,
    imageRaw: image,
    ref: parseImageRef(image),
    labels: {},
    profiles: [],
    hasBuild: false,
    watched: true,
    unwatchable: null,
    pattern,
    tagInclude: null,
    policyLabel: null,
    sourceLabel: null,
    claudeLabel: null,
    deployLabel: null,
    probePort: null,
    archivePre: null,
    networkMode: null,
    prLabel: null,
    proposeLabel: null,
    groupLabel: null,
    wud: { watch: null, tagInclude: null, gated: false, link: null },
  }
}

const hubTags = (repo: string, tags: string[]) => ({
  url: `https://hub.docker.com/v2/repositories/${repo}/tags?page_size=100&ordering=last_updated`,
  reply: () => json({ next: null, results: tags.map((name) => ({ name })) }),
})
const releases = (repo: string, list: [string, boolean][]) => ({
  url: `https://api.github.com/repos/${repo}/releases?per_page=100&page=1`,
  reply: () =>
    json(list.map(([tag_name, prerelease]) => ({ tag_name, name: tag_name, published_at: null, body: '', draft: false, prerelease }))),
})

/** An upstream already found, so these tests are about the stream and nothing else. */
function resolved(repository: string, repo: string): void {
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO resolutions (registry, repository, source_url, tier, confidence, resolved_at, checked_at, resolver_version)
       VALUES ('docker.io', ?, ?, 'description', 'high', ?, ?, 2)`,
    )
    .run(repository, repo, now, now)
}

test('n8n on stable 2.38.4 is offered the patch, not the beta', async (t) => {
  resolved('n8nio/n8n', 'n8n-io/n8n')
  const h = mockFetch(t, [
    hubTags('n8nio/n8n', ['2.38.4', '2.38.5', '2.39.0', '2.39.1']),
    releases('n8n-io/n8n', [['n8n@2.39.1', true], ['n8n@2.39.0', true], ['n8n@2.38.5', false], ['n8n@2.38.4', false]]),
  ])
  const d = await detect(svc('n8n', 'n8n', 'n8nio/n8n:2.38.4', 'semver'))
  assert.equal(d.status, 'update')
  assert.equal(d.status === 'update' && d.tag, '2.38.5')
  assert.match((d.status === 'update' && d.stream) || '', /stable stream/)
  assertAllMocked(h)
})

test('minuspod on 2.96.17 is offered its next prerelease, because that is its stream', async (t) => {
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO resolutions (registry, repository, source_url, tier, confidence, resolved_at, checked_at, resolver_version)
       VALUES ('docker.io', 'ttlequals0/minuspod', 'ttlequals0/MinusPod', 'annotation', 'high', ?, ?, 2)`,
    )
    .run(now, now)
  const h = mockFetch(t, [
    hubTags('ttlequals0/minuspod', ['2.96.17-cpu', '2.96.22-cpu', '2.96.22', 'latest']),
    releases('ttlequals0/MinusPod', [['v2.96.25', true], ['v2.96.22', true], ['v2.96.15', true], ['v2.95.3', false]]),
  ])
  const d = await detect(svc('minuspod', 'minuspod', 'ttlequals0/minuspod:2.96.17-cpu', 'semver-variant'))
  assert.equal(d.status === 'update' && d.tag, '2.96.22-cpu')
  assert.match((d.status === 'update' && d.stream) || '', /prerelease stream/)
  assertAllMocked(h)
})

test("code-server's stream is read from coder's releases, never from its packaging repo's", async (t) => {
  // A row written before packaging repositories were told apart names
  // linuxserver/docker-code-server, whose prerelease flags mark container build branches. It
  // is looked at again, LinuxServer's build file names coder/code-server, and coder's
  // releases decide: 4.138.0 is a prerelease there, so the stable service gets 4.137.0.
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO resolutions (registry, repository, source_url, tier, confidence, resolved_at, checked_at, resolver_version)
       VALUES ('lscr.io', 'linuxserver/code-server', 'linuxserver/docker-code-server', 'annotation', 'high', ?, ?, 1)`,
    )
    .run(now, now)
  const h = mockFetch(t, [
    hubTags('linuxserver/code-server', ['4.136.2-ls363', '4.137.0-ls364', '4.138.0-ls365']),
    {
      url: 'https://api.linuxserver.io/api/v1/images?include_config=false&include_deprecated=false',
      reply: () => json({ data: { repositories: { linuxserver: [{ name: 'code-server', project_url: 'https://coder.com' }] } } }),
    },
    {
      url: 'https://raw.githubusercontent.com/linuxserver/docker-code-server/HEAD/Jenkinsfile',
      reply: () => text(`EXT_RELEASE = sh(script: '''curl -sX GET https://api.github.com/repos/coder/code-server/releases/latest''')`),
    },
    { url: 'https://api.github.com/repos/coder/code-server', reply: () => json({ full_name: 'coder/code-server', fork: false }) },
    releases('coder/code-server', [['v4.138.0', true], ['v4.137.0', false], ['v4.136.2', false]]),
  ])
  const d = await detect(svc('code-server', 'code-server', 'lscr.io/linuxserver/code-server:4.136.2-ls363', 'lsio-ls'))
  assert.equal(d.status === 'update' && d.tag, '4.137.0-ls364')
  assert.match((d.status === 'update' && d.stream) || '', /stable stream/)
  assert.ok(!h.calls.some((c) => c.url.includes('docker-code-server/releases')), 'the packaging repo is never read')
  assertAllMocked(h)
})

test('when GitHub cannot be read, updates keep flowing rather than freezing', async (t) => {
  resolved('n8nio/n8n', 'n8n-io/n8n')
  const h = mockFetch(t, [
    hubTags('n8nio/n8n', ['2.38.4', '2.39.1']),
    { url: 'https://api.github.com/repos/n8n-io/n8n/releases?per_page=100&page=1', reply: () => status(403, { 'x-ratelimit-remaining': '0' }) },
  ])
  const d = await detect(svc('n8n', 'n8n', 'n8nio/n8n:2.38.4', 'semver'))
  assert.equal(d.status === 'update' && d.tag, '2.39.1', 'fail open: without evidence nothing is set aside')
  assertAllMocked(h)
})
