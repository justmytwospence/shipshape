import { loadPolicy, env } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { activeChannels, notify } from './index.ts'
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
 *   An alert going out on its own does not excuse the digest from telling the truth about
 *   the same pull request, though. Channels are routed per kind, so `ntfy: alerts` with
 *   `email: routine` means the failure buzzed a phone at 03:06 and the email never heard
 *   of it -- and the email then described that pull request as "opened", because opening
 *   was the last routine thing that happened to it. See `reconcile`.
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
  // Never recorded. Synthesised by `reconcile` from what a deploy actually concluded, so
  // the digest cannot report a pull request at a stage it has already left.
  | 'went-wrong'

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
  // Next to `deployed` rather than at the end, because it is the other answer to the same
  // question. The alert with the detail has already gone out; this is the line that stops
  // the summary from contradicting it.
  { category: 'went-wrong', heading: (n) => `${n} went wrong after merging` },
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
  // Above `deployed`: a deploy that passed its window and then degraded, or was rolled
  // back, reached further than "deployed" and ended somewhere worse.
  'went-wrong': 8,
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
  const n = prNumber(r)
  // No pull request means no evidence that two rows describe the same thing, so they
  // are kept apart. Merging on a matching summary would quietly swallow one of two
  // genuinely separate events that happened to be worded the same.
  return n !== null ? `pr:${n}` : `item:${r.id}`
}

function prNumber(r: Row): number | null {
  const m = /\/pull\/(\d+)/.exec(r.url ?? '')
  return m ? Number(m[1]) : null
}

/** What became of a pull request, read when the digest is sent. */
export interface Outcome {
  merged: boolean
  /** Its most recent deploy, or null when it has never had one. */
  deploy: { status: string; detail: string | null } | null
}

/** Deploy statuses that ended badly, and how to say so in one line. */
const WENT_WRONG: Record<string, string> = {
  failed: 'merged, but did not deploy',
  error: 'merged, but its deploy could not be run',
  'rolled-back': 'deployed, failed verification, and was rolled back',
  degraded: 'deployed, then stopped being healthy',
}

/** A merge whose deploy has not concluded, or never will by itself. */
const MERGED_WHILE: Record<string, string> = {
  pending: 'merged, deploy queued',
  running: 'merged, deploy still running',
  ready: 'merged, ready to deploy',
  superseded: 'merged, its deploy folded into a later one',
}

/**
 * Correct the recorded story with what actually happened.
 *
 * The digest used to be built only from routine items recorded along the way, and a
 * pull request's story does not always end on a routine note. A merge is not recorded
 * for auto-deploying pull requests at all -- the `deployed` item is expected to follow
 * and supersede `opened` -- so when the deploy failed, nothing superseded it, and #93
 * went out as "opened" five hours after it had merged. Every other non-routine ending
 * does the same: a rollback, a soak that degraded, a deploy that could not be run, a
 * sync that blocked.
 *
 * Asking every one of those paths to also record a digest item would fix today's and
 * leave the next one to be discovered the same way. So the outcome is read instead, at
 * the moment of sending, and one row per pull request is added describing where it
 * really ended up. `collapse` then picks it the ordinary way, by rank, and backfills its
 * names from the rows it outranks.
 *
 * Only pull requests already in the batch are touched. This corrects what the digest
 * says; it never widens what the digest is about. Pure, so the whole mapping is testable
 * without a database.
 */
export function reconcile(rows: Row[], outcomes: Map<number, Outcome>): Row[] {
  const groups = new Map<number, Row[]>()
  for (const r of rows) {
    const n = prNumber(r)
    if (n === null) continue
    groups.set(n, [...(groups.get(n) ?? []), r])
  }

  const added: Row[] = []
  for (const [n, group] of groups) {
    const o = outcomes.get(n)
    if (!o) continue
    const best = Math.max(...group.map((r) => PROGRESS[r.category] ?? 0))
    // The newest record, so the added row sorts where the pull request last moved.
    const latest = group.reduce((a, b) => (b.id > a.id ? b : a))
    const row = (category: Category, summary: string): Row => ({
      ...latest,
      category,
      summary: `#${n} ${summary}`,
      detail: null,
    })

    const status = o.deploy?.status ?? null
    if (status && WENT_WRONG[status]) {
      added.push(row('went-wrong', `${WENT_WRONG[status]}${reason(o.deploy!.detail)}`))
    } else if ((status === 'deployed' || status === 'verified') && best < PROGRESS.deployed) {
      added.push(row('deployed', 'deployed'))
    } else if (o.merged && best < PROGRESS.merged) {
      added.push(row('merged', (status && MERGED_WHILE[status]) || 'merged'))
    }
  }
  return added.length ? [...rows, ...added] : rows
}

