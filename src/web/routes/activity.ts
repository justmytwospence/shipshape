import type { Context, Hono } from 'hono'
import { type ActivityRow, activityRows } from '../../events.ts'
import { ActivityPage } from '../views/pages.tsx'
import { ActivityList } from '../views/ui/activity.tsx'
import { chrome } from '../render.ts'

/**
 * The log, ordered by when a line was last seen rather than first written.
 *
 * A repeated message is one row with a count, so a fact that recurred all afternoon
 * sorts by the afternoon and not by the morning it started.
 */
const activityQuery = (c: Context) => ({
  // `pr` was the ship kind's name in v1; an old bookmark still lands.
  kind: c.req.query('kind') === 'pr' ? 'ship' : (c.req.query('kind') ?? 'all'),
  problems: c.req.query('level') === 'problems',
  q: c.req.query('q') ?? '',
})

const activityFiltered = (q: { kind: string; problems: boolean; q: string }) =>
  q.kind !== 'all' || q.problems || q.q !== ''

/** The link that fetches the next page, or nothing when this was the last one. */
const moreLink = (c: Context, rows: ActivityRow[]): string | null => {
  if (rows.length < 100) return null
  const last = rows[rows.length - 1]!
  const p = new URLSearchParams({
    kind: c.req.query('kind') ?? 'all',
    q: c.req.query('q') ?? '',
    before: last.lastAt ?? last.at,
  })
  if (c.req.query('level') === 'problems') p.set('level', 'problems')
  return `/fragments/activity?${p.toString()}`
}

/** The activity log and its next pages. */
export function registerActivityRoutes(app: Hono): void {
  app.get('/activity', (c) => {
    const query = activityQuery(c)
    const rows = activityRows(query)
    if (c.req.header('HX-Request')) {
      return c.html(ActivityList({ rows, more: moreLink(c, rows), filtered: activityFiltered(query) }) as string)
    }
    return c.html(
      ActivityPage({
        rows,
        more: moreLink(c, rows),
        ...query,
        chrome: chrome(c),
      }) as string,
    )
  })

  app.get('/fragments/activity', (c) => {
    const query = activityQuery(c)
    const rows = activityRows({ ...query, before: c.req.query('before') })
    return c.html(ActivityList({ rows, more: moreLink(c, rows), filtered: activityFiltered(query) }) as string)
  })
}
