import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * The service worker is the one piece of this app that can break authentication, so its
 * two safety properties are asserted as source facts rather than trusted to review.
 *
 * A cached PWA shell in front of forward-auth renders from cache while every request
 * inside it bounces to a login page.
 */
const SW = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8')

test('navigations are never intercepted', () => {
  // Returning before respondWith means the browser handles Authelia's 302 exactly as it
  // would with no worker installed. That is what makes the failure class impossible
  // rather than merely unlikely.
  assert.match(SW, /if \(req\.mode === 'navigate'\) return/)
  const guard = SW.indexOf("req.mode === 'navigate'")
  const respond = SW.indexOf('e.respondWith')
  assert.ok(guard > -1 && guard < respond, 'the navigate guard must precede respondWith')
})

test('only same-origin /static/ responses are ever cached', () => {
  assert.match(SW, /url\.origin !== self\.location\.origin/)
  assert.match(SW, /!url\.pathname\.startsWith\('\/static\/'\)/)
  assert.match(SW, /req\.method !== 'GET'/)
})

test('a redirected or opaque response is never stored', () => {
  // If the session lapsed mid-install, every precache fetch is a redirect to the login
  // page. Storing one would pin that page under the URL of the stylesheet.
  assert.match(SW, /!r\.redirected/)
  assert.match(SW, /r\.type !== 'opaqueredirect'/)
})

test('a precache miss cannot abort installation', () => {
  // Traefik's error-pages middleware turns any 404 into a ~57 KB HTML body, so a stale
  // entry in the list would otherwise fail install with a baffling error.
  assert.match(SW, /Promise\.allSettled/)
})

test('every precached path exists in public/', () => {
  const listed = [...SW.matchAll(/'(\/static\/[^']+)'/g)].map((m) => m[1]!)
  assert.ok(listed.length >= 6)
  for (const p of new Set(listed)) {
    const file = new URL(`../../public/${p.replace('/static/', '')}`, import.meta.url)
    assert.doesNotThrow(() => readFileSync(file), `${p} is precached but not in public/`)
  }
})

test('a versioned asset is served from cache and replaces its older version', () => {
  assert.match(SW, /searchParams\.has\('v'\)/)
  assert.match(SW, /u\.search !== url\.search/)
})
