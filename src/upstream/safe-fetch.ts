import { promises as dns } from 'node:dns'
import { isIP } from 'node:net'
import { getDb } from '../db.ts'
import { readCache, writeCache, type CacheRow } from '../registry/http.ts'
import { htmlToText } from '../notes/html.ts'
import { checkUrl, isPrivateAddress } from './hosts.ts'

/**
 * Fetching a link an operator typed, and nothing it could be turned into.
 *
 * The name is resolved and every address checked before connecting, redirects are followed
 * by hand and checked again at each hop, and the whole exchange is bounded: 20 seconds, 2 MB,
 * text only. A page that changed nothing is not fetched again for six hours, and when it is,
 * its ETag makes that free. There is a gap between the check and the connection that a
 * rebinding DNS server could use; a changelog link is an operator's own configuration, and
 * this is a guard against a mistyped or pasted address, not against the operator.
 */

export const MAX_BYTES = 2 * 1024 * 1024
const TIMEOUT_MS = 20_000
const MAX_REDIRECTS = 3
const REFETCH_MS = 6 * 60 * 60_000

export type SafeFetch =
  | { ok: true; text: string; contentType: string; bytes: number; url: string; fromCache: boolean }
  | { ok: false; reason: string; transient: boolean }

interface Stored {
  text: string
  contentType: string
  url: string
}

export async function safeFetch(link: string): Promise<SafeFetch> {
  const key = `external:${link}`
  const cached = readCache(key)
  const stored = parseStored(cached)
  if (stored && Date.now() - Date.parse(fetchedAt(key) ?? '') < REFETCH_MS) return fromStore(stored, true)

  const deadline = AbortSignal.timeout(TIMEOUT_MS)
  let current = link
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const checked = checkUrl(current)
    if (!checked.ok) {
      return { ok: false, reason: hop === 0 ? checked.reason : `it redirects to ${current}, and ${checked.reason}`, transient: false }
    }
    const host = checked.url.hostname
    const safe = await publicAddress(host)
    if (!safe.ok) return safe

    let res: Response
    try {
      res = await fetch(checked.url, {
        redirect: 'manual',
        signal: deadline,
        headers: {
          'user-agent': 'shipshape/0.1',
          accept: 'text/markdown, text/plain;q=0.9, text/html;q=0.8',
          ...(hop === 0 && cached?.etag ? { 'if-none-match': cached.etag } : {}),
        },
      })
    } catch (err) {
      return staleOr(stored, { ok: false, reason: `${host} could not be reached (${(err as Error).message})`, transient: true })
    }

    if (res.status === 304 && stored && cached) {
      writeCache(key, cached.etag, cached.body)
      return fromStore(stored, true)
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) return { ok: false, reason: `${host} answered ${res.status} with nowhere to go`, transient: false }
      current = new URL(location, checked.url).toString()
      continue
    }
    if (!res.ok) {
      const transient = res.status === 429 || res.status >= 500
      const failure = { ok: false as const, reason: `${host} answered ${res.status}`, transient }
      return transient ? staleOr(stored, failure) : failure
    }

    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    const kind = textKind(type, checked.url.pathname)
    if (!kind) {
      return { ok: false, reason: `${host} sent ${type || 'something with no content type'}, which is not text to read`, transient: false }
    }
    const body = await readCapped(res)
    if (!body.ok) return body
    const text = kind === 'html' ? htmlToText(body.text) : body.text
    writeCache(key, res.headers.get('etag'), JSON.stringify({ text, contentType: type, url: current } satisfies Stored))
    return { ok: true, text, contentType: type, bytes: body.bytes, url: current, fromCache: false }
  }
  return { ok: false, reason: `it redirects more than ${MAX_REDIRECTS} times`, transient: false }
}

/** Every address a name resolves to must be public. */
async function publicAddress(host: string): Promise<{ ok: true } | { ok: false; reason: string; transient: boolean }> {
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

function textKind(type: string, path: string): 'html' | 'text' | null {
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html'
  if (/^text\/(plain|markdown|x-markdown|x-rst|restructuredtext|x-web-markdown)$/.test(type)) return 'text'
  // Plenty of servers send a changelog file as a download.
  if ((type === '' || type === 'application/octet-stream') && /\.(md|markdown|rst|txt|adoc)$/i.test(path)) return 'text'
  return null
}

async function readCapped(
  res: Response,
): Promise<{ ok: true; text: string; bytes: number } | { ok: false; reason: string; transient: false }> {
  const tooBig = { ok: false as const, reason: `it is larger than ${MAX_BYTES / 1024 / 1024} MB`, transient: false as const }
  if (Number(res.headers.get('content-length')) > MAX_BYTES) return tooBig
  if (!res.body) return { ok: true, text: '', bytes: 0 }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > MAX_BYTES) {
      await reader.cancel()
      return tooBig
    }
    chunks.push(value)
  }
  return { ok: true, text: new TextDecoder().decode(Buffer.concat(chunks)), bytes }
}

function parseStored(row: CacheRow | null): Stored | null {
  if (!row) return null
  try {
    return JSON.parse(row.body) as Stored
  } catch {
    return null
  }
}

function fetchedAt(key: string): string | null {
  const row = getDb().prepare(`SELECT fetched_at FROM http_cache WHERE url = ?`).get(key) as { fetched_at: string } | undefined
  return row?.fetched_at ?? null
}

function fromStore(s: Stored, fromCache: boolean): SafeFetch {
  return { ok: true, text: s.text, contentType: s.contentType, bytes: Buffer.byteLength(s.text), url: s.url, fromCache }
}

/** Yesterday's copy beats nothing when the site is down or limiting. */
function staleOr(stored: Stored | null, failure: SafeFetch): SafeFetch {
  return stored ? fromStore(stored, true) : failure
}
