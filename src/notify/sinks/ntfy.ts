import type { Sink } from '../../config.ts'
import { logEvent } from '../../db.ts'
import type { Message } from '../types.ts'
import { actionUrl } from '../links.ts'

/**
 * The ntfy sink: one JSON publish per first fire or escalation, with the card's actions as
 * view buttons pointing at signed links. Like email it never edits and ignores resolves.
 */

type NtfySink = Extract<Sink, { type: 'ntfy' }>

const sent = new Map<string, number>()

export async function sendNtfy(sink: NtfySink, opts: Message, doFetch: typeof fetch = fetch): Promise<void> {
  if (opts.status === 'resolved') {
    if (opts.key) sent.delete(opts.key)
    return
  }
  const priority = opts.priority ?? 3
  if (opts.key) {
    const was = sent.get(opts.key)
    if (was !== undefined && priority <= was) return
    sent.set(opts.key, priority)
  }
  const actions = (opts.actions ?? []).slice(0, 3).flatMap((a) => {
    if (!('update' in a.do)) return []
    const url = actionUrl(a.do.verb, a.do.update)
    return url ? [{ action: 'view', label: `${a.emoji} ${a.label}`.slice(0, 40), url }] : []
  })
  const token = sink.token_env ? process.env[sink.token_env] : undefined
  try {
    const res = await doFetch(sink.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        topic: sink.topic,
        title: opts.title,
        message: opts.body.slice(0, 3000),
        priority: priority,
        ...(opts.click ? { click: opts.click } : {}),
        ...(actions.length > 0 ? { actions } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`${res.status}`)
  } catch (err) {
    sent.delete(opts.key ?? '')
    logEvent({ level: 'warn', kind: 'system', message: 'could not publish to ntfy', detail: (err as Error).message })
  }
}

export function resetNtfySink(): void {
  sent.clear()
}
