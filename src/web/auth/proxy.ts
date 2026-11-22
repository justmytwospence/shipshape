import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context } from 'hono'
import { BlockList, isIP } from 'node:net'

/**
 * Proxy mode: a reverse proxy signs people in and forwards who they are in a header.
 *
 * Only a request whose socket peer is one of the configured proxy addresses may name a
 * user, the header must name one of the configured users exactly, and `X-Forwarded-For`
 * is never an identity source. A wide CIDR lets every container in that range assert any
 * identity; list the proxy's address, not its whole network, unless the network contains
 * nothing else.
 */

export interface ProxyConfig {
  /** Trusted socket addresses. */
  peers: BlockList
  /** Exact usernames, case-sensitive. */
  users: ReadonlySet<string>
  /** The header that carries the username; default `Remote-User`. */
  header: string
  /** The validated SHIPSHAPE_ALLOWED_ORIGIN, if any. */
  origin: string | undefined
}
export type ProxyParse = { ok: true; config: ProxyConfig } | { ok: false; problems: string[] }

/** Node's dual-stack listener can represent an IPv4 peer as IPv4-mapped IPv6. */
export function socketAddress(address: string | undefined): string | undefined {
  if (address?.startsWith('::ffff:') && isIP(address.slice(7)) === 4) {
    return address.slice(7)
  }
  return address
}

/** Accept one canonical serialized HTTP(S) origin, not a URL with a path or a pattern. */
export function browserOrigin(value?: string): string | undefined {
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

/** The Node socket peer, normalised; undefined when the transport gives none. */
export function peerAddress(c: Context): string | undefined {
  try {
    return socketAddress(getConnInfo(c).remote.address)
  } catch {
    // Missing transport information fails closed, with no forwarded-header fallback.
    return undefined
  }
}

const family = (ip: string) => (isIP(ip) === 6 ? 'ipv6' : 'ipv4')

export function parseProxyConfig(env: NodeJS.ProcessEnv): ProxyParse {
  const problems: string[] = []
  const peers = new BlockList()
  const entries = (env.SHIPSHAPE_TRUSTED_PROXY ?? '').split(',').map((e) => e.trim())
  for (const entry of entries) {
    const bad = () =>
      problems.push(`SHIPSHAPE_TRUSTED_PROXY: "${entry}" is not an IP address or a CIDR such as 172.20.0.0/16.`)
    if (!entry) {
      bad()
      continue
    }
    const slash = entry.indexOf('/')
    if (slash === -1) {
      const addr = socketAddress(entry)!
      if (isIP(addr) === 0) bad()
      else peers.addAddress(addr, family(addr))
      continue
    }
    const addr = entry.slice(0, slash)
    const lenText = entry.slice(slash + 1)
    const kind = isIP(addr)
    const len = /^\d+$/.test(lenText) ? Number(lenText) : NaN
    if (kind === 0 || !Number.isInteger(len) || len < 1 || len > (kind === 4 ? 32 : 128)) bad()
    else peers.addSubnet(addr, len, family(addr))
  }
  const users = new Set(
    (env.SHIPSHAPE_ALLOWED_USER ?? '')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean),
  )
  if (users.size === 0) {
    problems.push('SHIPSHAPE_ALLOWED_USER is required with SHIPSHAPE_TRUSTED_PROXY: the username your proxy forwards.')
  }
  const header = env.SHIPSHAPE_USER_HEADER?.trim() || 'Remote-User'
  if (!/^[A-Za-z0-9-]+$/.test(header)) {
    problems.push('SHIPSHAPE_USER_HEADER must be a single HTTP header name such as Remote-User.')
  }
  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, config: { peers, users, header, origin: browserOrigin(env.SHIPSHAPE_ALLOWED_ORIGIN) } }
}

/** null = allowed; otherwise the deny Response (403, no-store, body 'Forbidden'). */
export function checkProxyIdentity(c: Context, cfg: ProxyConfig): Response | null {
  const peer = peerAddress(c)
  // Hono joins duplicate headers with ', ', so a header carrying two names matches no user.
  const user = c.req.header(cfg.header)
  if (!peer || !cfg.peers.check(peer, family(peer)) || !user || !cfg.users.has(user)) {
    return new Response('Forbidden', { status: 403, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=UTF-8' } })
  }
  return null
}
