import { env, loadPolicy } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import * as email from './email.ts'

/**
 * Delivery, and which channel gets what.
 *
 * Two kinds of message, established in digest.ts and not configurable: **alerts** are
 * things that went wrong and always go out at once; **routine** is what shipshape did as
 * intended, which batches. Orthogonal to that, each channel says what it wants to
 * receive.
 *
 * The push channel is an *incident* posted to the homelab's notification router (n8n's
 * Alerting workflow, `NOTIFY_URL`), which owns loudness, quiet hours and the one Matrix
 * message per incident that is edited in place. An incident carries a stable `key`; a
 * later message with the same key edits it, and `status: 'resolved'` closes it silently.
 * Recovery is never a message of its own: silence means healthy.
 *
 * Delivery is at least once. An incident that cannot be handed over is kept in the
 * database and retried on the next loop tick (`retryPendingIncidents`), latest state per
 * key winning, so a router restart does not drop a failure.
 *
 * A channel that is not configured is skipped whatever the policy says.
 */

export type Priority = 1 | 2 | 3 | 4 | 5

/** Whether a message is about something that went wrong, or something that went right. */
export type Kind = 'alert' | 'routine'

export type IncidentStatus = 'firing' | 'resolved' | 'event'

/** A tap the router offers on the card and calls back on (`src/web/actions-api.ts`). */
export interface IncidentAction {
  emoji: string
  label: string
  do: { target: 'shipshape'; verb: 'retry' | 'rollback'; stack: string }
}

/** Retry and roll back, for `shipshape:deploy:<stack>`; shipshape decides at tap time. */
export function deployActions(key: string | undefined): IncidentAction[] | undefined {
  const m = key?.match(/^shipshape:deploy:(.+)$/)
  if (!m || !env.actionsToken) return undefined
  const stack = m[1]!
  return [
    { emoji: '🔁', label: 'retry', do: { target: 'shipshape', verb: 'retry', stack } },
    { emoji: '⏪', label: 'roll back', do: { target: 'shipshape', verb: 'rollback', stack } },
  ]
}

export interface Message {
  title: string
  body: string
  priority?: Priority
  tags?: string[]
  click?: string
  /** Defaults to `alert` -- the conservative choice, since alerts reach every channel. */
  kind?: Kind
  /** Richer body for channels that can render one. Ignored by the incident channel. */
  html?: string
  /**
   * Stable identity of the condition (`shipshape:deploy:<stack>`). Repeats edit one
   * message; `resolved` closes it. Without a key the message is a one-shot event.
   */
  key?: string
  /** Defaults to `firing` with a key, `event` without one. */
  status?: IncidentStatus
  /** One-tap fixes for the alert card (the router's `actions` contract). Deploy incidents
   *  get retry and roll back automatically when the actions listener is configured. */
  actions?: IncidentAction[]
}

/** Does a channel set to `mode` want a message of this kind? */
export function wants(mode: 'all' | 'alerts' | 'routine' | 'off', kind: Kind): boolean {
  if (mode === 'off') return false
  if (mode === 'all') return true
  return mode === (kind === 'alert' ? 'alerts' : 'routine')
}

export function incidentsConfigured(): boolean {
  return Boolean(env.notifyUrl && env.notifyToken)
}

export async function notify(opts: Message): Promise<void> {
  const { policy } = loadPolicy()
  const kind = opts.kind ?? 'alert'

  // A resolution is bookkeeping for the incident channel only: email never hears it.
  if (opts.status === 'resolved') {
    if (incidentsConfigured()) await sendIncident(opts)
    return
  }
  // Sent in parallel and awaited together: neither failing should stop the other. Both
  // swallow their own errors.
  await Promise.all([
    wants(policy.notify.incidents, kind) && incidentsConfigured() ? sendIncident(opts) : undefined,
    wants(policy.notify.email, kind) && email.configured() ? sendEmail(opts) : undefined,
  ])
}

/** Close an incident. Silent when it is not open: nothing is sent at all. */
export async function resolveIncident(key: string): Promise<void> {
  await notify({ key, status: 'resolved', title: '', body: '' })
}

interface Payload {
  key?: string
  source: 'shipshape'
  title?: string
  message?: string
  priority?: Priority
  status: IncidentStatus
  click?: string
  actions?: IncidentAction[]
}

