import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '../config.ts'

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

export function verifyToken(token: string, secret: string, now = Date.now()): { verb: string; updateId: number } | null {
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

/** A link that runs `verb` on an update, or null when links cannot be made (no secret or no origin). */
export function actionUrl(verb: string, updateId: number): string | null {
  const origin = process.env.SHIPSHAPE_ALLOWED_ORIGIN
  if (!env.actionSecret || !origin) return null
  return `${origin.replace(/\/$/, '')}/act/${makeToken(verb, updateId, env.actionSecret)}`
}

export function verifyAction(token: string): { verb: string; updateId: number } | null {
  return env.actionSecret ? verifyToken(token, env.actionSecret) : null
}
