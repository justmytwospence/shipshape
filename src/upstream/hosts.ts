import { promises as dns } from 'node:dns'
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
  const g = ipv6Groups(ip)
  if (!g) return true
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0)
  if (zero(0, 8) || (zero(0, 7) && g[7] === 1)) return true // :: and ::1
  if (zero(0, 5) && g[5] === 0xffff) return isPrivateAddress(v4(g[6]!, g[7]!)) // IPv4-mapped
  if (zero(0, 6)) return true // IPv4-compatible ::a.b.c.d, deprecated
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return isPrivateAddress(v4(g[6]!, g[7]!)) // NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true // local-use NAT64
  if (g[0] === 0x2002) return isPrivateAddress(v4(g[1]!, g[2]!)) // 6to4
  if (g[0] === 0x100 && zero(1, 4)) return true // discard-only
  if ((g[0]! & 0xfe00) === 0xfc00) return true // unique local
  if ((g[0]! & 0xffc0) === 0xfe80) return true // link-local
  if ((g[0]! & 0xffc0) === 0xfec0) return true // site-local
  if ((g[0]! & 0xff00) === 0xff00) return true // multicast
  return false
}

const v4 = (a: number, b: number) => `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`

/** The eight 16-bit groups of an IPv6 address, or null when it is malformed. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .split('%')[0]!
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (tail) {
    if (isIP(tail[1]!) !== 4) return null
    const [a, b, c, d] = tail[1]!.split('.').map(Number) as [number, number, number, number]
    s = s.slice(0, -tail[1]!.length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const part = (x: string) => (x === '' ? [] : x.split(':'))
  const head = part(halves[0]!)
  const rest = halves.length === 2 ? part(halves[1]!) : []
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0
  if (fill < (halves.length === 2 ? 1 : 0) || (halves.length === 1 && head.length !== 8)) return null
  const groups = [...head, ...Array(fill).fill('0'), ...rest]
  if (groups.length !== 8 || groups.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null
  return groups.map((x) => parseInt(x, 16))
}

/** Every address a name resolves to must be public. */
export async function publicAddress(
  host: string,
): Promise<{ ok: true } | { ok: false; reason: string; transient: boolean }> {
  if (isIP(host.replace(/^\[|\]$/g, ''))) return { ok: true }
  let addresses: { address: string }[]
  try {
    addresses = await dns.lookup(host, { all: true })
  } catch (err) {
    const code = (err as { code?: string }).code
    return code === 'ENOTFOUND'
      ? { ok: false, reason: `"${host}" does not resolve`, transient: false }
      : { ok: false, reason: `"${host}" could not be resolved (${code ?? (err as Error).message})`, transient: true }
  }
  const bad = addresses.find((a) => isPrivateAddress(a.address))
  return bad
    ? { ok: false, reason: `"${host}" resolves to ${bad.address}, a private address`, transient: false }
    : { ok: true }
}
