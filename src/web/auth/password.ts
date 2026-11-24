import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { Context } from 'hono'
import { browserOrigin } from './proxy.ts'

/**
 * Password mode: shipshape signs its one user in itself.
 *
 * The password is derived with scrypt once at start, with a random salt, and attempts are
 * compared in constant time; the plaintext is not kept. Failed attempts are limited per
 * socket address and in total.
 */

const MIN_PASSWORD_LENGTH = 12
const MAX_PASSWORD_LENGTH = 1024
const LIMIT_PER_ADDRESS = 5
const LIMIT_GLOBAL = 30
export const LIMIT_WINDOW_MS = 15 * 60_000

export class LoginLimiter {
  private readonly byAddress = new Map<string, number[]>()
  private global: number[] = []
  constructor(private readonly now: () => number = Date.now) {}

  private trim(list: number[]): number[] {
    const cut = this.now() - LIMIT_WINDOW_MS
    return list.filter((t) => t > cut)
  }

  /** Seconds until a retry is allowed, or 0 when the attempt may proceed. */
  blockedFor(address: string): number {
    const key = address || 'unknown'
    const mine = this.trim(this.byAddress.get(key) ?? [])
    if (mine.length) this.byAddress.set(key, mine)
    else this.byAddress.delete(key)
    this.global = this.trim(this.global)
    const wait = (list: number[]) => Math.ceil((list[0]! + LIMIT_WINDOW_MS - this.now()) / 1000)
    let out = 0
    if (mine.length >= LIMIT_PER_ADDRESS) out = Math.max(out, wait(mine))
    if (this.global.length >= LIMIT_GLOBAL) out = Math.max(out, wait(this.global))
    return Math.max(0, out)
  }

  fail(address: string): void {
    const key = address || 'unknown'
    const now = this.now()
    const list = this.trim(this.byAddress.get(key) ?? [])
    list.push(now)
    this.byAddress.delete(key)
    this.byAddress.set(key, list)
    if (this.byAddress.size > 10_000) this.byAddress.delete(this.byAddress.keys().next().value!)
    this.global = this.trim(this.global)
    this.global.push(now)
  }

  /** Clears that address only. */
  succeed(address: string): void {
    this.byAddress.delete(address || 'unknown')
  }
}

export interface PasswordConfig {
  verify(attempt: string): boolean
  fingerprint: string
  /** SHIPSHAPE_ALLOWED_ORIGIN is https: the session cookie is Secure. */
  secureCookie: boolean
  origin: string | undefined
  limiter: LoginLimiter
}
export type PasswordParse = { ok: true; config: PasswordConfig } | { ok: false; problems: string[] }

/**
 * The key the session fingerprint is made with: 32 random bytes in DATA_DIR/session-key,
 * created on first use. Keyed, so a copy of the database alone is no help in guessing the
 * password; per install, so two installs with one password do not share fingerprints.
 */
function fingerprintKey(dataDir: string): { ok: true; key: Buffer } | { ok: false; problem: string } {
  const file = join(dataDir, 'session-key')
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    try {
      writeFileSync(file, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' })
    } catch (err) {
      if ((err as { code?: string }).code !== 'EEXIST') throw err
    }
    const hex = readFileSync(file, 'utf8').trim()
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      return {
        ok: false,
        problem: `${file} is not a key shipshape wrote. Delete it and restart: everyone is signed out once.`,
      }
    }
    return { ok: true, key: Buffer.from(hex, 'hex') }
  } catch (err) {
    return {
      ok: false,
      problem: `cannot create ${file} (${(err as { code?: string }).code ?? 'error'}): DATA_DIR must be writable.`,
    }
  }
}

