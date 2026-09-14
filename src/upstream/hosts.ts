import { isIP } from 'node:net'

/**
 * Which links shipshape may fetch on an operator's word.
 *
 * `shipshape.changelog` is typed into a browser and fetched by a container that sits on the
 * lab's networks, next to services that answer without authentication. A link to
 * `http://10.0.0.1:8080/admin` must not become a request from inside. So only https on the
 * standard port, to a public name, with no credentials in it; the name's addresses are
 * checked again when it is fetched, and at every redirect.
 */

export function checkUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { ok: false, reason: 'it is not a link' }
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'only https:// links are fetched' }
  if (u.username || u.password) return { ok: false, reason: 'it carries credentials' }
  if (u.port && u.port !== '443') return { ok: false, reason: 'only the standard https port is fetched' }
  const refused = refusedHost(u.hostname)
  return refused ? { ok: false, reason: refused } : { ok: true, url: u }
}

/** Why a host may not be fetched from, or null. */
export function refusedHost(host: string): string | null {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (!h) return 'it has no host'
  if (isIP(h)) return isPrivateAddress(h) ? `${h} is a private, loopback or link-local address` : null
  if (h === 'localhost' || /\.(local|lan|internal|localhost|localdomain|home\.arpa)$/.test(h)) {
    return `"${h}" is a local network name`
  }
  if (!h.includes('.')) return `"${h}" is not a public host name`
  return null
}

/** Loopback, private, link-local, carrier-grade NAT, multicast and unspecified addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    )
  }
  const v6 = ip.toLowerCase()
  if (v6 === '::' || v6 === '::1') return true
  if (v6.startsWith('::ffff:')) {
    const tail = v6.slice('::ffff:'.length)
    // A mapped address written in hex cannot be told apart cheaply, so it is refused.
    return isIP(tail) === 4 ? isPrivateAddress(tail) : true
  }
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6)
}
