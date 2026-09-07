import { loadPolicy, env } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { notify } from './index.ts'
import { escapeHtml } from './email.ts'

/**
 * One notification per batch, not one per thing shipshape did.
 *
 * The split this rests on is between two kinds of message, and it is deliberately not
 * configurable:
 *
 *   **Alerts** — a deploy failed, a service came up unhealthy, sync is stuck, a rebase
 *   conflicted. Something is wrong *now* and waiting until morning makes it worse. These
 *   always send immediately, whatever the digest settings say, so turning digests on can
 *   never cause a failure to be missed. That guarantee is worth more than the flexibility
 *   of being able to batch them.
 *
 *   **Routine** — a pull request opened, one merged, a deploy succeeded, a verdict held
 *   something back, config changes were drafted. Each is a fact worth knowing and none is
 *   worth interrupting for. Individually they are a stream of pushes nobody reads; a
 *   dozen of them in one message is a morning summary. These are what batch.
 *
 * Items are recorded at the moment they happen and rendered when the digest fires, so a
 * restart in between loses nothing. Nothing is sent when nothing happened -- a daily
 * "0 things" push is how a person learns to ignore the channel.
 */

export type Category =
  | 'opened'
  | 'retargeted'
  | 'superseded'
  | 'merged'
  | 'deployed'
  | 'held'
  | 'drafted'
  | 'revised'

export interface DigestItem {
  category: Category
  summary: string
  stack?: string
  service?: string
  detail?: string
  url?: string
}

/**
 * Headings, in the order an update travels. Reading the digest top to bottom then tells
 * the same story as the pipeline: what appeared, what landed, what is waiting on you.
 */
const SECTIONS: { category: Category; heading: (n: number) => string }[] = [
  { category: 'opened', heading: (n) => `${n} pull request${s(n)} opened` },
  { category: 'retargeted', heading: (n) => `${n} retargeted` },
  { category: 'superseded', heading: (n) => `${n} superseded and closed` },
  { category: 'merged', heading: (n) => `${n} merged` },
  { category: 'deployed', heading: (n) => `${n} deployed` },
  { category: 'drafted', heading: (n) => `${n} carried drafted config changes` },
  // Only recorded when something actually changed. A plain answer is a reply to
  // something typed thirty seconds earlier; putting it in tomorrow's 08:00 summary is
  // noise, and noise is how a digest stops being read.
  { category: 'revised', heading: (n) => `${n} changed because you asked` },
  { category: 'held', heading: (n) => `${n} waiting on you` },
]

const s = (n: number) => (n === 1 ? '' : 's')

/** Beyond this per section the digest stops being readable and starts being a log. */
const MAX_PER_SECTION = 12

/**
 * Record something routine.
 *
 * In `immediate` mode it also sends straight away, which is the old behaviour and stays
 * available -- some people want the stream. In `off` nothing is recorded at all, so the
 * table does not grow forever collecting messages that will never be sent.
 */
