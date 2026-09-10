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

/**
 * The highest id the table has ever handed out.
 *
 * The quiescence check needs one question answered -- did anything reportable happen
 * during this tick -- and every reportable thing lands here. Comparing the watermark
 * across a tick answers it without each pass having to report for itself, and without
 * inventing a second definition of "work" that could drift from the one the digest uses.
 *
 * The column is AUTOINCREMENT, so pruning old rows cannot walk it backwards and make a
 * busy tick look quiet.
 */
export function lastItemId(): number {
  const row = getDb().prepare(`SELECT COALESCE(MAX(id), 0) id FROM digest_items`).get() as {
    id: number
  }
  return row.id
}

export function pending(): Row[] {
  return getDb()
    .prepare(`SELECT * FROM digest_items WHERE sent_at IS NULL ORDER BY id`)
    .all() as Row[]
}

/**
 * Take the pending batch, marking it sent in the same transaction that reads it.
 *
 * There are two callers of `flush` -- the schedule and the Send now button -- and
 * `flush` used to read the batch, `await` the transport, and only then mark it. Two
 * callers overlapping in that await both saw the same unsent rows and both sent them.
 * Rare while the read and the write were milliseconds apart; not rare once the digest
 * started waiting for deploys to finish before sending, which held the gap open for
 * minutes.
 *
 * Claiming first closes it by construction rather than by timing: the second caller's
 * SELECT returns nothing, whatever order they interleave in. `better-sqlite3` runs the
 * transaction synchronously, so there is no await inside it for anything to interleave
 * at.
 *
 * The cost is that a batch is marked sent before the transport confirms it, so a send
 * that fails is a digest nobody gets. That was already the policy -- rows were marked
 * regardless of whether `notify` succeeded, because a batch that retried forever would
 * eventually push a week of history -- so this gives up nothing that was being relied
 * on.
 */
export function claimPending(): Row[] {
  const db = getDb()
  return db.transaction(() => {
    const rows = db
      .prepare(`SELECT * FROM digest_items WHERE sent_at IS NULL ORDER BY id`)
      .all() as Row[]
    if (rows.length === 0) return rows
    const now = new Date().toISOString()
    const mark = db.prepare(`UPDATE digest_items SET sent_at = ? WHERE id = ?`)
    for (const r of rows) mark.run(now, r.id)
    return rows
  })()
}

/** The digest as structure, so each transport can render what it is actually good at. */
interface Grouped {
  title: string
  sections: { heading: string; items: Row[]; more: number }[]
}

/**
 * How far along the pipeline each category is, for choosing between two records of the
 * same pull request. Higher wins.
 *
 * Not the same order as SECTIONS, which is about reading. `superseded` sits low because
 * it is what happens to a pull request that got *replaced*: when a service has one
 * update superseded and its replacement deployed, "deployed" is the truer sentence.
 * `held` sits above the annotations because "waiting on you" is the thing you would act
 * on, and below `merged` because acting on it is exactly what a merge is.
 */
const PROGRESS: Record<Category, number> = {
  opened: 1,
  superseded: 2,
  retargeted: 3,
  drafted: 4,
  revised: 4,
  held: 5,
  merged: 6,
  deployed: 7,
}

/**
 * Which pull request an item is about.
 *
 * The pull request number, because that is the only field recorded consistently. `stack`
 * and `service` are not: the same pull request arrives as `changedetection/changedetection`
 * when it opens and `changedetection/-` when it deploys, and a verdict hold records
 * neither. Keying on those would leave the duplicates this exists to remove.
 */
function keyOf(r: Row): string {
  const pr = /\/pull\/(\d+)/.exec(r.url ?? '')
  // No pull request means no evidence that two rows describe the same thing, so they
  // are kept apart. Merging on a matching summary would quietly swallow one of two
  // genuinely separate events that happened to be worded the same.
  return pr ? `pr:${pr[1]}` : `item:${r.id}`
}

/**
 * One line per pull request, at the furthest point it reached.
 *
 * The digest used to replay transitions, so an update that opened, merged and deployed
 * between two digests appeared three times -- and the morning summary announced pull
 * requests as "opened" that had been running for five hours. Reporting the outcome is
 * both shorter and true.
 *
 * The winning row is also the one recorded furthest from the compose file, so it tends
 * to carry the least context: the deploy knows the stack, the verdict hold knows
 * neither. Names are backfilled from its siblings rather than lost.
 */
function collapse(rows: Row[]): Row[] {
  const best = new Map<string, Row>()
  for (const r of rows) {
    const k = keyOf(r)
    const cur = best.get(k)
    const further = !cur || PROGRESS[r.category] > PROGRESS[cur.category]
    // Same stage twice means the later record supersedes the earlier one.
    const newer = cur && PROGRESS[r.category] === PROGRESS[cur.category] && r.id > cur.id
    if (further || newer) best.set(k, { ...r })
  }
  for (const r of rows) {
    const w = best.get(keyOf(r))!
    if (!w.stack && r.stack) {
      w.stack = r.stack
      w.service = r.service
    } else if (w.stack === r.stack && !w.service && r.service) {
      w.service = r.service
    }
    if (!w.url && r.url) w.url = r.url
  }
  return [...best.values()].sort((a, b) => a.id - b.id)
}

function group(all: Row[]): Grouped | null {
  const rows = collapse(all)
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
 * Send everything waiting.
 *
 * The batch is claimed -- read and marked sent in one transaction -- before the transport
 * runs, so two callers overlapping in the await cannot both send it. Marked regardless of
 * whether the send succeeds: `notify` already swallows and logs its own failures, and a
 * batch that retried forever would eventually push a hundred-line message about a week of
 * history. A missed digest is a missed digest; the Activity page still has all of it.
 */
export async function flush(trigger: 'cron' | 'manual'): Promise<FlushResult> {
  const rows = claimPending()
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
