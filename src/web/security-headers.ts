import type { MiddlewareHandler } from 'hono'
import { THEME_SCRIPT_HASH } from './theme-script.ts'

/**
 * What a browser may do on shipshape's pages. No inline script but the hashed theme
 * script, no eval, no inline styles, no framing: markup a release note or a model managed
 * to inject has nothing to run with.
 */
export const CSP = [
  "default-src 'none'",
  `script-src 'self' '${THEME_SCRIPT_HASH}'`,
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

const HEADERS: [string, string][] = [
  ['Content-Security-Policy', CSP],
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY'],
  ['Referrer-Policy', 'no-referrer'],
]

/** Sets the headers on every response, denials and static files included. */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next()
    try {
      for (const [k, v] of HEADERS) c.res.headers.set(k, v)
    } catch (err) {
      if (!(err instanceof TypeError)) throw err
      // Immutable headers (a fetched or static response): copy it once and set them there.
      c.res = new Response(c.res.body, c.res)
      for (const [k, v] of HEADERS) c.res.headers.set(k, v)
    }
  }
}
