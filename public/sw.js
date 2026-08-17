/**
 * shipshape's service worker.
 *
 * Its whole design is one decision: **navigations are never intercepted.** Not
 * "intercepted and handled carefully" -- the fetch handler returns without calling
 * respondWith, so the browser handles them exactly as it would with no worker installed.
 *
 * That matters here specifically. This app sits behind Authelia forward-auth, which
 * answers an unauthenticated request with a 302 to another origin rather than a 401,
 * and sessions lapse after 30 minutes idle. A worker that cached HTML would eventually
 * serve a stale dashboard whose every request bounced to a login page -- which is not
 * hypothetical: this homelab has already had exactly that failure with another PWA, and
 * the fix there was to move the app off forward-auth entirely. Not intercepting removes
 * the failure class by construction rather than mitigating it.
 *
 * So the worker does one job: keep the static assets local. That is worth having on its
 * own -- the stylesheet is half a megabyte -- and it is the part with no auth semantics
 * attached.
 */

const VERSION = 'shipshape-static-v2'

/**
 * Precached on install. Deliberately short and hand-checked against what is actually in
 * public/: a missing entry does not 404 cleanly here, because Traefik's error-pages
 * middleware intercepts 402-599 and substitutes a ~57 KB HTML page.
 */
const PRECACHE = [
  '/static/app.css',
  '/static/app.js',
  '/static/htmx.min.js',
  '/static/icon.svg',
  '/static/icon-192.png',
  '/static/icon-512.png',
  '/static/apple-touch-icon.png',
]

/**
 * Is this response safe to store?
 *
 * `redirected` and `opaqueredirect` are the Authelia guard: if the session lapsed while
 * the worker was installing, every one of those fetches is a redirect to the login page,
 * and caching one would pin the login page under the URL of our stylesheet.
 */
const usable = (r) =>
  r && r.ok && r.status === 200 && !r.redirected && r.type !== 'opaqueredirect'

self.addEventListener('install', (e) =>
  e.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION)
      // allSettled, and never throw: one unreachable asset must not abort activation.
      // A cache miss simply falls through to the network, which is the correct outcome.
      await Promise.allSettled(
        PRECACHE.map(async (url) => {
          const res = await fetch(new Request(url, { credentials: 'same-origin', cache: 'reload' }))
          if (usable(res)) await cache.put(url, res)
        }),
      )
      await self.skipWaiting()
    })(),
  ),
)

self.addEventListener('activate', (e) =>
  e.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== VERSION) await caches.delete(key)
      }
      await self.clients.claim()
    })(),
  ),
)

self.addEventListener('fetch', (e) => {
  const req = e.request

  if (req.method !== 'GET') return
  // The one that matters. Authelia's 302 is the browser's business, not ours.
  if (req.mode === 'navigate') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  // Every htmx fragment, every API route, falls through to the network untouched.
  if (!url.pathname.startsWith('/static/')) return

  /*
   * Stale-while-revalidate rather than cache-first.
   *
   * The app sets no Cache-Control or ETag on static files and there is no asset
   * hashing, so cache-first would mean bumping VERSION by hand on every CSS edit or
   * inventing `?v=` query strings that then have to be mirrored in PRECACHE. This way a
   * changed stylesheet lands on the second load with no bookkeeping at all, which is
   * the right trade for a single-operator homelab.
   */
  e.respondWith(
    (async () => {
      const cache = await caches.open(VERSION)
      const hit = await cache.match(req)
      const net = fetch(req)
        .then((res) => {
          if (usable(res)) cache.put(req, res.clone())
          return res
        })
        .catch(() => null)
      return hit || (await net) || Response.error()
    })(),
  )
})
