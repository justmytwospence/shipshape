import type { Sink } from '../../policy-schema.ts'
import { logEvent } from '../../events.ts'
import { messageLinks } from '../links.ts'
import type { Message, Priority } from '../types.ts'
import { FireOnce } from './once.ts'

/**
 * The Apprise sink: one notification per first fire or escalation, through an Apprise API
 * server, which fans it out to whatever services it is configured for. `url` is the full
 * notify endpoint: `.../notify/<key>` for a saved configuration, or `.../notify` with
 * stateless URLs set on the server.
 */

type AppriseSink = Extract<Sink, { type: 'apprise' }>

const once = new FireOnce()

const APPRISE_TYPE: Record<Priority, 'info' | 'warning' | 'failure'> = {
  1: 'info',
  2: 'info',
  3: 'info',
  4: 'warning',
  5: 'failure',
}

/**
 * The Authorization header: null without `auth_env`, false when it names an unset or empty
 * variable (the sink is not configured), otherwise Basic auth from `user:password`.
 */
export function appriseAuth(sink: AppriseSink): string | null | false {
  if (!sink.auth_env) return null
  const value = process.env[sink.auth_env]
  if (!value) return false
  return `Basic ${Buffer.from(value).toString('base64')}`
}

export async function sendApprise(sink: AppriseSink, opts: Message, doFetch: typeof fetch = fetch): Promise<void> {
  const auth = appriseAuth(sink)
  if (auth === false) return
  if (!once.admit(opts)) return
  const body = [
    opts.body.slice(0, 4000),
    opts.click ?? '',
    ...messageLinks(opts.actions).map((l) => `${l.label}: ${l.url}`),
  ]
    .filter(Boolean)
    .join('\n\n')
  try {
    const res = await doFetch(sink.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify({
        title: opts.title,
        body,
        type: APPRISE_TYPE[opts.priority ?? 3],
        format: 'text',
        ...(sink.tag ? { tag: sink.tag } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`${res.status}`)
  } catch (err) {
    once.forget(opts.key)
    logEvent({ level: 'warn', kind: 'system', message: 'could not notify through Apprise', detail: (err as Error).message })
  }
}

export function resetAppriseSink(): void {
  once.reset()
}
