import { loadPolicy } from '../config.ts'
import type { EventClass, Sink } from '../policy-schema.ts'
import { sendEmailSink, configured as emailConfigured } from './sinks/email.ts'
import { sendNtfy } from './sinks/ntfy.ts'
import { discordUrl, sendDiscord } from './sinks/discord.ts'
import { sendGotify } from './sinks/gotify.ts'
import { appriseAuth, sendApprise } from './sinks/apprise.ts'
import { endpointOf, retryPendingIncidents as retryWebhook, sendIncident } from './sinks/webhook.ts'
import type { Message } from './types.ts'

export { deployActions } from './sinks/webhook.ts'
export type { IncidentAction, IncidentStatus, Message, Priority } from './types.ts'

/**
 * Delivery: which sink gets what.
 *
 * Shipshape emits messages; `policy.notify.sinks` says where they go. A sink is a
 * `webhook` (JSON to any URL, the only sink that edits and resolves), `email`, `ntfy`,
 * `discord`, `gotify` or `apprise`. Each may list the `events` it wants:
 * `decision`, `broken`, `security`, `system`. Silence means healthy, so nothing here is a
 * "success" message; a condition that clears is a resolve, which only the webhook acts on.
 *
 * A sink that is not configured (no URL or token, no SMTP) is skipped whatever the policy
 * says, and a failing sink never stops another.
 */

const wantsEvent = (sink: Sink, cls: EventClass): boolean => !sink.events || sink.events.includes(cls)

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
          case 'discord':
            return sendDiscord(s, opts)
          case 'gotify':
            return sendGotify(s, opts)
          case 'apprise':
            return sendApprise(s, opts)
          default:
            return Promise.resolve()
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

/** For the Status page: the variables the configured sinks read, set or not. Names only. */
export function sinkCredentials(): { name: string; state: 'set' | 'missing'; note?: string }[] {
  const { policy } = loadPolicy()
  const out = new Map<string, { name: string; state: 'set' | 'missing'; note?: string }>()
  const add = (name: string, state: 'set' | 'missing', note?: string) => {
    if (!out.has(name)) out.set(name, { name, state, ...(note ? { note } : {}) })
  }
  const set = (name: string) => (process.env[name] ? 'set' : 'missing')
  for (const s of policy.notify.sinks) {
    if (s.type === 'webhook')
      add(s.url_env, set(s.url_env), process.env[s.token_env] ? `bearer from ${s.token_env}` : 'no bearer')
    if (s.type === 'discord') add(s.url_env, discordUrl(s) ? 'set' : 'missing', 'a Discord webhook URL (https)')
    if (s.type === 'gotify') add(s.token_env, set(s.token_env), `Gotify app token for ${s.url}`)
    if (s.type === 'apprise' && s.auth_env) add(s.auth_env, set(s.auth_env), 'Apprise basic auth, user:password')
    if (s.type === 'ntfy' && s.token_env) add(s.token_env, set(s.token_env), `ntfy token for ${s.topic}`)
  }
  return [...out.values()]
}

/** Which sinks would actually receive a message of this class, for the UI. */
export function activeChannels(cls: EventClass = 'system'): string[] {
  const { policy } = loadPolicy()
  const out: string[] = []
  for (const s of policy.notify.sinks) {
    if (!wantsEvent(s, cls)) continue
    if (s.type === 'webhook' && endpointOf(s)) out.push('webhook')
    if (s.type === 'email' && emailConfigured()) out.push('email')
    if (s.type === 'ntfy') out.push(`ntfy ${s.topic}`)
    if (s.type === 'discord' && discordUrl(s)) out.push('Discord')
    if (s.type === 'gotify' && process.env[s.token_env]) out.push('Gotify')
    if (s.type === 'apprise' && appriseAuth(s) !== false) out.push(s.tag ? `Apprise ${s.tag}` : 'Apprise')
  }
  return out
}
