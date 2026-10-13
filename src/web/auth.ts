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

/**
 * Only the configured socket peer may assert the configured Authelia identity.
 * Configuration is captured when the app is created, never taken from request bindings
 * or headers. There is no dev/test bypass or injectable identity resolver: tests supply
 * Node transport bindings to Hono's in-process request API instead.
 */
export function trustedProxyAuth(): MiddlewareHandler {
  const trustedProxy = socketAddress(process.env.SHIPSHAPE_TRUSTED_PROXY)
  const allowedUser = process.env.SHIPSHAPE_ALLOWED_USER
  const configured = !!trustedProxy && isIP(trustedProxy) !== 0 && !!allowedUser?.trim()

  return async (c, next) => {
    // Check the raw method: Hono also dispatches HEAD through GET handlers.
    if (c.req.method === 'GET' && c.req.path === '/health') return next()

    if (!configured) {
      c.header('Cache-Control', 'no-store')
      return c.text('Authentication unavailable', 503)
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

    return next()
  }
}
