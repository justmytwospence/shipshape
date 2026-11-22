import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import dns from 'node:dns'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Where a registry may send shipshape: redirects and token realms that leave its host must
 * be public https, paging stays on the host, and Docker Hub credentials go to Docker Hub.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-registry-hops-'))
process.env.DATA_DIR = dir
process.env.DOCKER_HUB_LOGIN = 'me'
process.env.DOCKER_HUB_PASSWORD = 'pw'
after(() => rmSync(dir, { recursive: true, force: true }))

const { headDigest, listTags } = await import('../src/registry/index.ts')
const { setMinSpacingForTests } = await import('../src/registry/http.ts')
const { mockFetch, assertAllMocked, json, status } = await import('./helpers/http.ts')
setMinSpacingForTests(0)

const DIGEST = 'sha256:' + 'a'.repeat(64)
const resolveTo = (t: import('node:test').TestContext, address: string) =>
  t.mock.method(dns.promises, 'lookup', async () => [{ address, family: 4 }])

test('a redirect to another public host is followed without the bearer', async (t) => {
  resolveTo(t, '140.82.114.4')
  const h = mockFetch(t, [
    { url: 'https://ghcr.io/v2/a/one/manifests/1', reply: () => status(307, { location: 'https://pkg-containers.githubusercontent.com/x' }) },
    { url: 'https://pkg-containers.githubusercontent.com/x', reply: () => status(200, { 'docker-content-digest': DIGEST }) },
  ])
  assert.equal(await headDigest('ghcr.io', 'a/one', '1'), DIGEST)
  assert.equal(h.calls[1]!.headers.get('authorization'), null)
  assertAllMocked(h)
})

test('a redirect to a private address is refused and named', async (t) => {
  resolveTo(t, '10.0.0.5')
  const h = mockFetch(t, [
    { url: 'https://ghcr.io/v2/a/two/manifests/1', reply: () => status(307, { location: 'https://cdn.example.com/x' }) },
  ])
  await assert.rejects(headDigest('ghcr.io', 'a/two', '1'), /private address/)
  assert.equal(h.calls.length, 1)
})

test('a redirect to plain http on another host is refused', async (t) => {
  resolveTo(t, '140.82.114.4')
  mockFetch(t, [{ url: 'https://ghcr.io/v2/a/three/manifests/1', reply: () => status(302, { location: 'http://cdn.example.com/x' }) }])
  await assert.rejects(headDigest('ghcr.io', 'a/three', '1'), /not https/)
})

test('a token realm on a private address is refused', async (t) => {
  resolveTo(t, '192.168.1.2')
  mockFetch(t, [
    {
      url: 'https://ghcr.io/v2/a/four/manifests/1',
      reply: () => status(401, { 'www-authenticate': 'Bearer realm="https://evil.example.com/token",scope="repository:a/four:pull"' }),
    },
  ])
  await assert.rejects(headDigest('ghcr.io', 'a/four', '1'), /private address/)
})

test('Docker Hub credentials go only to auth.docker.io', async (t) => {
  resolveTo(t, '52.1.1.1')
  const h = mockFetch(t, [
    {
      url: /registry-1\.docker\.io\/v2\/library\/elsewhere\/manifests/,
      reply: (req) =>
        req.headers.get('authorization')
          ? status(200, { 'docker-content-digest': DIGEST })
          : status(401, { 'www-authenticate': 'Bearer realm="https://auth.example.net/token",scope="x"' }),
    },
    { url: /^https:\/\/auth\.example\.net\/token/, reply: () => json({ token: 't1' }) },
    {
      url: /registry-1\.docker\.io\/v2\/library\/hub\/manifests/,
      reply: (req) =>
        req.headers.get('authorization')
          ? status(200, { 'docker-content-digest': DIGEST })
          : status(401, { 'www-authenticate': 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"' }),
    },
    { url: /^https:\/\/auth\.docker\.io\/token/, reply: () => json({ token: 't2' }) },
  ])
  await headDigest('docker.io', 'library/elsewhere', '1')
  await headDigest('docker.io', 'library/hub', '1')
  const elsewhere = h.calls.find((c) => c.url.startsWith('https://auth.example.net'))!
  const hub = h.calls.find((c) => c.url.startsWith('https://auth.docker.io'))!
  assert.equal(elsewhere.headers.get('authorization'), null)
  assert.match(hub.headers.get('authorization') ?? '', /^Basic /)
  assertAllMocked(h)
})

test('a tag list that pages to another host stops with an error', async (t) => {
  mockFetch(t, [
    {
      url: /registry\.example\.com\/v2\/a\/b\/tags\/list/,
      reply: () => json({ tags: ['1'] }, { headers: { link: '<https://other.example.com/v2/a/b/tags/list?n=100&last=x>; rel="next"' } }),
    },
  ])
  await assert.rejects(listTags('registry.example.com', 'a/b'), /refusing to follow/)
})
