import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, type Context } from 'hono'
import { env } from '../env.ts'
import { logEvent } from '../events.ts'
import { serverHandle, type ServerHandle } from '../lifecycle.ts'
import { health } from '../health/liveness.ts'
import { ErrorPage, notFoundCopy, serverErrorCopy } from './views/ui/errors.tsx'
import { type Chrome } from './views/ui/shell.tsx'
import { authMiddleware, describeAuth, registerAuthRoutes, resolveAuth } from './auth/index.ts'
import { pruneSessions } from './auth/session.ts'
import { securityHeaders } from './security-headers.ts'
import { chrome, toastHeader } from './render.ts'
import { registerServiceWorker } from './sw.ts'
import { registerInboxRoutes } from './routes/inbox.ts'
import { registerUpdateRoutes } from './routes/updates.ts'
import { registerServiceRoutes } from './routes/services.ts'
import { registerScanRoutes } from './routes/scan.ts'
import { registerActRoutes } from './routes/act.ts'
import { registerActivityRoutes } from './routes/activity.ts'
import { registerSettingsRoutes } from './routes/settings.ts'
import { registerStatusRoutes } from './routes/status.ts'
import { registerRedirects } from './routes/redirects.ts'

// Unknown paths and unexpected errors are pages in the shell, not bare text. htmx does
// not swap a 4xx or 5xx body, so an htmx request gets an empty body and a toast instead.
// The page must render even when the database is what broke.
const safeChrome = (c: Context): Chrome | undefined => {
  try {
    return chrome(c)
  } catch {
    return undefined
  }
}
const errorResponse = (c: Context, status: 404 | 500) => {
  if (c.req.header('HX-Request')) {
    toastHeader(
      c,
      status === 404 ? 'warn' : 'error',
      status === 404
        ? 'That no longer exists.'
        : 'Something went wrong. It may have been partly carried out; check Activity before trying again.',
    )
    return c.body(null, status)
  }
  const url = new URL(c.req.url)
  const copy = status === 404 ? notFoundCopy(c.req.path) : serverErrorCopy(c.req.method, url.pathname + url.search)
  return c.html(ErrorPage({ ...copy, chrome: safeChrome(c) }) as string, status)
}

export function createApp(): Hono {
  const app = new Hono()

  // Run before every route, including static files, redirects and unknown paths.
  // Exempt: GET /health for the container healthcheck, and GET/HEAD of the files in
  // public/ (needed by the sign-in and setup pages themselves).
  const auth = resolveAuth()
  app.use('*', securityHeaders())
  app.use('*', authMiddleware(auth))
  app.use('*', async (c, next) => {
    c.set('signOut', auth.mode === 'password')
    await next()
  })
  registerAuthRoutes(app, auth)
  if (auth.mode === 'password') pruneSessions(auth.password.fingerprint)
  app.get('/health', (c) => {
    const h = health()
    return c.json(h.body, h.status)
  })

  app.use('/static/*', serveStatic({ root: './public', rewriteRequestPath: (p) => p.replace(/^\/static/, '') }))
  registerServiceWorker(app)
  registerInboxRoutes(app)
  registerUpdateRoutes(app)
  registerServiceRoutes(app)
  registerScanRoutes(app)
  registerActRoutes(app)
  registerActivityRoutes(app)
  registerSettingsRoutes(app)
  registerStatusRoutes(app)
  registerRedirects(app)

  app.notFound((c) => errorResponse(c, 404))
  app.onError((err, c) => {
    console.error('[web]', err)
    try {
      logEvent({
        level: 'error',
        kind: 'system',
        message: `unhandled error: ${c.req.method} ${c.req.path}`,
        detail: err instanceof Error ? (err.stack ?? err.message) : String(err),
      })
    } catch {
      // The database may be what failed; the container log has it.
    }
    return errorResponse(c, 500)
  })

  return app
}

export function startServer(): ServerHandle {
  const app = createApp()
  const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
    console.log(`[system] shipshape listening on :${info.port}`)
  })
  const a = describeAuth()
  logEvent({
    level: a.mode === 'error' || a.mode === 'unconfigured' ? 'warn' : 'info',
    kind: 'system',
    message:
      a.mode === 'password' || a.mode === 'proxy'
        ? `web sign-in: ${a.mode}`
        : 'web UI has no sign-in configured: every page answers 503 until SHIPSHAPE_PASSWORD or SHIPSHAPE_TRUSTED_PROXY is set',
    detail: a.problems.join('; ') || undefined,
  })
  return serverHandle(server)
}