/**
 * The line worth quoting from a deploy's detail.
 *
 * The last one, not the first. A compose failure is recorded as "compose failed" followed
 * by the tail of its output, and the line that says *why* is at the bottom; everything
 * else recorded so far is a single line.
 */
function reason(detail: string | null): string {
  const lines = (detail ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  const last = lines[lines.length - 1]
  if (!last) return ''
  return `: ${last.length > 100 ? `${last.slice(0, 99)}…` : last}`
}

/** Read the outcome of every pull request the batch mentions. */
export function outcomesFor(rows: Row[]): Map<number, Outcome> {
  const out = new Map<number, Outcome>()
  const numbers = [...new Set(rows.map(prNumber).filter((n): n is number => n !== null))]
  if (numbers.length === 0) return out

  const db = getDb()
  const pr = db.prepare(`SELECT state FROM prs WHERE number = ? ORDER BY id DESC LIMIT 1`)
  // The latest attempt is the one that describes the present: a retry that verified
  // after a failure means the failure is history.
  const deploy = db.prepare(
    `SELECT status, detail FROM deploys WHERE pr_number = ? ORDER BY id DESC LIMIT 1`,
  )
  for (const n of numbers) {
    const p = pr.get(n) as { state: string } | undefined
    const d = deploy.get(n) as { status: string; detail: string | null } | undefined
    if (!p && !d) continue
    out.set(n, { merged: p?.state === 'merged', deploy: d ?? null })
  }
  return out
}

/** Rows as they will be sent: the batch, corrected by what actually happened. */
export function withOutcomes(rows: Row[]): Row[] {
  return reconcile(rows, outcomesFor(rows))
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
export function renderHtml(
  rows: Row[],
  opts: { alertChannels?: string[] } = {},
): string | null {
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
    `<p style="margin:1.5em 0 0;color:#6b6b66;font-size:.9em">${esc(footer(opts.alertChannels))}</p>`,
    `</div>`,
  )
  return out.join('\n')
}

/**
 * Where failures went, said where the reader is.
 *
 * It used to claim failures were "never in a digest", which stopped being true and was
 * unhelpful while it was: the reader of an email with `email: routine` has no way to
 * know that the thing they are looking for went to their phone at three in the morning.
 * Naming the channel answers that. Naming none says something worth knowing too.
 */
function footer(channels: string[] | undefined): string {
  if (!channels) return 'Failures are also sent on their own, the moment they happen.'
  if (channels.length === 0) {
    return 'Nothing is set up to receive failures on their own -- this digest is the only place they appear.'
  }
  return `Failures are also sent on their own, the moment they happen, by ${channels.join(' and ')}.`
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
  const claimed = claimPending()
  if (claimed.length === 0) return { sent: 0, skipped: 'nothing pending' }

  // Outcomes are read after the claim, so they are as fresh as the send itself.
  const rows = withOutcomes(claimed)
  const message = render(rows)
  if (!message) return { sent: 0, skipped: 'nothing pending' }

  await notify({
    ...message,
    kind: 'routine',
    html: renderHtml(rows, { alertChannels: activeChannels('alert') }) ?? undefined,
    tags: ['package'],
    click: env.githubRepo ? `https://github.com/${env.githubRepo}/pulls` : undefined,
  })

  logEvent({
    level: 'info',
    kind: 'system',
    message: `digest sent: ${claimed.length} item(s)`,
    detail: trigger === 'manual' ? 'sent on request' : undefined,
  })
  return { sent: claimed.length }
}

/** Old sent items are history nobody reads; keep a fortnight so a digest can be re-read. */
export function prune(): void {
  const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString()
  getDb().prepare(`DELETE FROM digest_items WHERE sent_at IS NOT NULL AND sent_at < ?`).run(cutoff)
}
