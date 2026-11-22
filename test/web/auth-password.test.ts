import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { scryptSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { socketBindings } from '../helpers/trusted-proxy.ts'

/**
 * Password mode: shipshape's own sign-in page and sessions.
 */

const PASSWORD = 'correct horse battery'
const PEER = '192.0.2.50'
const HOST = 'shipshape.lan:8080'
const ORIGIN = `http://${HOST}`
let dir = ''
let createApp: typeof import('../../src/web/server.ts').createApp
let getDb: typeof import('../../src/db.ts').getDb

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shipshape-auth-password-'))
  process.env.DATA_DIR = dir
  process.env.SHIPSHAPE_ACTION_SECRET = 'a-long-enough-action-secret-0123456789'
  for (const k of ['REPO_DIR', 'SHIPSHAPE_TRUSTED_PROXY', 'SHIPSHAPE_ALLOWED_USER', 'SHIPSHAPE_PASSWORD_FILE', 'SHIPSHAPE_ALLOWED_ORIGIN']) delete process.env[k]
  ;({ createApp } = await import('../../src/web/server.ts'))
  ;({ getDb } = await import('../../src/db.ts'))
})
after(() => rmSync(dir, { recursive: true, force: true }))

function app(password = PASSWORD, origin?: string) {
  process.env.SHIPSHAPE_PASSWORD = password
  if (origin === undefined) delete process.env.SHIPSHAPE_ALLOWED_ORIGIN
  else process.env.SHIPSHAPE_ALLOWED_ORIGIN = origin
  const a = createApp()
  return (path: string, init: RequestInit & { headers?: Record<string, string> } = {}, peer = PEER) =>
    a.request(path, { ...init, headers: { Host: HOST, ...(init.headers ?? {}) } }, socketBindings(peer))
}

async function signIn(req: ReturnType<typeof app>, peer = PEER): Promise<string> {
  const res = await req('/login', { method: 'POST', headers: { Origin: ORIGIN }, body: new URLSearchParams({ password: PASSWORD, next: '/' }) }, peer)
  assert.equal(res.status, 303)
  return /shipshape_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!
}

const cookie = (token: string) => ({ Cookie: `shipshape_session=${token}` })

test('an unauthenticated navigation is redirected to /login with next', async () => {
  const res = await app()('/updates?stage=all', { headers: { Accept: 'text/html' } })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), '/login?next=%2Fupdates%3Fstage%3Dall')
})

test('an unauthenticated htmx request gets 401 and HX-Redirect to /login', async () => {
  const res = await app()('/fragments/inbox', { headers: { 'HX-Request': 'true', 'HX-Current-URL': `${ORIGIN}/updates?stage=all` } })
  assert.equal(res.status, 401)
  assert.equal(res.headers.get('hx-redirect'), '/login?next=%2Fupdates%3Fstage%3Dall')
})

test('any other unauthenticated request gets 401', async () => {
  const req = app()
  assert.equal((await req('/scan', { method: 'POST', headers: { Origin: ORIGIN } })).status, 401)
  assert.equal((await req('/status', { headers: { Accept: 'application/json' } })).status, 401)
})

test('the right password sets a session cookie and redirects to next with 303', async () => {
  const res = await app()('/login', { method: 'POST', headers: { Origin: ORIGIN }, body: new URLSearchParams({ password: PASSWORD, next: '/status' }) })
  assert.equal(res.status, 303)
  assert.equal(res.headers.get('location'), '/status')
  assert.match(res.headers.get('set-cookie') ?? '', /^shipshape_session=/)
})

