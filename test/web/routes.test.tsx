import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Every route, actually served.
 *
 * `paths` in config.ts is computed at module load from DATA_DIR, so the environment has
 * to be set before that module is imported -- hence the dynamic import. REPO_DIR is left
 * unset on purpose: `scanRepo` treats an absent repo as "no services" rather than an
 * error, so this exercises the unconfigured path too, which is the one a new deployment
 * sees first and the one nothing else covers.
 */

let app: { request: (path: string, init?: RequestInit) => Promise<Response> }
let dir: string

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shipshape-test-'))
  process.env.DATA_DIR = dir
  delete process.env.REPO_DIR
  delete process.env.HOMELAB_REPO
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.GITHUB_TOKEN
  const { createApp } = await import('../../src/web/server.ts')
  app = createApp() as never
})

after(() => rmSync(dir, { recursive: true, force: true }))

const PAGES = [
  '/',
  '/updates',
  '/services',
  '/services?group=stack',
  '/activity',
  '/settings',
  '/settings/advanced',
  '/settings/status',
  '/settings/prompts',
  '/settings/raw',
  '/docs',
]
const FRAGMENTS = [
  '/fragments/inbox',
  '/fragments/updates',
  '/fragments/services',
  '/fragments/activity',
  '/scan/status',
  '/settings/digest',
]

test('/about is gone, not moved', async () => {
  // It was absorbed into /settings behind the Explain switch. Deliberately a 404 rather
  // than a redirect: a redirect would keep a second name for a page alive indefinitely,
  // and there is nothing at the other end to land on -- the prose is spread across nine
  // panes, so no single anchor is the honest destination.
  assert.equal((await app.request('/about')).status, 404)
})

test('every page returns a whole document', async () => {
  for (const path of PAGES) {
    const res = await app.request(path)
    assert.equal(res.status, 200, path)
    const html = await res.text()
    // No theme attribute is asserted: the shell resolves it in an inline script before
    // first paint and leaves the attribute off entirely for `auto`, so that daisyUI's own
    // prefers-dark rule applies. Pinning it server-side would defeat that.
    assert.match(html, /^<html lang="en"[ >]/, path)
    assert.match(html, /<\/html>$/, path)
  }
})

test('every fragment returns a bare fragment, never a whole document', async () => {
  // A fragment that accidentally renders <html> gets swapped into the middle of the
  // page, which browsers quietly flatten -- no error, just a broken layout.
  for (const path of FRAGMENTS) {
    const res = await app.request(path)
    assert.equal(res.status, 200, path)
    assert.doesNotMatch(await res.text(), /<html[ >]|<head>|<body[ >]/, path)
  }
})

test('the unconfigured deployment gets setup instructions, not a crash', async () => {
  const html = await (await app.request('/')).text()
  assert.match(html, /shipshape is not configured yet/)
  assert.match(html, /REPO_DIR/)
})

test('the old addresses still land somewhere', async () => {
  // A bookmark, or a link in a months-old digest. A redirect costs nothing and a 404
  // costs the operator a search.
  for (const [from, to] of [
    ['/images', '/services'],
    ['/system', '/settings/status'],
  ]) {
    const res = await app.request(from)
    assert.equal(res.status, 301, from)
    assert.equal(res.headers.get('location'), to, from)
  }
})

test('checking one service answers even when it has been removed', async () => {
  // htmx swaps nothing on a 4xx, so a 404 here would read as a button that did nothing.
  const res = await app.request('/services/nope/nope/check', { method: 'POST' })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('HX-Trigger') ?? '', /no longer here/)
})

test('an operator verb always answers, whether or not it was allowed', async () => {
  // htmx swaps nothing on a 4xx: a refusal that returned one would look like a button
  // that did nothing. Every verb replies 200 with a sentence, and says which it was in
  // the toast rather than in the status code.
  for (const verb of ['dismiss', 'open-pr', 'deploy', 'redeploy', 'retry', 'rollback', 'ack', 'rerun-review']) {
    const res = await app.request(`/updates/9999/${verb}`, {
      method: 'POST',
      headers: { 'HX-Request': 'true' },
    })
    assert.equal(res.status, 200, verb)
    const trigger = JSON.parse(res.headers.get('HX-Trigger') ?? '{}')
    assert.equal(trigger.toast?.level, 'warn', verb)
    assert.match(trigger.toast?.text ?? '', /no longer exists/, verb)
    assert.doesNotMatch(await res.text(), /<html/, `${verb} answers with a fragment`)
  }
})

test('a verb asked for outside htmx lands on the update, not on a fragment', async () => {
  // A form post from a phone with no JavaScript still has to end up somewhere readable.
  const res = await app.request('/updates/9999/deploy', { method: 'POST' })
  assert.equal(res.status, 303)
  assert.equal(res.headers.get('location'), '/updates/9999')
})

test('the health endpoint stays plain JSON for the container healthcheck', async () => {
  const res = await app.request('/health')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
})
