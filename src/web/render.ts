import { type Context } from 'hono'
import { raw } from 'hono/html'
import { loadPolicy } from '../config.ts'
import { configured, env } from '../env.ts'
import { getDb } from '../db/index.ts'
import { logEvent } from '../events.ts'
import { setupSteps } from './onboarding.ts'
import { ZONE } from './time.ts'
import { describeCron } from './views/ui/settings.tsx'
import { reviewOffReason } from '../analyze/review-state.ts'
import { buildUpdateDiff, type DiffHunk } from '../diff.ts'
import { parseImageRef } from '../images/ref.ts'
import { refLinks } from '../links.ts'
import { scanInfo } from '../scan/index.ts'
import { sourceForSync } from '../resolver/index.ts'
import { scheduleInfo } from '../scheduler.ts'
import { listUpdates, listReleases } from '../updates/queries.ts'
import { updateTimeline } from '../updates/timeline.ts'
import { inboxNeedsYou, inboxParked, inboxPausedOnly, inboxRecent } from '../updates/inbox.ts'
import { updateView, type UpdateView } from '../updates/view.ts'
import { InboxPage, ServicesPage, UpdatesPage, ReleasesPage, type Detail } from './views/pages.tsx'
import { type Chrome } from './views/ui/shell.tsx'
import { ctxString, listHref, readCtx, type ListCtx } from './ctx.ts'
import { ServiceDetail } from './views/ui/services.tsx'
import { filterServices as filterServiceRows, serviceDetail, serviceRows } from '../updates/services.ts'
import { type InboxData } from './views/ui/inbox.tsx'
import { UpdateDetail } from './views/ui/update.tsx'
import { DiffView } from './views/diff.tsx'

declare module 'hono' {
  interface ContextVariableMap {
    /** Whether the shell offers Sign out: password sign-in only. Set by createApp. */
    signOut: boolean
  }
}

/** Missing configuration, passed into every page so the banner is unmissable. */
export function missing(): { name: string; why: string }[] {
  const s = configured()
  return s.ok ? [] : s.missing
}

/**
 * A toast, delivered in a header.
 *
 * HTTP headers are ByteString: a character above 255 throws when it is set, which takes
 * the whole response with it. The messages here are written in English prose and contain
 * em dashes, so this is not hypothetical -- pressing Deploy returned a 500 rather than a
 * sentence. JSON's own \uXXXX escapes keep the payload valid and pure ASCII, and the
 * browser parses the dash back out at the other end.
 */
