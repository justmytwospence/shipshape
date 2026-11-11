import { env } from '../../config.ts'
import type { Sink } from '../../config.ts'
import { getDb, logEvent } from '../../db.ts'
import type { IncidentAction, IncidentStatus, Message, Priority } from '../types.ts'

/**
 * The webhook sink: an *incident* posted to the homelab's notification router (n8n's
 * Alerting workflow), which owns loudness, quiet hours and the one Matrix message per
 * incident that is edited in place. An incident carries a stable `key`; a later message
 * with the same key edits it, and `status: 'resolved'` closes it silently. Recovery is
 * never a message of its own: silence means healthy.
 *
 * Delivery is at least once. An incident that cannot be handed over is kept in the
 * database and retried on the next loop tick (`retryPendingIncidents`), latest state per
 * key winning, so a router restart does not drop a failure.
 */

type WebhookSink = Extract<Sink, { type: 'webhook' }>

export function endpointOf(sink: Pick<WebhookSink, 'url_env' | 'token_env'>): { url: string; token: string } | null {
  const url = process.env[sink.url_env] ?? ''
  const token = process.env[sink.token_env] ?? ''
  return url && token ? { url, token } : null
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

/** Retry and roll back, for `shipshape:deploy:<stack>`; shipshape decides at tap time. */
export function deployActions(key: string | undefined): IncidentAction[] | undefined {
  const m = key?.match(/^shipshape:deploy:(.+)$/)
  if (!m || !env.mcpPort) return undefined
  const stack = m[1]!
  return [
    { emoji: '🔁', label: 'retry', do: { target: 'shipshape', verb: 'retry', stack } },
    { emoji: '⏪', label: 'roll back', do: { target: 'shipshape', verb: 'rollback', stack } },
  ]
}

export async function sendIncident(sink: WebhookSink, opts: Message): Promise<void> {
  const ep = endpointOf(sink)
  if (!ep) return
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
  await deliver(sink, slot, payload)
}

async function deliver(sink: Pick<WebhookSink, 'url_env' | 'token_env'>, slot: string, payload: Payload): Promise<boolean> {
  const ep = endpointOf(sink)
  if (!ep) return false
  try {
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${ep.token}`, 'content-type': 'application/json' },
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
export async function retryPendingIncidents(sink: Pick<WebhookSink, 'url_env' | 'token_env'>): Promise<number> {
  if (!endpointOf(sink)) return 0
  const db = getDb()
  // Give up on a one-shot event after a day of failures; a keyed state is kept until it
  // goes through, because the latest state of a condition is still true.
  db.prepare(`DELETE FROM incidents WHERE key LIKE '~event:%' AND attempts > 1440`).run()
  const rows = db
    .prepare(`SELECT key, pending FROM incidents WHERE pending IS NOT NULL ORDER BY updated_at LIMIT 20`)
    .all() as { key: string; pending: string }[]
  let sent = 0
  for (const r of rows) {
    if (!(await deliver(sink, r.key, JSON.parse(r.pending) as Payload))) break
    sent++
  }
  return sent
}
