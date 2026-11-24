import type { Sink } from '../../policy-schema.ts'
import { logEvent } from '../../events.ts'
import { messageLinks } from '../links.ts'
import type { Message, Priority } from '../types.ts'
import { FireOnce } from './once.ts'
import { userAgent } from '../../version.ts'

/**
 * The Discord sink: one embed per first fire or escalation, posted to a channel webhook.
 * The webhook URL is the secret, so it comes from an environment variable and is never
 * logged. Mentions are disabled: the text derives from release notes, which must never be
 * able to ping @everyone.
 */

type DiscordSink = Extract<Sink, { type: 'discord' }>

const once = new FireOnce()

const DISCORD_COLOR: Record<Priority, number> = { 1: 0x6b7280, 2: 0x6b7280, 3: 0x2563eb, 4: 0xd97706, 5: 0xdc2626 }

/** The webhook URL, or null when unset or not https. */
export function discordUrl(sink: DiscordSink): string | null {
  const url = process.env[sink.url_env] ?? ''
  return url.startsWith('https://') ? url : null
}

export async function sendDiscord(sink: DiscordSink, opts: Message, doFetch: typeof fetch = fetch): Promise<void> {
  const url = discordUrl(sink)
  if (!url) return
  if (!once.admit(opts)) return
  const priority = opts.priority ?? 3
  const linkText = messageLinks(opts.actions)
    .map((l) => `[${l.label}](${l.url})`)
    .join(' · ')
  const description =
    opts.body.slice(0, 4096 - (linkText ? linkText.length + 2 : 0)) + (linkText ? `\n\n${linkText}` : '')
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': userAgent() },
      body: JSON.stringify({
        username: 'shipshape',
        allowed_mentions: { parse: [] },
        embeds: [
          {
            title: opts.title.slice(0, 256),
            description,
            color: DISCORD_COLOR[priority],
            ...(opts.click && /^https?:\/\//.test(opts.click) ? { url: opts.click } : {}),
          },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`${res.status}`)
  } catch (err) {
    once.forget(opts.key)
    logEvent({ level: 'warn', kind: 'system', message: 'could not post to Discord', detail: (err as Error).message })
  }
}

export function resetDiscordSink(): void {
  once.reset()
}