export function toastHeader(c: Context, level: 'info' | 'warn' | 'error', text: string): void {
  const json = JSON.stringify({ toast: { level, text } })
  c.header(
    'HX-Trigger',
    json.replace(/[\u0080-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`),
  )
}

/** Everything a page needs to draw its own frame. */
export const chrome = (c: Context): Chrome => {
  const info = scanInfo()
  return {
    paused: loadPolicy().policy.paused,
    missing: missing(),
    signOut: c.get('signOut') === true,
    counts: navCounts(),
    scan: { lastAt: info.lastAt, nextAt: scheduleInfo().scan.nextAt, running: info.running },
  }
}

/**
 * The numbers beside the destinations. Cheap on purpose -- three counts, no views
 * built -- because they render on every page. The Inbox count is the shapes
 * attentionKind() looks for, counted rather than built; if the two ever disagree, the
 * list is right and this is the one to fix.
 */
export const navCounts = (): NonNullable<Chrome['counts']> => {
  const db = getDb()
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n
  return {
    // Decisions are judged by the hold logic rather than by SQL, so the count is the
    // same one the Inbox page lists.
    inbox: inboxNeedsYou().length,
    updates: one(
      `SELECT COUNT(*) AS n FROM updates WHERE state IN ('detected','frozen','merged')`,
    ),
    attention: one(
      `SELECT COUNT(*) AS n FROM images WHERE last_status IS NOT NULL OR constrained_from IS NOT NULL`,
    ),
  }
}

/** The diff, when there is one to show. */
export const updateDiff = (id: number): unknown => {
  try {
    const html = diffFragment(id)
    return html ? raw(html) : null
  } catch (err) {
    logEvent({ level: 'warn', kind: 'system', message: 'a diff could not be shown', detail: `update ${id}: ${(err as Error).message.slice(0, 300)}` })
    return null
  }
}

export const updatesTotal = (): number =>
  (getDb().prepare(`SELECT COUNT(*) AS n FROM updates`).get() as { n: number }).n

export const inboxData = (): InboxData => {
  const info = scanInfo()
  const { policy } = loadPolicy()
  const pausedOnly = inboxPausedOnly()
  const counts = getDb()
    .prepare(`SELECT COUNT(*) AS services, COUNT(DISTINCT stack) AS stacks, SUM(watched) AS watched FROM images`)
    .get() as { services: number; stacks: number; watched: number | null }
  const cron = scheduleInfo().scan.cron
  return {
    needsYou: inboxNeedsYou(),
    recent: inboxRecent(24),
    parked: inboxParked(),
    pausedOnly,
    setup: setupSteps({
      missing: missing(),
      repoDir: env.repoDir,
      composeFiles: info.composeFiles,
      services: counts.services,
      stacks: counts.stacks,
      watched: counts.watched ?? 0,
      lastScanAt: info.lastAt,
      schedule: describeCron(cron, ZONE) ?? cron,
      reviewOff: reviewOffReason(policy),
      reader: policy.review.model,
      paused: policy.paused,
      wouldShip: pausedOnly.length,
    }),
    scan: {
      lastAt: info.lastAt ? Date.parse(info.lastAt) : null,
      nextAt: scheduleInfo().scan.nextAt,
      running: info.running,
      watched: (
        getDb().prepare(`SELECT COUNT(*) AS n FROM images WHERE watched = 1`).get() as {
          n: number
        }
      ).n,
    },
  }
}

// ------------------------------------------------------------ list pages
//
// Every list route answers twice: whole, for a navigation, and as its list alone for
// the toolbar's filter (which asks the page's own URL, so what it pushes reloads whole).
// A detail route -- /updates/:id, /services/:stack/:svc -- reads which list it came
// from and renders that page turned inside out: list beside a filled pane at lg, pane
// alone below it.

export const ctxOf = (c: Context, fallback: 'inbox' | 'updates' | 'services') =>
  readCtx((k) => c.req.query(k), fallback)

export const inboxRender = (c: Context, detail?: { id: number; d: Detail }) =>
  InboxPage({ data: inboxData(), chrome: chrome(c), selectedId: detail?.id, detail: detail?.d })

export const updatesRender = (c: Context, ctx: ListCtx, detail?: { id: number; d: Detail }) => {
  // The releases feed is the same page with a different list in it, and a different
  // query behind that: every state, newest first, carrying the outbound links.
  if (ctx.stage === 'releases') {
    const releases = listReleases({ q: ctx.q, magnitude: ctx.magnitude })
    return ReleasesPage({
      releases,
      stage: ctx.stage,
      q: ctx.q,
      magnitude: ctx.magnitude,
      ctx: ctxString({ ...ctx, list: 'updates' }),
      chrome: chrome(c),
      selectedId: detail?.id,
      detail: detail?.d,
    })
  }
  const updates = listUpdates({ stage: ctx.stage, q: ctx.q, magnitude: ctx.magnitude })
  return UpdatesPage({
    updates,
    total: updatesTotal(),
    stage: ctx.stage,
    q: ctx.q,
    magnitude: ctx.magnitude,
    ctx: ctxString({ ...ctx, list: 'updates' }),
    chrome: chrome(c),
    selectedId: detail?.id,
    detail: detail?.d,
  })
}

export const servicesRender = (
  c: Context,
  ctx: ListCtx,
  detail?: { selected: { stack: string; service: string }; d: Detail },
) => {
  const all = serviceRows()
  const services = filterServiceRows(all, { filter: ctx.filter, q: ctx.q })
  return ServicesPage({
    services,
    total: all.length,
    filter: ctx.filter,
    q: ctx.q,
    grouped: ctx.grouped,
    ctx: ctxString({ ...ctx, list: 'services' }),
    chrome: chrome(c),
    selected: detail?.selected,
    detail: detail?.d,
  })
}

/** The pane's contents for one update, in the list it was opened from. */
export const updatePane = (id: number, ctx: ListCtx): { update: UpdateView; pane: unknown } | null => {
  const update = updateView(id)
  if (!update) return null
  const from = listHref(ctx)
  return {
    update,
    pane: UpdateDetail({
      update,
      milestones: updateTimeline(id),
      diff: updateDiff(id),
      listHref: from.href,
      fromService:
        ctx.list === 'service' && ctx.stack && ctx.service
          ? { stack: ctx.stack, service: ctx.service }
          : undefined,
      ctx: ctxString(ctx),
    }),
  }
}

/** The pane's contents for one service. */
export const servicePane = (stack: string, service: string, ctx: ListCtx) => {
  const data = serviceDetail(stack, service)
  if (!data) return null
  const listCtx: ListCtx = { ...ctx, list: 'services' }
  return {
    data,
    pane: ServiceDetail({
      data,
      ctx: ctxString(listCtx),
      listHref: listHref(listCtx).href,
    }),
  }
}

/**
 * The diff fragment, built once and shared by /updates/:id/diff and the drawer.
 *
 * Two endpoints rendering the same panel is exactly how the two drift, and this one
 * carries the proposal block and the reference links -- the parts a reviewer reads.
 */
export function diffFragment(id: number): string {

        const result = buildUpdateDiff(id)
    const db = getDb()
    const pr = db
      .prepare(
        `SELECT p.id FROM prs p JOIN pr_updates pu ON pu.pr_id = p.id
         WHERE pu.update_id = ? AND p.state = 'open' ORDER BY p.id DESC LIMIT 1`,
      )
      .get(id) as { id: number } | undefined

    // Links point at the TARGET tag: this panel is where the merge decision happens.
    const row = db
      .prepare(
        `SELECT u.image, u.to_tag, u.stack, u.service FROM updates u
         JOIN images i ON i.stack = u.stack AND i.service = u.service
         WHERE u.id = ?`,
      )
      .get(id) as { image: string; to_tag: string; stack: string; service: string } | undefined
    const ref = row ? parseImageRef(row.image) : null
    const source =
      row && ref
        ? sourceForSync(
            { registry: ref.registry, repository: ref.repository },
            { service: { stack: row.stack, service: row.service } },
          )
        : null

    const proposal = pr
      ? (db
          .prepare(
            `SELECT summary, notes, changed, error, model, hunks FROM proposals
             WHERE pr_id = ? ORDER BY id DESC LIMIT 1`,
          )
          .get(pr.id) as
          | {
              summary: string
              notes: string
              changed: string
              error: string | null
              model: string
              hunks: string | null
            }
          | undefined)
      : undefined

    return (
      DiffView({
        result,
        links: row && ref ? refLinks(ref, row.to_tag, source?.repo ?? null) : undefined,
        service: row ? { stack: row.stack, service: row.service } : undefined,
        proposal: proposal
          ? {
              summary: proposal.summary,
              notes: JSON.parse(proposal.notes) as string[],
              changed: JSON.parse(proposal.changed ?? '[]') as string[],
              error: proposal.error,
              model: proposal.model,
              hunks: JSON.parse(proposal.hunks ?? '[]') as DiffHunk[],
            }
          : undefined,
      }) as string
  )
}
