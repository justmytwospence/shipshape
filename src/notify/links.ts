import { createHmac, timingSafeEqual } from 'node:crypto'
import { allowedOrigin, env } from '../env.ts'
import { logEvent } from '../events.ts'
import type { IncidentAction } from './types.ts'

/**
 * Signed, expiring action links, for sinks that cannot call back through the MCP (email,
 * ntfy). `GET /act/<token>` shows a confirm page and `POST` runs the verb; both sit behind
 * the web UI's own authentication, so a leaked link alone does nothing.
 */

const TTL_MS = 14 * 24 * 60 * 60_000

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url')

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

export function makeToken(verb: string, updateId: number, secret: string, now = Date.now()): string {
  const payload = b64(JSON.stringify({ v: verb, u: updateId, e: now + TTL_MS }))
  return `${payload}.${sign(payload, secret)}`
}

export function verifyToken(
  token: string,
  secret: string,
  now = Date.now(),
): { verb: string; updateId: number } | null {
  const [payload, mac] = token.split('.')
  if (!payload || !mac) return null
  const want = Buffer.from(sign(payload, secret))
  const got = Buffer.from(mac)
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  try {
    const j = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { v?: unknown; u?: unknown; e?: unknown }
    if (typeof j.v !== 'string' || typeof j.u !== 'number' || typeof j.e !== 'number' || j.e < now) return null
    return { verb: j.v, updateId: j.u }
  } catch {
    return null
  }
}

/** A secret shorter than this is treated as unset: it would sign links that can be guessed. */
const ACTION_SECRET_MIN = 32

let warned = false

/** The secret links are signed with, or null when there is none worth signing with. */
function secret(): string | null {
  const s = env.actionSecret
  if (!s) return null
  if (s.length < ACTION_SECRET_MIN) {
    if (!warned) {
      warned = true
      logEvent({
        level: 'warn',
        kind: 'system',
        message: 'SHIPSHAPE_ACTION_SECRET is shorter than 32 characters, so no action links are sent',
        detail: 'generate one with: openssl rand -hex 32',
      })
    }
    return null
  }
  return s
}

/** A link that runs `verb` on an update, or null when links cannot be made (no secret or no origin). */
export function actionUrl(verb: string, updateId: number): string | null {
  const origin = allowedOrigin()
  const s = secret()
  if (!s || !origin) return null
  return `${origin.replace(/\/$/, '')}/act/${makeToken(verb, updateId, s)}`
}

export function verifyAction(token: string): { verb: string; updateId: number } | null {
  const s = secret()
  return s ? verifyToken(token, s) : null
}

/**
 * The signed links for a message's update actions; empty when links cannot be made. Stack
 * actions (retry, roll back) need the MCP and are left out.
 */
export function messageLinks(actions: IncidentAction[] | undefined, max = 4): { label: string; url: string }[] {
  return (actions ?? [])
    .flatMap((a) => {
      if (!('update' in a.do)) return []
      const url = actionUrl(a.do.verb, a.do.update)
      return url ? [{ label: `${a.emoji} ${a.label}`, url }] : []
    })
    .slice(0, max)
}
