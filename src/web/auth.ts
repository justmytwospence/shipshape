import { getConnInfo } from '@hono/node-server/conninfo'
import type { MiddlewareHandler } from 'hono'
import { isIP } from 'node:net'

/** Node's dual-stack listener can represent an IPv4 peer as IPv4-mapped IPv6. */
function socketAddress(address: string | undefined): string | undefined {
  if (address?.startsWith('::ffff:') && isIP(address.slice(7)) === 4) {
    return address.slice(7)
  }
  return address
}

/** Accept one canonical serialized HTTP(S) origin, not a URL with a path or a pattern. */
function browserOrigin(value?: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if ((url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value && !/[*${}]/.test(url.hostname)) {
      return value
    }
  } catch {
    // Invalid or missing configuration must never disable the unsafe-request guard.
  }
  return undefined
}

/**
 * Only the configured socket peer may assert the configured Authelia identity.
 * That identity does not prevent CSRF: unsafe requests independently need browser Origin.
 * Configuration is captured when the app is created, never taken from request bindings
 * or headers. There is no dev/test bypass or injectable identity resolver: tests supply
 * Node transport bindings to Hono's in-process request API instead.
 */
export function trustedProxyAuth(): MiddlewareHandler {
  const trustedProxy = socketAddress(process.env.SHIPSHAPE_TRUSTED_PROXY)
  const allowedUser = process.env.SHIPSHAPE_ALLOWED_USER
  const configured = !!trustedProxy && isIP(trustedProxy) !== 0 && !!allowedUser?.trim()
  const allowedOrigin = browserOrigin(process.env.SHIPSHAPE_ALLOWED_ORIGIN)

  return async (c, next) => {
    const websocket = c.req.header('Upgrade')?.split(',').some((token) => token.trim().toLowerCase() === 'websocket') ?? false
    // Check the raw method: Hono also dispatches HEAD through GET handlers.
    const needsOrigin = websocket || !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)
    if (c.req.method === 'GET' && c.req.path === '/health' && !websocket) return next()

    if (!configured) {
      c.header('Cache-Control', 'no-store')
      return c.text('Authentication unavailable', 503)
    }
    if (needsOrigin && !allowedOrigin) {
      c.header('Cache-Control', 'no-store')
      return c.text('CSRF protection unavailable', 503)
    }

    let peer: string | undefined
    try {
      peer = getConnInfo(c).remote.address
    } catch {
      // Missing transport information fails closed, with no forwarded-header fallback.
    }
    if (socketAddress(peer) !== trustedProxy || c.req.header('Remote-User') !== allowedUser) {
      c.header('Cache-Control', 'no-store')
      return c.text('Forbidden', 403)
    }

    // Never derive Origin authority from Host, request URL, Referer or forwarded headers.
    // Unlike Hono's built-in csrf(), this applies to every content type and does not
    // accept Sec-Fetch-Site (or HX-Request) as a substitute for an exact Origin match.
    if (needsOrigin && c.req.header('Origin') !== allowedOrigin) {
      c.header('Cache-Control', 'no-store')
      return c.text('Forbidden', 403)
    }

    return next()
  }
}
