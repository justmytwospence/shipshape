import { env } from '../config.ts'
import { pace, readCache, writeCache, type CacheRow } from '../registry/http.ts'

/**
 * GitHub, as one client.
 *
 * There were three hand-rolled fetches to api.github.com -- releases and compare in the
 * changelog module, releases again in the probe -- and none could tell a rate limit from a
 * repository that does not exist. Every failure came back as "nothing", which the changelog
 * review then read as "this project publishes no releases", and the probe's fetch had no
 * timeout at all.
 *
 * Failures are classified rather than swallowed, so a caller can say which one happened.
 * With a cache key, a successful body is stored -- trimmed to the fields the caller reads,
 * so the cache does not fill with release bodies nobody asked for -- and revalidated with
 * its ETag, which costs nothing against the authenticated rate limit. The stored copy stands
 * in when GitHub is down or limiting: release notes from yesterday are better than none. It
 * never stands in for a 404 or a refused token, which are answers rather than outages.
 */

export type GhFailure = 'not-found' | 'rate-limited' | 'auth' | 'network' | 'server'

export type GhResult<T> =
  | { ok: true; data: T; fromCache: boolean; stale?: boolean }
  | { ok: false; kind: GhFailure; status?: number; resetAt?: string; detail: string }

export interface GhRequestOpts<T> {
  /** Store the (trimmed) body under this key and revalidate it with ETag. */
  cacheKey?: string
  /** Reduce the parsed body to what the caller uses, before it is cached or returned. */
  trim?: (raw: unknown) => T
  /** Defaults to GITHUB_TOKEN. An empty string sends no authorization at all. */
  token?: string
}

const API = 'https://api.github.com'
const TIMEOUT_MS = 20_000
const USER_AGENT = 'shipshape/0.1'

export async function ghRequest<T>(path: string, opts: GhRequestOpts<T> = {}): Promise<GhResult<T>> {
  const url = path.startsWith('https://') ? path : `${API}${path}`
  const token = opts.token ?? env.githubToken
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': USER_AGENT,
  }
  if (token) headers.authorization = `Bearer ${token}`

  const cached = opts.cacheKey ? readCache(opts.cacheKey) : null
  if (cached?.etag) headers['if-none-match'] = cached.etag

  let res: Response
  try {
    await pace(new URL(url).host)
    res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (err) {
    return staleOr<T>(cached, {
      ok: false,
      kind: 'network',
      detail: `GitHub could not be reached (${(err as Error).message})`,
    })
  }

  if (res.status === 304) {
    const hit = parseCached<T>(cached)
    if (hit !== undefined) return { ok: true, data: hit, fromCache: true }
    return { ok: false, kind: 'server', status: 304, detail: 'GitHub answered 304 with nothing cached' }
  }

  if (res.ok) {
    let raw: unknown
    try {
      raw = await res.json()
    } catch (err) {
      return staleOr<T>(cached, {
        ok: false,
        kind: 'server',
        status: res.status,
        detail: `GitHub sent an unreadable response (${(err as Error).message})`,
      })
    }
    const data = opts.trim ? opts.trim(raw) : (raw as T)
    if (opts.cacheKey) writeCache(opts.cacheKey, res.headers.get('etag'), JSON.stringify(data))
    return { ok: true, data, fromCache: false }
  }

  const { kind, resetAt } = classifyFailure(res.status, res.headers)
  const failure: GhResult<T> = {
    ok: false,
    kind,
    status: res.status,
    resetAt,
    detail: describe(kind, res.status, path, resetAt),
  }
  if (kind === 'not-found' || kind === 'auth') return failure
  return staleOr<T>(cached, failure)
}

/**
 * What an error status means. Exported for the tests.
 *
 * GitHub signals its primary rate limit as 403 with `x-ratelimit-remaining: 0`, and its
 * secondary limit as 403 or 429 with `retry-after`. A 403 with neither is a token that may
 * not see the resource.
 */
export function classifyFailure(
  status: number,
  headers: Headers,
  now = Date.now(),
): { kind: GhFailure; resetAt?: string } {
  const remaining = headers.get('x-ratelimit-remaining')
  const retryAfter = headers.get('retry-after')
  if (status === 429 || (status === 403 && (remaining === '0' || retryAfter !== null))) {
    let resetAt: string | undefined
    if (retryAfter !== null && Number.isFinite(Number(retryAfter))) {
      resetAt = new Date(now + Number(retryAfter) * 1000).toISOString()
    } else {
      const reset = Number(headers.get('x-ratelimit-reset'))
      if (Number.isFinite(reset) && reset > 0) resetAt = new Date(reset * 1000).toISOString()
    }
    return { kind: 'rate-limited', resetAt }
  }
  if (status === 401 || status === 403) return { kind: 'auth' }
  if (status === 404 || status === 410 || status === 422) return { kind: 'not-found' }
  return { kind: 'server' }
}

function describe(kind: GhFailure, status: number, path: string, resetAt?: string): string {
  switch (kind) {
    case 'rate-limited':
      return `GitHub's rate limit was reached${resetAt ? ` (resets ${resetAt})` : ''}`
    case 'auth':
      return `GitHub refused the request (${status}) for ${path}`
    case 'not-found':
      return `GitHub has nothing at ${path} (${status})`
    default:
      return `GitHub answered ${status} for ${path}`
  }
}

function parseCached<T>(row: CacheRow | null): T | undefined {
  if (!row) return undefined
  try {
    return JSON.parse(row.body) as T
  } catch {
    return undefined
  }
}

function staleOr<T>(row: CacheRow | null, failure: GhResult<T>): GhResult<T> {
  const hit = parseCached<T>(row)
  return hit === undefined ? failure : { ok: true, data: hit, fromCache: true, stale: true }
}