export async function routine(item: DigestItem): Promise<void> {
  const { policy } = loadPolicy()
  if (policy.notify.routine === 'off') return

  getDb()
    .prepare(
      `INSERT INTO digest_items (at, category, stack, service, summary, detail, url, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      item.category,
      item.stack ?? null,
      item.service ?? null,
      item.summary,
      item.detail ?? null,
      item.url ?? null,
      // Immediate mode marks it sent as it writes it, so a later flush cannot repeat it.
      policy.notify.routine === 'immediate' ? new Date().toISOString() : null,
    )

  if (policy.notify.routine === 'immediate') {
    await notify({
      title: `shipshape: ${item.summary}`,
      body: item.detail ?? item.summary,
      kind: 'routine',
      tags: ['package'],
      click: item.url,
    })
  }
}

interface Row {
  id: number
  at: string
  category: Category
  stack: string | null
  service: string | null
  summary: string
  detail: string | null
  url: string | null
}

export function pending(): Row[] {
  return getDb()
    .prepare(`SELECT * FROM digest_items WHERE sent_at IS NULL ORDER BY id`)
    .all() as Row[]
}

/** The digest as structure, so each transport can render what it is actually good at. */
interface Grouped {
  title: string
  sections: { heading: string; items: Row[]; more: number }[]
}

function group(rows: Row[]): Grouped | null {
  if (rows.length === 0) return null
  const sections: Grouped['sections'] = []
  for (const section of SECTIONS) {
    const mine = rows.filter((r) => r.category === section.category)
    if (mine.length === 0) continue
    sections.push({
      heading: section.heading(mine.length),
      items: mine.slice(0, MAX_PER_SECTION),
      more: Math.max(0, mine.length - MAX_PER_SECTION),
    })
  }
  // A count in the title is what makes the notification worth expanding or not.
  return {
    title: rows.length === 1 ? `shipshape: ${rows[0]!.summary}` : `shipshape: ${rows.length} updates`,
    sections,
  }
}

/** `stack/service: ` prefix, or nothing when the item is not about one service. */
function where(r: Row): string {
  return r.stack ? `${r.stack}${r.service ? `/${r.service}` : ''}: ` : ''
}

/**
 * Render the digest as plain text. Pure, and exported so the UI can show exactly what
 * would go out.
 *
 * Returns null for an empty batch rather than an empty string, so "nothing to send" is a
 * state the caller has to handle rather than a message it might accidentally send.
 */
export function render(rows: Row[]): { title: string; body: string } | null {
  const g = group(rows)
  if (!g) return null

  const parts: string[] = []
  for (const section of g.sections) {
    parts.push(section.heading)
    for (const r of section.items) parts.push(`  ${where(r)}${r.summary}`)
    if (section.more > 0) parts.push(`  ...and ${section.more} more`)
    parts.push('')
  }
  return { title: g.title, body: parts.join('\n').trimEnd() }
}

/**
 * The same digest as HTML, for channels that can render one.
 *
 * Worth the second renderer for exactly one reason: every item already knows the pull
 * request it is about, and in a mail client that can be a link. The ntfy body cannot use
 * them -- a push has one click target for the whole message -- so the plain-text version
 * leaves them out rather than pasting bare URLs into a phone notification.
 */
export function renderHtml(rows: Row[]): string | null {
  const g = group(rows)
  if (!g) return null

  const esc = escapeHtml
  const out: string[] = [
    `<div style="font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c1c1a">`,
  ]
  for (const section of g.sections) {
    out.push(`<p style="margin:1.2em 0 .3em;font-weight:600">${esc(section.heading)}</p>`)
    out.push(`<ul style="margin:0;padding-left:1.2em">`)
    for (const r of section.items) {
      const text = `${esc(where(r))}${esc(r.summary)}`
      out.push(
        `<li style="margin:.2em 0">${
          r.url ? `<a href="${esc(r.url)}" style="color:#2f6f57">${text}</a>` : text
        }${r.detail ? `<div style="color:#6b6b66;font-size:.92em">${esc(r.detail)}</div>` : ''}</li>`,
      )
    }
    if (section.more > 0) {
      out.push(`<li style="margin:.2em 0;color:#6b6b66">and ${section.more} more</li>`)
    }
    out.push(`</ul>`)
  }
  out.push(
    `<p style="margin:1.5em 0 0;color:#6b6b66;font-size:.9em">` +
      `Anything that went wrong is sent on its own, immediately, and is never in a digest.</p>`,
    `</div>`,
  )
  return out.join('\n')
}

export interface FlushResult {
  sent: number
  skipped?: string
}

/**
 * Send everything waiting, and mark it sent.
 *
 * Marked sent only after the transport returns, and marked regardless of whether it
 * succeeded: `notify` already swallows and logs its own failures, and a batch that
 * retried forever would eventually push a hundred-line message about a week of history.
 * A missed digest is a missed digest; the Activity page still has all of it.
 */
export async function flush(trigger: 'cron' | 'manual'): Promise<FlushResult> {
  const rows = pending()
  if (rows.length === 0) return { sent: 0, skipped: 'nothing pending' }

  const message = render(rows)
  if (!message) return { sent: 0, skipped: 'nothing pending' }

  await notify({
    ...message,
    kind: 'routine',
    html: renderHtml(rows) ?? undefined,
    tags: ['package'],
    click: env.githubRepo ? `https://github.com/${env.githubRepo}/pulls` : undefined,
  })

  const now = new Date().toISOString()
  const mark = getDb().prepare(`UPDATE digest_items SET sent_at = ? WHERE id = ?`)
  getDb().transaction(() => {
    for (const r of rows) mark.run(now, r.id)
  })()

  logEvent({
    level: 'info',
    kind: 'system',
    message: `digest sent: ${rows.length} item(s)`,
    detail: trigger === 'manual' ? 'sent on request' : undefined,
  })
  return { sent: rows.length }
}

/** Old sent items are history nobody reads; keep a fortnight so a digest can be re-read. */
export function prune(): void {
  const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString()
  getDb().prepare(`DELETE FROM digest_items WHERE sent_at IS NOT NULL AND sent_at < ?`).run(cutoff)
}
