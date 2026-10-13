import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { serve } from '@hono/node-server'
import { request as httpRequest } from 'node:http'
import { socketBindings, TEST_ORIGIN, TEST_PROXY, TEST_USER } from '../helpers/trusted-proxy.ts'

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

function appWithConfig(config: { proxy?: string; user?: string; origin?: string } = {
  proxy: TEST_PROXY, user: TEST_USER, origin: TEST_ORIGIN,
}) {
  if (config.proxy === undefined) delete process.env.SHIPSHAPE_TRUSTED_PROXY
  else process.env.SHIPSHAPE_TRUSTED_PROXY = config.proxy
  if (config.user === undefined) delete process.env.SHIPSHAPE_ALLOWED_USER
  else process.env.SHIPSHAPE_ALLOWED_USER = config.user
  if (config.origin === undefined) delete process.env.SHIPSHAPE_ALLOWED_ORIGIN
  else process.env.SHIPSHAPE_ALLOWED_ORIGIN = config.origin
  return createApp()
}

// A harmless handler lets every method exercise the real global guard, not a 404.
function probeApp(config?: Parameters<typeof appWithConfig>[0]) {
  const app = appWithConfig(config)
  app.all('/csrf-probe', (c) => c.text('ok'))
  return app
}

const unsafeMethods = ['POST', 'PUT', 'PATCH', 'DELETE']
const identity = { 'Remote-User': TEST_USER }
const browserIdentity = { ...identity, Origin: TEST_ORIGIN }
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
        headers: { ...headers, Origin: TEST_ORIGIN, 'HX-Request': 'true' },
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
    SHIPSHAPE_ALLOWED_ORIGIN: TEST_ORIGIN,
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

test('every mutating UI route rejects a missing or foreign Origin despite valid proxy authentication', async () => {
  const app = appWithConfig()
  const routes = app.routes.filter((r) => unsafeMethods.includes(r.method))
  assert.ok(routes.length > 0)
  for (const { method, path } of routes) {
    for (const origin of [undefined, 'https://foreign.example.test']) {
      const headers = new Headers({ ...identity, 'HX-Request': 'true' })
      if (origin !== undefined) headers.set('Origin', origin)
      const res = await app.request(concrete(path), {
        method, headers, body: new URLSearchParams({ paused: 'true' }),
      }, socketBindings(TEST_PROXY))
      assert.equal(res.status, 403, `${method} ${path}: ${origin ?? 'missing Origin'}`)
      assert.equal(res.headers.get('Cache-Control'), 'no-store')
      assert.equal(res.headers.get('HX-Trigger'), null, 'no handler toast')
    }
  }
  for (const method of unsafeMethods) {
    assert.equal((await app.request('/not-a-route', { method, headers: identity }, socketBindings(TEST_PROXY))).status, 403)
  }
  assert.equal(existsSync(join(dir, 'shipshape.db')), false, 'CSRF refusals never even open the database')
})

