import { loadPolicy, type EventClass, type Sink } from '../config.ts'
import { sendEmailSink, configured as emailConfigured } from './sinks/email.ts'
import { sendNtfy } from './sinks/ntfy.ts'
import { endpointOf, retryPendingIncidents as retryWebhook, sendIncident } from './sinks/webhook.ts'
import type { Message } from './types.ts'

export { deployActions } from './sinks/webhook.ts'
export type { IncidentAction, IncidentStatus, Message, Priority } from './types.ts'

/**
 * Delivery: which sink gets what.
 *
 * Shipshape emits messages; `policy.notify.sinks` says where they go. A sink is a
 * `webhook` (the homelab's notification router, which keeps one live card per key and is
 * what Hermes replies to), `email` or `ntfy`. Each may list the `events` it wants:
 * `decision`, `broken`, `security`, `system`. Silence means healthy, so nothing here is a
 * "success" message; a condition that clears is a resolve, which only the webhook acts on.
 *
 * A sink that is not configured (no URL or token, no SMTP) is skipped whatever the policy
 * says, and a failing sink never stops another.
 */

const wantsEvent = (sink: Sink, cls: EventClass): boolean => !sink.events || sink.events.includes(cls)

export function incidentsConfigured(): boolean {
  const { policy } = loadPolicy()
  return policy.notify.sinks.some((s) => s.type === 'webhook' && endpointOf(s))
}

export async function notify(opts: Message): Promise<void> {
  const { policy } = loadPolicy()
  const cls: EventClass = opts.eventClass ?? 'system'
  await Promise.all(
    policy.notify.sinks
      .filter((s) => wantsEvent(s, cls))
      .map((s) => {
        switch (s.type) {
          case 'webhook':
            return sendIncident(s, opts)
          case 'email':
            return sendEmailSink(opts)
          case 'ntfy':
            return sendNtfy(s, opts)
        }
      }),
  )
}

/** Close an incident. Silent when it is not open: nothing is sent at all. */
export async function resolveIncident(key: string, opts: Pick<Message, 'redact' | 'eventClass'> = {}): Promise<void> {
  await notify({ key, status: 'resolved', title: '', body: '', ...opts })
}

/** Hand over whatever earlier webhook sends could not. Called once per loop tick. */
export async function retryPendingIncidents(): Promise<number> {
  const { policy } = loadPolicy()
  let n = 0
  for (const s of policy.notify.sinks) if (s.type === 'webhook') n += await retryWebhook(s)
  return n
}

/**
 * Notify once per distinct reason. The sync loop can refuse on every cycle for the same
 * cause; the first one is information and the rest are noise.
 */
const lastReason = new Map<string, string>()

export async function notifyOnce(channel: string, reason: string, opts: Message): Promise<void> {
  if (lastReason.get(channel) === reason) return
  lastReason.set(channel, reason)
  await notify(opts)
}

/** Clear the dedupe memory when a channel returns to normal. */
export function clearNotifyState(channel: string): void {
  lastReason.delete(channel)
}

/** Which sinks would actually receive a message of this class, for the UI. */
export function activeChannels(cls: EventClass = 'system'): string[] {
  const { policy } = loadPolicy()
  const out: string[] = []
  for (const s of policy.notify.sinks) {
    if (!wantsEvent(s, cls)) continue
    if (s.type === 'webhook' && endpointOf(s)) out.push('homelab alerting')
    if (s.type === 'email' && emailConfigured()) out.push('email')
    if (s.type === 'ntfy') out.push(`ntfy ${s.topic}`)
  }
  return out
}
