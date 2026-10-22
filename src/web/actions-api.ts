import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { env } from '../config.ts'
import { logEvent } from '../db.ts'
import { isStackVerb, runStackVerb } from '../updates/stack-verbs.ts'
import { runOperatorVerb, type OperatorVerb } from '../updates/operator-verbs.ts'

/**
 * The machine-only listener: a second port, never routed by the reverse proxy, reached
 * by the homelab's notification router over a private network. It exists so a tap on an
 * alert card can retry or roll back a failed deploy without a browser session.
 *
 * The web interface trusts only its reverse proxy's asserted identity (`auth.ts`); this
 * listener trusts only a bearer (ACTIONS_TOKEN), and offers nothing but the stack verbs
 * (deploy incidents) and the update verbs below (the cards for updates waiting on you),
 * each of which still goes through `actionsFor`. No token, no listener.
 */
export const UPDATE_VERBS = ['merge-deploy', 'open-pr', 'deploy', 'redeploy', 'skip', 'rerun-review', 'release-hold'] as const satisfies readonly OperatorVerb[]
type UpdateVerb = (typeof UPDATE_VERBS)[number]
const isUpdateVerb = (v: string): v is UpdateVerb => (UPDATE_VERBS as readonly string[]).includes(v)

export function createActionsApp(token: string = env.actionsToken): Hono {
  const app = new Hono()
  const expected = Buffer.from(`Bearer ${token}`)
  const authorized = (header: string | undefined): boolean => {
    const got = Buffer.from(header ?? '')
    return token.length > 0 && got.length === expected.length && timingSafeEqual(got, expected)
  }

  app.get('/health', (c) => c.json({ ok: true }))

  app.post('/actions/stacks/:stack/:verb', async (c) => {
    if (!authorized(c.req.header('Authorization'))) return c.json({ ok: false, message: 'unauthorized' }, 401)
    const { stack, verb } = c.req.param()
    if (!isStackVerb(verb)) return c.json({ ok: false, message: `${verb} is not offered here` }, 404)
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(stack)) return c.json({ ok: false, message: 'bad stack name' }, 400)
    const result = await runStackVerb(stack, verb)
    logEvent({
      level: result.ok ? 'info' : 'warn',
      kind: 'deploy',
      stack,
      message: `${verb} requested from an alert card`,
      detail: result.message,
    })
    return c.json(result)
  })

  app.post('/actions/updates/:id/:verb', async (c) => {
    if (!authorized(c.req.header('Authorization'))) return c.json({ ok: false, message: 'unauthorized' }, 401)
    const id = Number(c.req.param('id'))
    const verb = c.req.param('verb')
    if (!isUpdateVerb(verb)) return c.json({ ok: false, message: `${verb} is not offered here` }, 404)
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, message: 'bad update id' }, 400)
    const result = await runOperatorVerb(id, verb)
    logEvent({
      level: result.ok ? 'info' : 'warn',
      kind: 'pr',
      message: `${verb} on update ${id} requested from an alert card`,
      detail: result.message,
    })
    return c.json(result)
  })

  return app
}

export function startActionsServer(): void {
  if (!env.actionsToken) return
  const app = createActionsApp()
  serve({ fetch: app.fetch, port: env.actionsPort }, (info) => {
    console.log(`[system] shipshape actions listening on :${info.port}`)
  })
}