test('all unsafe methods require an exact single Origin for every content type, including HTMX and JSON', async () => {
  const app = probeApp()
  const origins = [
    undefined, '', 'null', 'not-an-origin', 'https://foreign.example.test',
    'http://shipshape.example.test', `${TEST_ORIGIN}/`, `${TEST_ORIGIN}/path`,
    `${TEST_ORIGIN}:444`, `${TEST_ORIGIN}.evil.test`, TEST_ORIGIN.toUpperCase(),
    `${TEST_ORIGIN}, ${TEST_ORIGIN}`, `${TEST_ORIGIN} https://foreign.example.test`,
  ]
  for (const method of unsafeMethods) {
    for (const contentType of [undefined, 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=test', 'text/plain', 'application/json']) {
      for (const origin of origins) {
        const headers = new Headers({ ...identity, 'HX-Request': 'true', 'Sec-Fetch-Site': 'same-origin' })
        if (origin !== undefined) headers.set('Origin', origin)
        if (contentType !== undefined) headers.set('Content-Type', contentType)
        const res = await app.request('/csrf-probe', { method, headers }, socketBindings(TEST_PROXY))
        assert.equal(res.status, 403, `${method}, ${contentType}, ${origin}`)
        assert.equal(res.headers.get('Cache-Control'), 'no-store')
        assert.equal(await res.text(), 'Forbidden', 'handler never runs')
      }
      const headers = new Headers(browserIdentity)
      if (contentType !== undefined) headers.set('Content-Type', contentType)
      const allowed = await app.request('/csrf-probe', { method, headers }, socketBindings(TEST_PROXY))
      assert.equal(allowed.status, 200, `${method}, ${contentType}: exact Origin`)
      assert.equal(await allowed.text(), 'ok')
    }
    const duplicates = new Headers(browserIdentity)
    duplicates.append('Origin', TEST_ORIGIN)
    assert.equal((await app.request('/csrf-probe', { method, headers: duplicates }, socketBindings(TEST_PROXY))).status, 403)
  }
})

test('missing or invalid Origin configuration fails closed for unsafe methods but not safe reads or health', async () => {
  const origins = [
    undefined, '', ' ', 'null', '*', 'not-a-url', 'shipshape.example.test',
    '//shipshape.example.test', 'ftp://shipshape.example.test', 'ws://shipshape.example.test',
    `${TEST_ORIGIN}/`, `${TEST_ORIGIN}/path`, `${TEST_ORIGIN}?query=1`, `${TEST_ORIGIN}#fragment`,
    'https://user:pass@shipshape.example.test', 'https://*.example.test',
    'https://shipshape.${DOMAIN}', 'https://shipshape.${domain}',
    `${TEST_ORIGIN}, https://foreign.example.test`, ` ${TEST_ORIGIN}`, `${TEST_ORIGIN} `,
    TEST_ORIGIN.toUpperCase(), `${TEST_ORIGIN}:443`, `${TEST_ORIGIN}:99999`,
  ]
  for (const origin of origins) {
    const app = probeApp({ proxy: TEST_PROXY, user: TEST_USER, origin })
    for (const method of unsafeMethods) {
      // Even a request matching the invalid configuration cannot open the guard.
      const headers = { ...browserIdentity, Origin: origin ?? TEST_ORIGIN }
      const res = await app.request('/csrf-probe', { method, headers }, socketBindings(TEST_PROXY))
      assert.equal(res.status, 503, `${method}: ${origin}`)
      assert.equal(res.headers.get('Cache-Control'), 'no-store')
      assert.equal(await res.text(), 'CSRF protection unavailable')
    }
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const res = await app.request('/csrf-probe', { method, headers: identity }, socketBindings(TEST_PROXY))
      assert.equal(res.status, 200, `${method}: ${origin}`)
    }
    assert.equal((await app.request('/images', { headers: identity }, socketBindings(TEST_PROXY))).status, 301)
    assert.equal((await app.request('/health')).status, 200)
    assert.equal((await app.request('/health', { method: 'HEAD' })).status, 403)
    assert.equal((await app.request('/health', { method: 'HEAD', headers: identity }, socketBindings(TEST_PROXY))).status, 200)
  }
})

test('safe requests do not need Origin, and even foreign Origin does not change their authentication', async () => {
  const app = probeApp()
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    for (const origin of [undefined, 'null', 'https://foreign.example.test']) {
      const headers = new Headers(identity)
      if (origin !== undefined) headers.set('Origin', origin)
      assert.equal((await app.request('/csrf-probe', { method, headers }, socketBindings(TEST_PROXY))).status, 200)
      assert.equal((await app.request('/csrf-probe', { method, headers }, socketBindings('192.0.2.19'))).status, 403)
      assert.equal((await app.request('/csrf-probe', { method }, socketBindings(TEST_PROXY))).status, 403)
      const health = await app.request('/health?probe=1', { headers }, socketBindings('192.0.2.19'))
      assert.equal(health.status, 200)
      assert.deepEqual(await health.json(), { ok: true })
    }
  }
})

