import type { Message } from '../types.ts'
import { actionUrl } from '../links.ts'
import * as mail from '../email.ts'

/**
 * The email sink. Email never edits: it sends when a condition first fires and again when
 * it escalates, and says nothing about edits, repeats or resolutions -- an inbox that
 * fills with "updated" and "resolved" is how mail stops being read. Actions become
 * signed links when links can be made.
 */

const sent = new Map<string, number>()

export function configured(): boolean {
  return mail.configured()
}

export async function sendEmailSink(opts: Message): Promise<void> {
  if (!configured()) return
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
  const links = (opts.actions ?? []).flatMap((a) => {
    if (!('update' in a.do)) return []
    const url = actionUrl(a.do.verb, a.do.update)
    return url ? [`${a.emoji} ${a.label}: ${url}`] : []
  })
  const text = [opts.body, opts.click ?? '', ...links].filter(Boolean).join('\n\n')
  await mail.send({ subject: opts.title, text })
}

/** Forget remembered keys; for the tests. */
export function resetEmailSink(): void {
  sent.clear()
}
