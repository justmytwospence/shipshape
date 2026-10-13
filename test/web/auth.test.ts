import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { serve } from '@hono/node-server'
import { socketBindings, TEST_PROXY, TEST_USER } from '../helpers/trusted-proxy.ts'

let createApp: typeof import('../../src/web/server.ts').createApp
let dir: string

before(async () => {
  // Never open the live database or arm git/GitHub/docker work if a guard regresses.
  dir = mkdtempSync(join(tmpdir(), 'shipshape-auth-test-'))
  process.env.DATA_DIR = dir
  delete process.env.REPO_DIR
  delete process.env.HOMELAB_REPO
  delete process.env.GITHUB_REPO
  delete process.env.GITHUB_TOKEN
  delete process.env.ANTHROPIC_API_KEY
  ;({ createApp } = await import('../../src/web/server.ts'))
})

after(() => rmSync(dir, { recursive: true, force: true }))

function appWithConfig(config: { proxy?: string; user?: string } = { proxy: TEST_PROXY, user: TEST_USER }) {
  if (config.proxy === undefined) delete process.env.SHIPSHAPE_TRUSTED_PROXY
  else process.env.SHIPSHAPE_TRUSTED_PROXY = config.proxy
  if (config.user === undefined) delete process.env.SHIPSHAPE_ALLOWED_USER
  else process.env.SHIPSHAPE_ALLOWED_USER = config.user
  return createApp()
}

const identity = { 'Remote-User': TEST_USER }
const forged = {
  ...identity,
  'X-Forwarded-For': TEST_PROXY,
  'X-Real-IP': TEST_PROXY,
  Forwarded: `for=${TEST_PROXY}`,
}

function concrete(path: string): string {
  return path.replace(/:\w+/g, '1')
}

test('forged identity and forwarded IP headers never substitute for the socket peer', async () => {
  const app = appWithConfig()
  for (const peer of ['192.0.2.19', '192.0.2.180', '127.0.0.1', '::ffff:192.0.2.19', undefined]) {
    const res = await app.request('/images', { headers: forged }, socketBindings(peer))
    assert.equal(res.status, 403, peer ?? 'socket address missing')
    assert.equal(res.headers.get('Cache-Control'), 'no-store')
  }
  // Hono in-process requests have no socket unless the test explicitly supplies one.
  assert.equal((await app.request('/images', { headers: forged })).status, 403)
  assert.equal((await app.request('/images', { headers: forged }, {})).status, 403)
})

test('the trusted peer still needs exactly the configured Remote-User', async () => {
  const app = appWithConfig()
  for (const user of [undefined, '', 'someone-else', TEST_USER.toUpperCase(), `${TEST_USER}-extra`, `${TEST_USER}, someone-else`]) {
    const headers = new Headers()
    if (user !== undefined) headers.set('Remote-User', user)
    // Neither an alternate identity header nor a trusted forwarded IP is sufficient.
    headers.set('X-Remote-User', TEST_USER)
    headers.set('X-Forwarded-For', TEST_PROXY)
    assert.equal((await app.request('/images', { headers }, socketBindings(TEST_PROXY))).status, 403, user ?? 'missing user')
  }
  const duplicates = new Headers(identity)
  duplicates.append('Remote-User', TEST_USER)
  assert.equal((await app.request('/images', { headers: duplicates }, socketBindings(TEST_PROXY))).status, 403)
})

test('auth protects every read route, static handler, redirect and unknown path', async () => {
  const app = appWithConfig()
  const paths = app.routes.filter((r) => r.method === 'GET' && r.path !== '/health').map((r) => concrete(r.path))
  paths.push('/static/app.css', '/static/manifest.webmanifest', '/not-a-route', '/health/', '/health/extra')
  for (const path of paths) {
    assert.equal((await app.request(path)).status, 403, path)
    assert.equal((await app.request(path, { headers: forged }, socketBindings('192.0.2.19'))).status, 403, `${path}: forged user`)
  }
  assert.equal(existsSync(join(dir, 'shipshape.db')), false, 'denied reads never even open the database')
})

