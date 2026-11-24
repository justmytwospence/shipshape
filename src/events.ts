import { getDb } from './db/index.ts'

export const EVENT_KINDS = ['scan', 'policy', 'ship', 'analysis', 'deploy', 'sync', 'system'] as const


export interface ActivityRow {
  id: number
  at: string
  lastAt: string | null
  count: number
  level: 'info' | 'warn' | 'error'
  kind: string
  stack: string | null
  service: string | null
  message: string
  detail: string | null
}

export type EventLevel = 'info' | 'warn' | 'error'


export type EventKind = (typeof EVENT_KINDS)[number]


/** Repeats of the same message inside this window bump a counter instead of adding a row. */
const COALESCE_MS = 24 * 60 * 60 * 1000


export function logEvent(e: {
  level: EventLevel
  kind: EventKind
  message: string
  stack?: string
  service?: string
  detail?: string
}): void {
  const now = new Date()
  const db = getDb()

  // The same sentence, over and over, is one fact with a count -- not news each time. A
  // loop that reports "holding 13 updates" every poll cycle wrote 2,266 rows here and
  // buried everything that happened once.
  const recent = db
    .prepare(
      `SELECT id, count, COALESCE(last_at, at) AS seen_at FROM events
       WHERE kind = ? AND message = ? AND level = ?
         AND IFNULL(stack,'') = ? AND IFNULL(service,'') = ? AND IFNULL(detail,'') = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(e.kind, e.message, e.level, e.stack ?? '', e.service ?? '', e.detail ?? '') as
    | { id: number; count: number; seen_at: string }
    | undefined

  if (recent && now.getTime() - Date.parse(recent.seen_at) < COALESCE_MS) {
    db.prepare(`UPDATE events SET count = count + 1, last_at = ? WHERE id = ?`).run(
      now.toISOString(),
      recent.id,
    )
  } else {
    db.prepare(
      `INSERT INTO events (at, level, kind, stack, service, message, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      now.toISOString(),
      e.level,
      e.kind,
      e.stack ?? null,
      e.service ?? null,
      e.message,
      e.detail ?? null,
    )
  }
  const tag = `[${e.kind}]${e.stack ? ` ${e.stack}/${e.service ?? ''}` : ''}`
  const line = `${tag} ${e.message}${e.detail ? ` -- ${e.detail}` : ''}`
  if (e.level === 'error') console.error(line)
  else if (e.level === 'warn') console.warn(line)
  else console.log(line)
}

/** The activity log, newest first: the Activity page's query. */
export const activityRows = (opts: {
  kind: string
  problems: boolean
  q: string
  before?: string | null
  limit?: number
}): ActivityRow[] => {
  const where: string[] = []
  const args: (string | number)[] = []
  if ((EVENT_KINDS as readonly string[]).includes(opts.kind)) {
    where.push('kind = ?')
    args.push(opts.kind)
  }
  if (opts.problems) where.push(`level IN ('warn','error')`)
  if (opts.q) {
    where.push(`(message LIKE ? OR IFNULL(detail,'') LIKE ? OR IFNULL(stack,'') LIKE ?)`)
    const like = `%${opts.q}%`
    args.push(like, like, like)
  }
  if (opts.before) {
    where.push(`COALESCE(last_at, at) < ?`)
    args.push(opts.before)
  }
  args.push(opts.limit ?? 100)
  return getDb()
    .prepare(
      `SELECT id, at, last_at AS lastAt, count, level, kind, stack, service, message, detail
         FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY COALESCE(last_at, at) DESC LIMIT ?`,
    )
    .all(...args) as ActivityRow[]
}
