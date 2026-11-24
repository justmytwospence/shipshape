import type { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Read once: the file cannot change without the container restarting. */
let swCache: string | null = null

function swSource(): string {
  if (swCache === null) {
    try {
      swCache = readFileSync(join('./public', 'sw.js'), 'utf8')
    } catch {
      // Serving an empty worker is safe -- no fetch handler means no interception.
      swCache = ''
    }
  }
  return swCache
}

/**
 * The service worker, at the root.
 *
 * Scope is the reason: a worker served from /static/ can only control /static/, which
 * is useless -- it could not see the pages it exists to leave alone. Served here it
 * controls the whole origin. `Service-Worker-Allowed` is belt and braces for the same
 * thing, and `no-cache` means a corrected worker actually reaches the browser.
 */
export function registerServiceWorker(app: Hono): void {
  app.get('/sw.js', (c) => {
    c.header('Content-Type', 'application/javascript; charset=utf-8')
    c.header('Cache-Control', 'no-cache')
    c.header('Service-Worker-Allowed', '/')
    return c.body(swSource())
  })
}