test('all mutating routes are denied before any handler can do work', async () => {
  const app = appWithConfig()
  const routes = app.routes.filter((r) => r.method === 'POST')
  assert.ok(routes.length > 0)
  for (const { path } of routes) {
    for (const [headers, bindings] of [
      [{}, socketBindings(TEST_PROXY)],
      [forged, socketBindings('192.0.2.19')],
      [{ 'Remote-User': 'someone-else' }, socketBindings(TEST_PROXY)],
    ] as const) {
      const res = await app.request(concrete(path), {
        method: 'POST',
        headers: { ...headers, 'HX-Request': 'true' },
        body: new URLSearchParams({ paused: 'true' }),
      }, bindings)
      assert.equal(res.status, 403, path)
      assert.equal(res.headers.get('HX-Trigger'), null, `${path}: no handler toast`)
    }
  }
  for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    assert.equal((await app.request('/settings', { method, headers: forged }, socketBindings('192.0.2.19'))).status, 403, method)
  }
  assert.equal(existsSync(join(dir, 'shipshape.db')), false, 'denied mutations never even open the database')
})

test('missing or invalid authentication configuration fails closed, even in production', async () => {
  process.env.NODE_ENV = 'production'
  const configs = [
    {},
    { proxy: TEST_PROXY },
    { user: TEST_USER },
    { proxy: '', user: TEST_USER },
    { proxy: TEST_PROXY, user: '' },
    { proxy: TEST_PROXY, user: '   ' },
    ...['*', 'localhost', '192.0.2.0/24', `${TEST_PROXY},192.0.2.19`, ` ${TEST_PROXY}`].map((proxy) => ({ proxy, user: TEST_USER })),
  ]
  for (const config of configs) {
    const app = appWithConfig(config)
    for (const [path, method] of [['/images', 'GET'], ['/settings', 'POST'], ['/static/app.css', 'GET']]) {
      const res = await app.request(path!, { method, headers: identity }, socketBindings(TEST_PROXY))
      assert.equal(res.status, 503, JSON.stringify(config))
      assert.equal(res.headers.get('Cache-Control'), 'no-store')
    }
    const health = await app.request('/health')
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true })
  }
  delete process.env.NODE_ENV
})

test('test/dev flags and request bindings cannot override production auth configuration', async () => {
  process.env.NODE_ENV = 'test'
  process.env.SHIPSHAPE_UI_DEV = '1'
  const app = appWithConfig({})
  const res = await app.request('/images', { headers: identity }, {
    ...socketBindings(TEST_PROXY),
    SHIPSHAPE_TRUSTED_PROXY: TEST_PROXY,
    SHIPSHAPE_ALLOWED_USER: TEST_USER,
  })
  assert.equal(res.status, 503)
  // Configuration is captured at app creation, not inherited from a later test app.
  appWithConfig()
  assert.equal((await app.request('/images', { headers: identity }, socketBindings(TEST_PROXY))).status, 503)
  delete process.env.NODE_ENV
  delete process.env.SHIPSHAPE_UI_DEV
})

test('only exact GET /health is anonymous; HEAD and all other methods remain protected', async () => {
  for (const app of [appWithConfig(), appWithConfig({})]) {
    const health = await app.request('/health?probe=1', { headers: { 'Remote-User': 'someone-else' } }, socketBindings('192.0.2.19'))
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true })
    for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      assert.ok([403, 503].includes((await app.request('/health', { method })).status), method)
    }
  }
})

test('the exact trusted peer and user work, including IPv4-mapped socket addresses', async () => {
  for (const proxy of [TEST_PROXY, `::ffff:${TEST_PROXY}`]) {
    const app = appWithConfig({ proxy, user: TEST_USER })
    for (const peer of [TEST_PROXY, `::ffff:${TEST_PROXY}`]) {
      const res = await app.request('/images', { headers: identity }, socketBindings(peer))
      assert.equal(res.status, 301)
      assert.equal(res.headers.get('Location'), '/services')
    }
    for (const path of ['/static/app.css', '/sw.js']) {
      assert.equal((await app.request(path, { headers: identity }, socketBindings(TEST_PROXY))).status, 200, path)
    }
  }
})

test('the real Node adapter uses its socket, never a forged HTTP header', async (t) => {
  for (const [proxy, expected] of [[TEST_PROXY, 403], ['127.0.0.1', 301]] as const) {
    const app = appWithConfig({ proxy, user: TEST_USER })
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
    t.after(() => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())))
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const base = `http://127.0.0.1:${address.port}`
    const res = await fetch(`${base}/images`, { headers: forged, redirect: 'manual' })
    assert.equal(res.status, expected)
    await res.text()
    const health = await fetch(`${base}/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true })
  }
})