test('the cookie is HttpOnly, SameSite=Lax, Path=/, Max-Age 2592000, and Secure only for an https origin', async () => {
  const plain = await app()('/login', { method: 'POST', headers: { Origin: ORIGIN }, body: new URLSearchParams({ password: PASSWORD }) })
  const c = plain.headers.get('set-cookie')!
  for (const part of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=2592000']) assert.ok(c.includes(part), part)
  assert.ok(!c.includes('Secure'))
  const secure = await app(PASSWORD, 'https://shipshape.example.test')('/login', {
    method: 'POST',
    headers: { Origin: 'https://shipshape.example.test' },
    body: new URLSearchParams({ password: PASSWORD }),
  })
  assert.ok(secure.headers.get('set-cookie')!.includes('Secure'))
})

test('a wrong password is 401, sets no cookie and says only that the password is not right', async () => {
  const res = await app()('/login', { method: 'POST', headers: { Origin: ORIGIN }, body: new URLSearchParams({ password: 'nope' }) }, '192.0.2.51')
  assert.equal(res.status, 401)
  assert.equal(res.headers.get('set-cookie'), null)
  assert.match(await res.text(), /That password is not right\./)
})

test('next is validated: absolute URLs, //host, backslashes, control characters and /login loops fall back to /', async () => {
  const { safeNext } = await import('../../src/web/auth/password.ts')
  for (const bad of ['https://evil.example/', '//evil.example', '/\\evil', '/a\nb', '/login', '/login?next=/x', '/logout', '', 42]) {
    assert.equal(safeNext(bad), '/', String(bad))
  }
  assert.equal(safeNext('/updates?stage=all'), '/updates?stage=all')
})

test('the session cookie opens the app; a forged, truncated or empty cookie does not', async () => {
  const req = app()
  const token = await signIn(req)
  assert.equal((await req('/status', { headers: cookie(token) })).status, 200)
  for (const bad of ['x'.repeat(43), token.slice(0, 20), '']) {
    assert.equal((await req('/status', { headers: cookie(bad) })).status, 401, bad)
  }
})

test('the session is stored hashed: the cookie value appears nowhere in the sessions table', async () => {
  const token = await signIn(app())
  const rows = JSON.stringify(getDb().prepare(`SELECT * FROM sessions`).all())
  assert.ok(!rows.includes(token))
})

test('sessions slide: an old one is renewed and re-sets the cookie; a younger one writes nothing', async () => {
  const req = app()
  const token = await signIn(req)
  const fresh = await req('/status', { headers: cookie(token) })
  assert.equal(fresh.headers.get('set-cookie'), null)
  getDb().prepare(`UPDATE sessions SET last_seen_at = '2000-01-01T00:00:00.000Z'`).run()
  const old = await req('/status', { headers: cookie(token) })
  assert.match(old.headers.get('set-cookie') ?? '', /shipshape_session=/)
})

test('an expired session is refused', async () => {
  const req = app()
  const token = await signIn(req)
  getDb().prepare(`UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'`).run()
  assert.equal((await req('/status', { headers: cookie(token) })).status, 401)
})

test('changing the password invalidates every existing session and prunes them at startup', async () => {
  const token = await signIn(app())
  const other = app('another long password')
  assert.equal((await other('/status', { headers: cookie(token) })).status, 401)
  assert.equal((getDb().prepare(`SELECT COUNT(*) c FROM sessions WHERE pw_fingerprint != (SELECT pw_fingerprint FROM sessions ORDER BY created_at DESC LIMIT 1)`).get() as { c: number }).c, 0)
})

test('logout destroys the session and clears the cookie', async () => {
  const req = app()
  const token = await signIn(req)
  const res = await req('/logout', { method: 'POST', headers: { Origin: ORIGIN, ...cookie(token) } })
  assert.equal(res.status, 303)
  assert.match(res.headers.get('set-cookie') ?? '', /Max-Age=0/)
  assert.equal((await req('/status', { headers: cookie(token) })).status, 401)
})

test('logout needs a valid Origin', async () => {
  assert.equal((await app()('/logout', { method: 'POST' })).status, 403)
})

test('failed logins are limited to 5 per address in 15 minutes, then 429 with Retry-After, even for the right password', async () => {
  const req = app()
  const peer = '192.0.2.60'
  for (let i = 0; i < 5; i++) {
    await req('/login', { method: 'POST', headers: { Origin: ORIGIN }, body: new URLSearchParams({ password: 'nope' }) }, peer)
  }
  const res = await req('/login', { method: 'POST', headers: { Origin: ORIGIN }, body: new URLSearchParams({ password: PASSWORD }) }, peer)
  assert.equal(res.status, 429)
  assert.ok(Number(res.headers.get('retry-after')) > 0)
})

test('the global limit is 30 failures per 15 minutes across addresses', async () => {
  const req = app()
  for (let i = 0; i < 30; i++) {
    await req('/login', { method: 'POST', headers: { Origin: ORIGIN }, body: new URLSearchParams({ password: 'nope' }) }, `198.51.100.${i + 1}`)
  }
  const res = await req('/login', { method: 'POST', headers: { Origin: ORIGIN }, body: new URLSearchParams({ password: PASSWORD }) }, '198.51.100.99')
  assert.equal(res.status, 429)
})

test('the limiter forgets failures after the window and clears an address on success', async () => {
  const { LoginLimiter, LIMIT_WINDOW_MS } = await import('../../src/web/auth/password.ts')
  let now = 0
  const l = new LoginLimiter(() => now)
  for (let i = 0; i < 5; i++) l.fail('a')
  assert.ok(l.blockedFor('a') > 0)
  now += LIMIT_WINDOW_MS + 1
  assert.equal(l.blockedFor('a'), 0)
  for (let i = 0; i < 4; i++) l.fail('b')
  l.succeed('b')
  l.fail('b')
  assert.equal(l.blockedFor('b'), 0)
})

test('without SHIPSHAPE_ALLOWED_ORIGIN the Origin host must equal the Host header', async () => {
  const req = app()
  const token = await signIn(req)
  const post = (origin: string | null, extra: Record<string, string> = {}) =>
    req('/scan', { method: 'POST', headers: { ...cookie(token), ...(origin ? { Origin: origin } : {}), ...extra } })
  assert.equal((await post(ORIGIN)).status, 200)
  for (const bad of [`http://other.lan:8080`, null, 'null', `${ORIGIN}/path`, `${ORIGIN}, ${ORIGIN}`]) {
    assert.equal((await post(bad)).status, 403, String(bad))
  }
})

test('a DNS-rebinding request has no session and is refused whatever its Host and Origin say', async () => {
  const res = await app()('/scan', { method: 'POST', headers: { Host: 'evil.example', Origin: 'http://evil.example' } })
  assert.equal(res.status, 401)
})

test('with SHIPSHAPE_ALLOWED_ORIGIN set the Origin must equal it exactly, whatever Host says', async () => {
  const req = app(PASSWORD, 'https://shipshape.example.test')
  const login = await req('/login', { method: 'POST', headers: { Origin: 'https://shipshape.example.test' }, body: new URLSearchParams({ password: PASSWORD }) })
  const token = /shipshape_session=([^;]+)/.exec(login.headers.get('set-cookie')!)![1]!
  assert.equal((await req('/scan', { method: 'POST', headers: { ...cookie(token), Origin: 'https://shipshape.example.test' } })).status, 200)
  assert.equal((await req('/scan', { method: 'POST', headers: { ...cookie(token), Origin: ORIGIN } })).status, 403)
})

test('an invalid SHIPSHAPE_ALLOWED_ORIGIN in password mode is a configuration error', async () => {
  assert.equal((await app(PASSWORD, 'https://x.example/')('/status')).status, 503)
})

test('GET /login with a valid session redirects to next', async () => {
  const req = app()
  const token = await signIn(req)
  const res = await req('/login?next=%2Fstatus', { headers: cookie(token) })
  assert.equal(res.status, 303)
  assert.equal(res.headers.get('location'), '/status')
})

test('the login page is standalone: no htmx, no service worker, no app.js', async () => {
  const html = await (await app()('/login')).text()
  assert.match(html, /Sign in to shipshape/)
  assert.doesNotMatch(html, /htmx|sw\.js|app\.js/)
})

test('the signed action link survives sign-in', async () => {
  const { makeToken } = await import('../../src/notify/links.ts')
  const req = app()
  const tok = makeToken('ship', 1, process.env.SHIPSHAPE_ACTION_SECRET!)
  const res = await req(`/act/${tok}`, { headers: { Accept: 'text/html' } })
  assert.equal(res.headers.get('location'), `/login?next=${encodeURIComponent(`/act/${tok}`)}`)
  const token = await signIn(req)
  assert.notEqual((await req(`/act/${tok}`, { headers: cookie(token) })).status, 401)
})

test('the shell offers Sign out in password mode', async () => {
  const req = app()
  const token = await signIn(req)
  assert.match(await (await req('/status', { headers: cookie(token) })).text(), /action="\/logout"/)
})

test('the session fingerprint is keyed per install', async () => {
  const req = app()
  await signIn(req)
  const keyFile = join(dir, 'session-key')
  assert.equal(statSync(keyFile).mode & 0o777, 0o600)
  assert.match(readFileSync(keyFile, 'utf8'), /^[0-9a-f]{64}\n$/)
  const row = getDb().prepare(`SELECT pw_fingerprint FROM sessions ORDER BY created_at DESC LIMIT 1`).get() as { pw_fingerprint: string }
  assert.notEqual(row.pw_fingerprint, scryptSync(PASSWORD, 'shipshape-pw-fingerprint-v1', 16).toString('hex'))
})

test('the key survives a restart', async () => {
  const token = await signIn(app())
  const res = await app()('/status', { headers: cookie(token) })
  assert.equal(res.status, 200)
})

test('a malformed session-key is a setup problem', async () => {
  const d = mkdtempSync(join(tmpdir(), 'shipshape-key-'))
  try {
    writeFileSync(join(d, 'session-key'), 'nonsense')
    const { parsePasswordConfig } = await import('../../src/web/auth/password.ts')
    const r = parsePasswordConfig({ SHIPSHAPE_PASSWORD: 'x'.repeat(12), DATA_DIR: d })
    assert.equal(r.ok, false)
    assert.match(r.ok ? '' : r.problems.join(), /is not a key shipshape wrote/)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('a password over 1024 characters is a setup problem', async () => {
  const d = mkdtempSync(join(tmpdir(), 'shipshape-long-'))
  try {
    const { parsePasswordConfig } = await import('../../src/web/auth/password.ts')
    const long = parsePasswordConfig({ SHIPSHAPE_PASSWORD: 'x'.repeat(1025), DATA_DIR: d })
    assert.equal(long.ok, false)
    assert.match(long.ok ? '' : long.problems.join(), /at most 1024 characters/)
    assert.equal(parsePasswordConfig({ SHIPSHAPE_PASSWORD: 'x'.repeat(1024), DATA_DIR: d }).ok, true)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})