test('valid Origin is necessary but never substitutes for the trusted peer and exact username', async () => {
  const app = probeApp()
  for (const method of unsafeMethods) {
    for (const peer of [TEST_PROXY, `::ffff:${TEST_PROXY}`]) {
      assert.equal((await app.request('/csrf-probe', { method, headers: browserIdentity }, socketBindings(peer))).status, 200)
    }
    for (const peer of [undefined, '192.0.2.19']) {
      assert.equal((await app.request('/csrf-probe', { method, headers: browserIdentity }, socketBindings(peer))).status, 403)
    }
    for (const user of [undefined, '', 'someone-else']) {
      const headers = new Headers({ Origin: TEST_ORIGIN })
      if (user !== undefined) headers.set('Remote-User', user)
      assert.equal((await app.request('/csrf-probe', { method, headers }, socketBindings(TEST_PROXY))).status, 403)
    }
  }
})

test('request URLs, Host, forwarded headers and Referer cannot replace or redefine Origin', async () => {
  const app = probeApp()
  const spoofed = {
    ...identity,
    Host: 'shipshape.example.test',
    Forwarded: 'for=192.0.2.18;host=shipshape.example.test;proto=https',
    'X-Forwarded-Host': 'shipshape.example.test',
    'X-Forwarded-Proto': 'https',
    'X-Forwarded-Port': '443',
    'X-Forwarded-Origin': TEST_ORIGIN,
    'X-Origin': TEST_ORIGIN,
    Referer: `${TEST_ORIGIN}/settings`,
    'Sec-Fetch-Site': 'same-origin',
    'HX-Request': 'true',
  }
  for (const method of unsafeMethods) {
    for (const origin of [undefined, 'https://foreign.example.test']) {
      const headers = new Headers(spoofed)
      if (origin !== undefined) headers.set('Origin', origin)
      assert.equal((await app.request(`${TEST_ORIGIN}/csrf-probe`, { method, headers }, socketBindings(TEST_PROXY))).status, 403)
    }
    // A foreign Origin matching both the request URL and spoofed proxy host is still foreign.
    const headers = {
      ...spoofed, Origin: 'https://foreign.example.test', Host: 'foreign.example.test',
      'X-Forwarded-Host': 'foreign.example.test',
      Forwarded: 'host=foreign.example.test;proto=https',
    }
    assert.equal((await app.request('https://foreign.example.test/csrf-probe', { method, headers }, socketBindings(TEST_PROXY))).status, 403)
    assert.equal((await app.request('http://internal-app/csrf-probe', {
      method, headers: { ...headers, Origin: TEST_ORIGIN },
    }, socketBindings(TEST_PROXY))).status, 200, 'only the configured browser Origin matters')
  }
})

test('WebSocket upgrade attempts require Origin and identity even on GET /health', async () => {
  for (const app of [probeApp(), probeApp({ proxy: TEST_PROXY, user: TEST_USER })]) {
    for (const upgrade of ['websocket', 'WebSocket', 'other, WebSocket']) {
      for (const path of ['/csrf-probe', '/health']) {
        const headers = { ...identity, Connection: 'Upgrade', Upgrade: upgrade }
        const res = await app.request(path, { headers }, socketBindings(TEST_PROXY))
        assert.ok([403, 503].includes(res.status), `${path}: ${upgrade}`)
        assert.equal(res.headers.get('Cache-Control'), 'no-store')
        assert.ok([403, 503].includes((await app.request(path, {
          headers: { ...headers, Origin: 'https://foreign.example.test' },
        }, socketBindings(TEST_PROXY))).status))
      }
    }
  }
  const app = probeApp()
  for (const path of ['/csrf-probe', '/health']) {
    const headers = { ...browserIdentity, Connection: 'Upgrade', Upgrade: 'websocket' }
    assert.equal((await app.request(path, { headers }, socketBindings(TEST_PROXY))).status, 200)
    assert.equal((await app.request(path, { headers }, socketBindings('192.0.2.19'))).status, 403)
    assert.equal((await app.request(path, {
      headers: { Origin: TEST_ORIGIN, Upgrade: 'websocket' },
    }, socketBindings(TEST_PROXY))).status, 403)
  }
})

