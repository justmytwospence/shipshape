import { getDb, logEvent } from '../db.ts'

/**
 * Shared HTTP plumbing for registry access: bearer-token caching, ETag revalidation,
 * polite pacing, and the Docker Hub pull-budget ledger.
 *
 * The budget matters more than it looks. Docker Hub counts a GET on
 * `registry-1.docker.io/v2/*​/manifests/*` as a *pull* -- 100 per 6h anonymous, 200
 * authenticated, per IP. A probe of this host found it already at 82/100 remaining
 * before shipshape existed. So: tag listing goes through the vendor API (not billed),
 * existence checks use HEAD (not billed), and manifest/config GETs are billed, cached
 * by digest forever, and refused below a reserve floor.
 */

const USER_AGENT = 'shipshape/0.1 (+https://github.com/justmytwospence/shipshape)'

/** Never spend the last slice of the Hub budget: a `docker compose pull` during a
 *  deploy needs headroom, and being locked out mid-deploy is far worse than a delayed
 *  changelog. */
const HUB_RESERVE = 40

interface TokenEntry {
  token: string
  expiresAt: number
}

const tokenCache = new Map<string, TokenEntry>()
const lastRequestAt = new Map<string, number>()

/** Minimum spacing between requests to the same host. Cheap insurance against tripping
 *  a rate limiter during a 144-image scan. */
let minSpacingMs = 120

/** Tests exercise request sequences, not politeness, so they turn the spacing off. */
export function setMinSpacingForTests(ms: number): void {
  minSpacingMs = ms
}

/** Per-request ceiling. Generous enough for a slow registry, short enough that a dead
 *  connection cannot hold the nightly scan open forever. */
const REQUEST_TIMEOUT_MS = 30_000

export async function pace(host: string): Promise<void> {
  const last = lastRequestAt.get(host) ?? 0
  const wait = last + minSpacingMs - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastRequestAt.set(host, Date.now())
}

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'RegistryError'
  }
}

/** Budget exhaustion is not an error in the normal sense -- it is a "come back later",
 *  and callers degrade rather than fail. */
export class BudgetExhausted extends RegistryError {}

export interface FetchOpts {
  method?: 'GET' | 'HEAD'
  accept?: string
  /** Basic-auth credentials offered to the token endpoint (Docker Hub, private ghcr). */
  auth?: { username: string; password: string } | null
  /** Charge this request against the Docker Hub pull budget. */
  billed?: boolean
  /** Cache the response body by this key and revalidate with ETag. */
  cacheKey?: string
}

/**
 * Perform a registry request, transparently handling the bearer-token challenge.
 *
 * The token realm is always taken from the `WWW-Authenticate` header rather than
 * hardcoded per registry. That is what makes lscr.io work: it is a redirector whose
 * challenge points at ghcr.io's realm, and hitting `https://lscr.io/token` directly
 * 404s. Following the header also means gcr.io, quay.io, registry.gitlab.com and
 * codeberg.org work with no per-registry code.
 */
