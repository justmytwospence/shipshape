import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { LoginPage, SetupPage } from '../views/ui/auth.tsx'
import { checkPasswordOrigin, safeNext, type PasswordConfig } from './password.ts'
import { checkProxyIdentity, peerAddress } from './proxy.ts'
import { createSession, destroySession, lookupSession, maybePrune, SESSION_COOKIE, SESSION_TTL_MS } from './session.ts'
import type { AuthConfig } from './setup.ts'

export { resolveAuth, describeAuth, type AuthConfig } from './setup.ts'

/**
 * Every request is authenticated here before any route sees it. Exempt: exactly
 * `GET /health`, and GET/HEAD of the files in public/ -- the sign-in and setup pages need
 * their stylesheet, and every one of those files is in the public repository.
 */

/** '/static/<file>' for each file in ./public, exactly. An allowlist cannot be widened by a path-normalisation surprise. */
export function staticAllowlist(): ReadonlySet<string> {
  const root = './public'
  try {
    return new Set(
      readdirSync(root)
        .filter((f) => statSync(join(root, f)).isFile())
        .map((f) => `/static/${f}`),
    )
  } catch {
    return new Set()
  }
}

const noStore = (c: Context) => c.header('Cache-Control', 'no-store')

function setSessionCookie(c: Context, token: string, cfg: PasswordConfig): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
    secure: cfg.secureCookie,
  })
}

/** The path and query of HX-Current-URL when it is this host's, for returning after sign-in. */
function currentPath(c: Context): string {
  const raw = c.req.header('HX-Current-URL')
  if (!raw) return '/'
  try {
    const u = new URL(raw)
    return u.host === c.req.header('Host') ? u.pathname + u.search : '/'
  } catch {
    return '/'
  }
}

export function authMiddleware(auth: AuthConfig): MiddlewareHandler {
  const allow = staticAllowlist()
  return async (c, next) => {
    const isUpgrade = c.req.header('Upgrade')?.split(',').some((t) => t.trim().toLowerCase() === 'websocket') ?? false
    // The raw method: Hono also dispatches HEAD through GET handlers.
    const method = c.req.method
    const unsafe = isUpgrade || !['GET', 'HEAD', 'OPTIONS'].includes(method)
    const path = c.req.path

    if (method === 'GET' && path === '/health' && !isUpgrade) return next()
    if ((method === 'GET' || method === 'HEAD') && !isUpgrade && allow.has(path)) return next()

    if (auth.mode === 'unconfigured' || auth.mode === 'error') {
      noStore(c)
      return c.html(SetupPage({ problems: auth.mode === 'error' ? auth.problems : [] }) as string, 503)
    }

    if (auth.mode === 'proxy') {
      const cfg = auth.proxy
      if (unsafe && !cfg.origin) {
        noStore(c)
        return c.text('CSRF protection unavailable', 503)
      }
      const denied = checkProxyIdentity(c, cfg)
      if (denied) return denied
      // Never derive Origin authority from Host, the request URL, Referer or forwarded
      // headers. Unlike Hono's csrf(), this applies to every content type and accepts
      // neither Sec-Fetch-Site nor HX-Request in place of an exact Origin.
      if (unsafe && c.req.header('Origin') !== cfg.origin) {
        noStore(c)
        return c.text('Forbidden', 403)
      }
      return next()
    }

    // Password mode.
    const cfg = auth.password
    const login = (path === '/login' && ['GET', 'HEAD', 'POST'].includes(method)) || (path === '/logout' && method === 'POST')
    if (login) {
      if (unsafe) {
        const bad = checkPasswordOrigin(c, cfg)
        if (bad) return bad
      }
      return next()
    }

    maybePrune(cfg.fingerprint)
    const token = getCookie(c, SESSION_COOKIE)
    const session = token ? lookupSession(token, cfg.fingerprint) : { valid: false, renewed: false }
    if (session.valid) {
      // The session is checked first, so a request without one never learns about the Origin rule.
      if (unsafe) {
        const bad = checkPasswordOrigin(c, cfg)
        if (bad) return bad
      }
      if (session.renewed) setSessionCookie(c, token!, cfg)
      return next()
    }

    noStore(c)
    const query = new URL(c.req.url).search
    const htmx = !!c.req.header('HX-Request')
    const navigation =
      (method === 'GET' || method === 'HEAD') &&
      !htmx &&
      (c.req.header('Sec-Fetch-Mode') === 'navigate' || (c.req.header('Accept') ?? '').includes('text/html'))
    if (navigation) return c.redirect(`/login?next=${encodeURIComponent(safeNext(path + query))}`, 302)
    if (htmx) {
      c.header('HX-Redirect', `/login?next=${encodeURIComponent(safeNext(currentPath(c)))}`)
      return c.body(null, 401)
    }
    return c.text('Unauthorized', 401)
  }
}

/** GET/POST /login and POST /logout, in password mode only. */
export function registerAuthRoutes(app: Hono, auth: AuthConfig): void {
  if (auth.mode !== 'password') return
  const cfg = auth.password

  app.get('/login', (c) => {
    const next = safeNext(c.req.query('next'))
    const token = getCookie(c, SESSION_COOKIE)
    if (token && lookupSession(token, cfg.fingerprint).valid) return c.redirect(next, 303)
    noStore(c)
    return c.html(LoginPage({ next }) as string)
  })

  app.post('/login', bodyLimit({ maxSize: 4096, onError: (c) => c.text('Too large', 413) }), async (c) => {
    noStore(c)
    const address = peerAddress(c) ?? 'unknown'
    const body = await c.req.parseBody()
    const next = safeNext(body.next)
    const wait = cfg.limiter.blockedFor(address)
    if (wait > 0) {
      const minutes = Math.max(1, Math.ceil(wait / 60))
      c.header('Retry-After', String(wait))
      return c.html(
        LoginPage({ next, error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` }) as string,
        429,
      )
    }
    if (typeof body.password !== 'string' || !cfg.verify(body.password)) {
      cfg.limiter.fail(address)
      return c.html(LoginPage({ next, error: 'That password is not right.' }) as string, 401)
    }
    cfg.limiter.succeed(address)
    setSessionCookie(c, createSession(cfg.fingerprint), cfg)
    return c.redirect(next, 303)
  })

  app.post('/logout', (c) => {
    const token = getCookie(c, SESSION_COOKIE)
    if (token) destroySession(token)
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.redirect('/login', 303)
  })
}