export function parsePasswordConfig(env: NodeJS.ProcessEnv): PasswordParse {
  const problems: string[] = []
  let password: string | null = null
  if (env.SHIPSHAPE_PASSWORD && env.SHIPSHAPE_PASSWORD_FILE) {
    problems.push('SHIPSHAPE_PASSWORD and SHIPSHAPE_PASSWORD_FILE are both set. Use one.')
  } else if (env.SHIPSHAPE_PASSWORD_FILE) {
    try {
      password = readFileSync(env.SHIPSHAPE_PASSWORD_FILE, 'utf8').replace(/\r?\n$/, '')
    } catch (err) {
      problems.push(
        `SHIPSHAPE_PASSWORD_FILE: cannot read "${env.SHIPSHAPE_PASSWORD_FILE}" (${(err as { code?: string }).code ?? 'error'}).`,
      )
    }
  } else {
    password = env.SHIPSHAPE_PASSWORD ?? ''
  }
  if (password !== null && password.length < MIN_PASSWORD_LENGTH) {
    problems.push(`The password must be at least ${MIN_PASSWORD_LENGTH} characters (it is ${password.length}).`)
  }
  if (password !== null && password.length > MAX_PASSWORD_LENGTH) {
    problems.push(`The password must be at most ${MAX_PASSWORD_LENGTH} characters (it is ${password.length}).`)
  }
  const rawOrigin = env.SHIPSHAPE_ALLOWED_ORIGIN
  const origin = browserOrigin(rawOrigin)
  if (rawOrigin && !origin) {
    problems.push(
      'SHIPSHAPE_ALLOWED_ORIGIN must be one origin such as https://shipshape.example.com: scheme, host and optional port, with no path or trailing slash.',
    )
  }
  const keyed = problems.length === 0 && password !== null ? fingerprintKey(env.DATA_DIR || '/data') : null
  if (keyed && !keyed.ok) problems.push(keyed.problem)
  if (problems.length > 0 || password === null || !keyed || !keyed.ok) return { ok: false, problems }

  const salt = randomBytes(16)
  const key = scryptSync(password, salt, 64)
  const fingerprint = createHmac('sha256', keyed.key).update(password).digest('hex').slice(0, 32)
  return {
    ok: true,
    config: {
      verify: (attempt) => attempt.length <= MAX_PASSWORD_LENGTH && timingSafeEqual(key, scryptSync(attempt, salt, 64)),
      fingerprint,
      secureCookie: !!origin?.startsWith('https://'),
      origin,
      limiter: new LoginLimiter(),
    },
  }
}

const forbidden = () =>
  new Response('Forbidden', {
    status: 403,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=UTF-8' },
  })

/**
 * The Origin check for a request that changes something.
 *
 * Host-derived checking is sound here and unsound in proxy mode. The session cookie is
 * host-scoped: a DNS-rebinding page (evil.example resolving to our address) sends Host and
 * Origin for evil.example, but the browser never attaches our cookie to that name, so the
 * request has no session and is refused before it can do anything. A forward-auth proxy,
 * by contrast, injects the identity header on every request whatever the Host, so there an
 * attacker-controlled Host/Origin pair would be accepted -- which is why proxy mode
 * compares against a configured origin only.
 */
export function checkPasswordOrigin(c: Context, cfg: PasswordConfig): Response | null {
  const v = c.req.header('Origin')
  if (!v) return forbidden()
  let u: URL
  try {
    u = new URL(v)
  } catch {
    return forbidden()
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.origin !== v) return forbidden()
  if (cfg.origin) return v === cfg.origin ? null : forbidden()
  return u.host === c.req.header('Host') ? null : forbidden()
}

/** A same-origin path (and query) to return to after sign-in, else '/'. */
export function safeNext(value: unknown): string {
  if (typeof value !== 'string' || !value) return '/'
  if (value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/'
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(value)) return '/'
  let u: URL
  try {
    u = new URL(value, 'http://x')
  } catch {
    return '/'
  }
  if (u.origin !== 'http://x') return '/'
  const p = u.pathname + u.search
  if (p === '/login' || p.startsWith('/login?') || p === '/logout') return '/'
  return p
}