export async function registryFetch(url: string, opts: FetchOpts = {}): Promise<Response> {
  const host = new URL(url).host
  const method = opts.method ?? 'GET'

  if (opts.billed) chargeHubBudget(host)

  const headers: Record<string, string> = { 'user-agent': USER_AGENT }
  if (opts.accept) headers.accept = opts.accept

  const cached = opts.cacheKey ? readCache(opts.cacheKey) : null
  if (cached?.etag) headers['if-none-match'] = cached.etag

  const scopeKey = scopeFor(url)
  const tok = tokenCache.get(scopeKey)
  if (tok && tok.expiresAt > Date.now()) headers.authorization = `Bearer ${tok.token}`

  await pace(host)
  // A hung connection must cost one image 30s, not stall the entire serial scan.
  let res = await fetch(url, { method, headers, redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })

  if (res.status === 401) {
    const challenge = res.headers.get('www-authenticate')
    const token = challenge ? await acquireToken(challenge, opts.auth ?? null) : null
    if (token) {
      tokenCache.set(scopeKey, token)
      headers.authorization = `Bearer ${token.token}`
      await pace(host)
      res = await fetch(url, { method, headers, redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    }
  }

  recordHubHeaders(host, res)

  if (res.status === 429) {
    const retry = res.headers.get('retry-after')
    throw new RegistryError(
      `rate limited by ${host}${retry ? ` (retry after ${retry}s)` : ''}`,
      429,
    )
  }
  return res
}

function scopeFor(url: string): string {
  const u = new URL(url)
  // Tokens are per repository scope, not per host.
  const m = /^\/v2\/(.+?)\/(?:manifests|blobs|tags)\//.exec(u.pathname)
  return `${u.host}|${m?.[1] ?? ''}`
}

async function acquireToken(
  challenge: string,
  auth: { username: string; password: string } | null,
): Promise<TokenEntry | null> {
  const params: Record<string, string> = {}
  for (const m of challenge.matchAll(/(\w+)="([^"]*)"/g)) params[m[1]!] = m[2]!
  const realm = params.realm
  if (!realm) return null

  const u = new URL(realm)
  if (params.service) u.searchParams.set('service', params.service)
  if (params.scope) u.searchParams.set('scope', params.scope)

  const headers: Record<string, string> = { 'user-agent': USER_AGENT }
  if (auth) {
    headers.authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`
  }

  await pace(u.host)
  const res = await fetch(u, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!res.ok) return null
  const body = (await res.json()) as { token?: string; access_token?: string; expires_in?: number }
  const token = body.token ?? body.access_token
  if (!token) return null
  // ghcr returns no expires_in; assume a short life and re-fetch rather than risk a
  // stale token mid-scan.
  const ttl = (body.expires_in ?? 55) * 1000
  return { token, expiresAt: Date.now() + ttl }
}

// ---------------------------------------------------------------- budget ledger

function hubBudgetKey(): string {
  return 'dockerhub.pulls'
}

/** Remaining Hub pull allowance as last reported by the registry, or null if unknown. */
export function hubRemaining(): number | null {
  const row = getDb()
    .prepare(`SELECT value FROM budgets WHERE key = ?`)
    .get(hubBudgetKey()) as { value: number } | undefined
  return row ? row.value : null
}

function chargeHubBudget(host: string): void {
  if (!host.endsWith('docker.io')) return
  const remaining = hubRemaining()
  if (remaining !== null && remaining <= HUB_RESERVE) {
    throw new BudgetExhausted(
      `Docker Hub pull budget at ${remaining}, reserve floor is ${HUB_RESERVE}`,
      429,
    )
  }
}

/** Read the authoritative remaining count straight off the response headers rather than
 *  counting locally -- the registry's view is the one that matters, and other things on
 *  this host (deploys, manual pulls) spend from the same bucket. */
function recordHubHeaders(host: string, res: Response): void {
  if (!host.endsWith('docker.io')) return
  const raw = res.headers.get('ratelimit-remaining')
  if (!raw) return
  const remaining = Number(raw.split(';')[0])
  if (!Number.isFinite(remaining)) return
  const window = res.headers.get('ratelimit-limit') ?? null
  getDb()
    .prepare(
      `INSERT INTO budgets (key, value, window, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, window = excluded.window,
                                      updated_at = excluded.updated_at`,
    )
    .run(hubBudgetKey(), remaining, window, new Date().toISOString())
  if (remaining <= HUB_RESERVE) {
    logEvent({
      level: 'warn',
      kind: 'scan',
      message: 'Docker Hub pull budget near exhaustion',
      detail: `${remaining} remaining (reserve floor ${HUB_RESERVE})`,
    })
  }
}

// ---------------------------------------------------------------- response cache

export interface CacheRow {
  etag: string | null
  body: string
}

export function readCache(key: string): CacheRow | null {
  const row = getDb()
    .prepare(`SELECT etag, body FROM http_cache WHERE url = ?`)
    .get(key) as CacheRow | undefined
  return row ?? null
}

export function writeCache(key: string, etag: string | null, body: string): void {
  getDb()
    .prepare(
      `INSERT INTO http_cache (url, etag, body, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET etag = excluded.etag, body = excluded.body,
                                      fetched_at = excluded.fetched_at`,
    )
    .run(key, etag, body, new Date().toISOString())
}

export function readCachedBody(key: string): string | null {
  return readCache(key)?.body ?? null
}

/** GET returning JSON, using the cache on a 304. */
export async function fetchJson<T>(url: string, opts: FetchOpts = {}): Promise<T> {
  const res = await registryFetch(url, opts)
  if (res.status === 304 && opts.cacheKey) {
    const body = readCachedBody(opts.cacheKey)
    if (body) return JSON.parse(body) as T
  }
  if (!res.ok) throw new RegistryError(`${res.status} from ${url}`, res.status)
  const text = await res.text()
  if (opts.cacheKey) writeCache(opts.cacheKey, res.headers.get('etag'), text)
  return JSON.parse(text) as T
}