async function sendIncident(opts: Message): Promise<void> {
  const status: IncidentStatus = opts.status ?? (opts.key ? 'firing' : 'event')
  const db = getDb()
  const row = opts.key
    ? (db.prepare(`SELECT open FROM incidents WHERE key = ?`).get(opts.key) as { open: number } | undefined)
    : undefined
  // Only resolve what this process opened (or a restart remembered): the router would
  // ignore it anyway, and this keeps every healthy sync and deploy off the wire.
  if (status === 'resolved' && !row?.open) return

  const payload: Payload =
    status === 'resolved'
      ? { key: opts.key, source: 'shipshape', status }
      : {
          key: opts.key,
          source: 'shipshape',
          title: opts.title,
          message: opts.body,
          priority: opts.priority ?? 3,
          status,
          click: opts.click,
          actions: opts.actions ?? deployActions(opts.key),
        }
  const slot = opts.key ?? `~event:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
  db.prepare(
    `INSERT INTO incidents (key, open, pending, attempts, updated_at) VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(key) DO UPDATE SET open = excluded.open, pending = excluded.pending,
       attempts = 0, updated_at = excluded.updated_at`,
  ).run(slot, status === 'firing' ? 1 : 0, JSON.stringify(payload), new Date().toISOString())
  await deliver(slot, payload)
}

async function deliver(slot: string, payload: Payload): Promise<boolean> {
  try {
    const res = await fetch(env.notifyUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.notifyToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`.slice(0, 200))
    const db = getDb()
    if (slot.startsWith('~event:')) db.prepare(`DELETE FROM incidents WHERE key = ?`).run(slot)
    else db.prepare(`UPDATE incidents SET pending = NULL WHERE key = ? AND pending = ?`).run(slot, JSON.stringify(payload))
    return true
  } catch (err) {
    // A missed notification must never break the operation that triggered it. It stays
    // pending and the next tick tries again.
    getDb().prepare(`UPDATE incidents SET attempts = attempts + 1 WHERE key = ?`).run(slot)
    logEvent({
      level: 'warn',
      kind: 'system',
      message: 'notification router unreachable; will retry',
      detail: (err as Error).message,
    })
    return false
  }
}

/** Hand over whatever earlier sends could not. Called once per loop tick. */
export async function retryPendingIncidents(): Promise<number> {
  if (!incidentsConfigured()) return 0
  const db = getDb()
  // Give up on a one-shot event after a day of failures; a keyed state is kept until it
  // goes through, because the latest state of a condition is still true.
  db.prepare(`DELETE FROM incidents WHERE key LIKE '~event:%' AND attempts > 1440`).run()
  const rows = db
    .prepare(`SELECT key, pending FROM incidents WHERE pending IS NOT NULL ORDER BY updated_at LIMIT 20`)
    .all() as { key: string; pending: string }[]
  let sent = 0
  for (const r of rows) {
    if (!(await deliver(r.key, JSON.parse(r.pending) as Payload))) break
    sent++
  }
  return sent
}

async function sendEmail(opts: Message): Promise<void> {
  await email.send({
    subject: opts.title,
    // A plain-text mail has nowhere else for the click target, so it goes at the end
    // where a signature would.
    text: opts.click ? `${opts.body}\n\n${opts.click}` : opts.body,
    html: opts.html,
  })
}

/**
 * Notify once per distinct reason. The sync loop can refuse on every cycle for the same
 * cause; the first one is information and the rest are noise.
 */
const lastReason = new Map<string, string>()

export async function notifyOnce(
  channel: string,
  reason: string,
  opts: Message,
): Promise<void> {
  if (lastReason.get(channel) === reason) return
  lastReason.set(channel, reason)
  await notify(opts)
}

/** Clear the dedupe memory when a channel returns to normal. */
export function clearNotifyState(channel: string): void {
  lastReason.delete(channel)
}

/** Which channels would actually receive a message of this kind, for the UI. */
export function activeChannels(kind: Kind): string[] {
  const { policy } = loadPolicy()
  const out: string[] = []
  if (incidentsConfigured() && wants(policy.notify.incidents, kind)) out.push('homelab alerting')
  if (email.configured() && wants(policy.notify.email, kind)) out.push('email')
  return out
}