test('Origin configuration is captured at app creation, with no dev/test or binding bypass', async () => {
  process.env.NODE_ENV = 'test'
  process.env.SHIPSHAPE_UI_DEV = '1'
  try {
    const missing = probeApp({ proxy: TEST_PROXY, user: TEST_USER })
    const valid = probeApp()
    const bindings = { ...socketBindings(TEST_PROXY), SHIPSHAPE_ALLOWED_ORIGIN: TEST_ORIGIN }
    assert.equal((await missing.request('/csrf-probe', { method: 'POST', headers: browserIdentity }, bindings)).status, 503)
    probeApp({ proxy: TEST_PROXY, user: TEST_USER, origin: 'invalid' })
    assert.equal((await valid.request('/csrf-probe', { method: 'POST', headers: browserIdentity }, bindings)).status, 200)
    assert.equal((await valid.request('/csrf-probe', { method: 'POST', headers: identity }, bindings)).status, 403)
  } finally {
    delete process.env.NODE_ENV
    delete process.env.SHIPSHAPE_UI_DEV
  }
})

test('explicit canonical origins with non-default ports also require an exact match', async () => {
  for (const origin of ['https://shipshape.example.test:8443', 'http://localhost:8787', 'https://[::1]:8443']) {
    const app = probeApp({ proxy: TEST_PROXY, user: TEST_USER, origin })
    assert.equal((await app.request('/csrf-probe', {
      method: 'POST', headers: { ...identity, Origin: origin },
    }, socketBindings(TEST_PROXY))).status, 200)
    assert.equal((await app.request('/csrf-probe', { method: 'POST', headers: browserIdentity }, socketBindings(TEST_PROXY))).status, 403)
  }
})

test('the real Node adapter preserves Origin checks, including duplicate HTTP headers and forms', async (t) => {
  const app = probeApp({ proxy: '127.0.0.1', user: TEST_USER, origin: TEST_ORIGIN })
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
  t.after(() => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())))
  if (!server.listening) await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  for (const method of unsafeMethods) {
    for (const origin of [undefined, 'https://foreign.example.test', TEST_ORIGIN]) {
      const headers = new Headers({ ...identity, 'Sec-Fetch-Site': 'same-origin', 'X-Forwarded-Origin': TEST_ORIGIN })
      if (origin !== undefined) headers.set('Origin', origin)
      const res = await fetch(`${base}/csrf-probe`, { method, headers, body: new URLSearchParams({ paused: 'true' }) })
      assert.equal(res.status, origin === TEST_ORIGIN ? 200 : 403, `${method}: ${origin}`)
      assert.equal(await res.text(), origin === TEST_ORIGIN ? 'ok' : 'Forbidden')
    }
  }
  const multipart = await fetch(`${base}/csrf-probe`, { method: 'POST', headers: browserIdentity, body: new FormData() })
  assert.equal(multipart.status, 200)
  await multipart.text()
  const htmx = await fetch(`${base}/csrf-probe`, {
    method: 'POST', headers: { ...browserIdentity, 'HX-Request': 'true' }, body: new URLSearchParams({ paused: 'true' }),
  })
  assert.equal(htmx.status, 200)
  await htmx.text()
  for (const second of [TEST_ORIGIN, 'https://foreign.example.test']) {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(`${base}/csrf-probe`, {
        method: 'POST',
        headers: { ...identity, Origin: [TEST_ORIGIN, second] },
      }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(status, 403, `duplicate Origin: ${second}`)
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
