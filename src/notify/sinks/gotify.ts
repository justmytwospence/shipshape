import type { Sink } from '../../config.ts'
import { logEvent } from '../../db.ts'
import { messageLinks } from '../links.ts'
import type { Message, Priority } from '../types.ts'
import { FireOnce } from './once.ts'

/**
 * The Gotify sink: one plain-text message per first fire or escalation. Plain text because
 * Gotify's markdown downloads images automatically, and the text derives from release notes.
 */

type GotifySink = Extract<Sink, { type: 'gotify' }>

const once = new FireOnce()

const GOTIFY_PRIORITY: Record<Priority, number> = { 1: 1, 2: 3, 3: 5, 4: 8, 5: 10 }

export async function sendGotify(sink: GotifySink, opts: Message, doFetch: typeof fetch = fetch): Promise<void> {
  const token = process.env[sink.token_env]
  if (!token) return
  if (!once.admit(opts)) return
  const message = [
    opts.body.slice(0, 4000),
    opts.click ?? '',
    ...messageLinks(opts.actions).map((l) => `${l.label}: ${l.url}`),
  ]
    .filter(Boolean)
    .join('\n\n')
  try {
    const res = await doFetch(`${sink.url.replace(/\/+$/, '')}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gotify-key': token },
      body: JSON.stringify({
        title: opts.title,
        message,
        priority: GOTIFY_PRIORITY[opts.priority ?? 3],
        extras: {
          'client::display': { contentType: 'text/plain' },
          ...(opts.click ? { 'client::notification': { click: { url: opts.click } } } : {}),
        },
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`${res.status}`)
  } catch (err) {
    once.forget(opts.key)
    logEvent({ level: 'warn', kind: 'system', message: 'could not publish to Gotify', detail: (err as Error).message })
  }
}

export function resetGotifySink(): void {
  once.reset()
}
