import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, type Context } from 'hono'
import { raw } from 'hono/html'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configured, env, loadPolicy, inBlackout } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { scanRepo, type ScannedService } from '../compose/scan.ts'
import { buildUpdateDiff, type DiffHunk } from '../diff.ts'
import { parseImageRef } from '../images/ref.ts'
import { refLinks } from '../links.ts'
import { isScanning, scanOne } from '../scan.ts'
import { runScanNow, scheduleInfo } from '../scheduler.ts'
import { setState } from '../updates/state.ts'
import { actionsFor, refusalFor } from '../updates/actions.ts'
import { contextFor, runVerb, type VerbResult } from '../updates/verbs.ts'
import {
  inboxNeedsYou,
  inboxParked,
  inboxRecent,
  listUpdates,
  updateTimeline,
  updateView,
  type StageFilter,
  type UpdateView,
} from '../updates/queries.ts'
import {
  ActivityPage,
  InboxPage,
  RawPolicyPage,
  SettingsPage,
  StatusPage,
  ServicesPage,
  UpdatesList,
  UpdatesPage,
  type Detail,
} from './views/pages.tsx'
import { ctxString, listHref, readCtx, type ListCtx } from './ctx.ts'
import {
  DigestPreview,
  PromptEditor,
  SettingsForm,
  type SettingValue,
  type StatusData,
} from './views/ui/settings.tsx'
import { ServiceDetail, ServicesList } from './views/ui/services.tsx'
import { ActivityList, KINDS as ACTIVITY_KINDS, type ActivityRow } from './views/ui/activity.tsx'
import {
  filterServices as filterServiceRows,
  serviceDetail,
  serviceRows,
} from '../updates/services.ts'
import { setServiceLabel } from '../gitops/labels.ts'
import { InboxList, type InboxData } from './views/ui/inbox.tsx'
import { ListCount, MergePreview, ScanStatus } from './views/ui/parts.tsx'
import { UpdateDetail, UpdateRow } from './views/ui/update.tsx'
import { runPrPass } from '../gitops/pr.ts'
import { runAnalysisPass } from '../analyze/run.ts'
import { runProposePass } from '../propose/run.ts'
import { runAutoMerge } from '../gitops/automerge.ts'
import { PROMPTS, prompt, savePrompt, resetPrompt, isCustomised, type PromptName } from '../prompts/index.ts'
import { DiffView } from './views/diff.tsx'
import { mergeGate, type MergeFacts } from '../gitops/merge-gate.ts'
import { pollPrs } from '../gitops/poll.ts'
import { Octokit } from 'octokit'
import { applySettings, currentValue, SECTIONS, SETTINGS } from '../settings.ts'
import { SECTION_PROSE } from '../settings/prose.ts'
import { listModels } from '../analyze/models.ts'
import { flush as flushDigest, pending as pendingDigest, render as renderDigest } from '../notify/digest.ts'
import { activeChannels } from '../notify/index.ts'
import { configured as emailConfigured, send as sendEmail, escapeHtml as escapeText } from '../notify/email.ts'
import { rescheduleScan, rescheduleDigest } from '../scheduler.ts'
import { readFileSync as readFile } from 'node:fs'
import { paths } from '../config.ts'

const PENDING_SQL = `
  SELECT u.id, u.stack, u.service, u.image, u.from_tag, u.to_tag, u.magnitude,
         u.tier, u.state, u.detail, p.number AS pr_number,
         v.recommendation, v.confidence, p.scope AS pr_scope
  FROM updates u
  LEFT JOIN pr_updates pu ON pu.update_id = u.id
  LEFT JOIN prs p ON p.id = pu.pr_id AND p.state = 'open'
  LEFT JOIN verdicts v ON v.image = u.image AND v.from_tag = u.from_tag
                      AND v.to_tag = u.to_tag AND v.error IS NULL
  WHERE u.state IN ('detected','pr_open','held')
  ORDER BY CASE u.magnitude WHEN 'major' THEN 0 WHEN 'minor' THEN 1
                            WHEN 'patch' THEN 2 ELSE 3 END, u.stack, u.service`

/** Missing configuration, passed into every page so the banner is unmissable. */
function missing(): { name: string; why: string }[] {
  const s = configured()
  return s.ok ? [] : s.missing
}

/**
 * The facts the merge gate needs, straight from the database.
 *
 * Read here rather than passed in, because the drawer and the route both need them and
 * they must agree: the button a person sees and the check the click runs are the same
 * question asked twice, a few seconds apart.
 */
export function mergeFacts(number: number): MergeFacts {
  const db = getDb()
  const pr = db
    .prepare(`SELECT id, number, state, scope, user_owned FROM prs WHERE number = ?`)
    .get(number) as
    | { id: number; number: number; state: string; scope: string; user_owned: number }
    | undefined

  if (!pr) {
    return {
      prNumber: null,
      prState: null,
      liveMembers: 0,
      totalMembers: 0,
      scope: null,
      userOwned: false,
      recommendation: null,
      mergeable: null,
      checksFailing: false,
    }
  }

  const counts = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN u.state != 'superseded' THEN 1 ELSE 0 END) AS live
       FROM pr_updates pu JOIN updates u ON u.id = pu.update_id
       WHERE pu.pr_id = ?`,
    )
    .get(pr.id) as { total: number; live: number | null }

  // The worst verdict across the members: a group is only as safe as its least safe part.
  const worst = db
    .prepare(
      `SELECT v.recommendation FROM pr_updates pu
       JOIN updates u ON u.id = pu.update_id
       JOIN verdicts v ON v.image = u.image AND v.from_tag = u.from_tag AND v.to_tag = u.to_tag
       WHERE pu.pr_id = ? AND v.error IS NULL
       ORDER BY CASE v.recommendation WHEN 'block' THEN 0 WHEN 'caution' THEN 1 ELSE 2 END
       LIMIT 1`,
    )
    .get(pr.id) as { recommendation: string } | undefined

  return {
    prNumber: pr.number,
    prState: pr.state,
    liveMembers: counts.live ?? 0,
    totalMembers: counts.total,
    scope: pr.scope,
    userOwned: pr.user_owned === 1,
    recommendation: worst?.recommendation ?? null,
    mergeable: null,
    checksFailing: false,
  }
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
function toastHeader(c: Context, level: 'info' | 'warn' | 'error', text: string): void {
  const json = JSON.stringify({ toast: { level, text } })
  c.header(
    'HX-Trigger',
    json.replace(/[\u0080-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`),
  )
}

/** Push needs both a topic and, on a deny-all server, a token; either alone is not set up. */
function ntfyState(): 'set' | 'missing' | 'not in use' {
  if (!process.env.NTFY_URL && !process.env.NTFY_TOKEN) return 'not in use'
  return process.env.NTFY_URL && process.env.NTFY_TOPIC ? 'set' : 'missing'
}

let mergeOcto: Octokit | null = null
function gh(): Octokit {
  mergeOcto ??= new Octokit({ auth: env.githubToken })
  return mergeOcto
}

function repoParts(): { owner: string; repo: string } {
  const [owner, repo] = env.githubRepo.split('/') as [string, string]
  return { owner, repo }
}

export function createApp(): Hono {
  const app = new Hono()

  // Authelia fronts every route (T1 router), so the app itself carries no auth. The
  // health endpoint is the container healthcheck's target and is never routed publicly.
  app.get('/health', (c) => c.json({ ok: true }))

  app.use('/static/*', serveStatic({ root: './public', rewriteRequestPath: (p) => p.replace(/^\/static/, '') }))

  /**
   * The service worker, at the root.
   *
   * Scope is the reason: a worker served from /static/ can only control /static/, which
   * is useless -- it could not see the pages it exists to leave alone. Served here it
   * controls the whole origin. `Service-Worker-Allowed` is belt and braces for the same
   * thing, and `no-cache` means a corrected worker actually reaches the browser.
   */
  app.get('/sw.js', (c) => {
    c.header('Content-Type', 'application/javascript; charset=utf-8')
    c.header('Cache-Control', 'no-cache')
    c.header('Service-Worker-Allowed', '/')
    return c.body(swSource())
  })

  /** Everything a page needs to draw its own frame. */
  const chrome = (c?: Context) => ({
    paused: loadPolicy().policy.paused,
    missing: missing(),
    // `?theme=logbook` renders one page in a candidate look without changing anyone's
    // preference, so two directions can be compared on real rows.
    theme: c?.req.query('theme'),
  })

  /**
   * What the merge gate would object to, as sentences.
   *
   * These are warnings, not refusals -- the gate blocks on three facts and warns on the
   * rest -- so they belong beside the button rather than instead of it.
   */
  const mergeWarnings = (u: UpdateView): string[] => {
    if (!u.pr || u.pr.state !== 'open' || !env.githubToken) return []
    try {
      return mergeGate(mergeFacts(u.pr.number)).warnings
    } catch {
      return []
    }
  }

  /** The diff, when there is one to show. */
  const updateDiff = (id: number): unknown => {
    try {
      const html = diffFragment(id)
      return html ? raw(html) : null
    } catch {
      return null
    }
  }

  const inboxData = (): InboxData => {
    const info = scanInfo()
    return {
      needsYou: inboxNeedsYou(),
      recent: inboxRecent(24),
      parked: inboxParked(),
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

  const ctxOf = (c: Context, fallback: 'inbox' | 'updates' | 'services') =>
    readCtx((k) => c.req.query(k), fallback)

  const inboxRender = (c: Context, detail?: { id: number; d: Detail }) =>
    InboxPage({ data: inboxData(), chrome: chrome(c), selectedId: detail?.id, detail: detail?.d })

  const updatesRender = (c: Context, ctx: ListCtx, detail?: { id: number; d: Detail }) => {
    const updates = listUpdates({ stage: ctx.stage, q: ctx.q, magnitude: ctx.magnitude })
    return UpdatesPage({
      updates,
      stage: ctx.stage,
      q: ctx.q,
      magnitude: ctx.magnitude,
      ctx: ctxString({ ...ctx, list: 'updates' }),
      chrome: chrome(c),
      selectedId: detail?.id,
      detail: detail?.d,
    })
  }

  const servicesRender = (
    c: Context,
    ctx: ListCtx,
    detail?: { selected: { stack: string; service: string }; d: Detail },
  ) => {
    const services = filterServiceRows(serviceRows(), { filter: ctx.filter, q: ctx.q })
    return ServicesPage({
      services,
      filter: ctx.filter,
      q: ctx.q,
      grouped: ctx.grouped,
      ctx: ctxString({ ...ctx, list: 'services' }),
      chrome: chrome(c),
      selected: detail?.selected,
      detail: detail?.d,
    })
  }

  app.get('/', (c) => c.html(inboxRender(c) as string))

  /** The worklist alone, for the poll that runs while a scan is in flight. */
  app.get('/fragments/inbox', (c) => c.html(InboxList({ data: inboxData() }) as string))

  app.get('/updates', (c) => {
    const ctx = ctxOf(c, 'updates')
    if (c.req.header('HX-Request')) {
      const updates = listUpdates({ stage: ctx.stage, q: ctx.q, magnitude: ctx.magnitude })
      return c.html(
        (UpdatesList({ updates, ctx: ctxString({ ...ctx, list: 'updates' }) }) as string) +
          (ListCount({ n: updates.length, oob: true }) as string),
      )
    }
    return c.html(updatesRender(c, ctx) as string)
  })

  /** Kept for anything that still asks by the old name; the toolbar asks /updates. */
  app.get('/fragments/updates', (c) => {
    const ctx = ctxOf(c, 'updates')
    const updates = listUpdates({ stage: ctx.stage, q: ctx.q, magnitude: ctx.magnitude })
    return c.html(UpdatesList({ updates, ctx: ctxString({ ...ctx, list: 'updates' }) }) as string)
  })

  /** The pane's contents for one update, in the list it was opened from. */
  const updatePane = (id: number, ctx: ListCtx): { update: UpdateView; pane: unknown } | null => {
    const update = updateView(id)
    if (!update) return null
    const from = listHref(ctx)
    return {
      update,
      pane: UpdateDetail({
        update,
        milestones: updateTimeline(id),
        warnings: mergeWarnings(update),
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

  /**
   * One update, addressable.
   *
   * The old detail was an offcanvas with no URL: it could not be linked to, shared,
   * bookmarked, or closed with the back button, and a notification had nowhere in the
   * app to point at. Now it is the list page it was opened from, with the pane filled.
   */
  app.get('/updates/:id', (c) => {
    const id = Number(c.req.param('id'))
    const ctx = ctxOf(c, 'updates')
    const found = updatePane(id, ctx)
    if (!found) return c.notFound()
    const d: Detail = { pane: found.pane, title: found.update.service, back: listHref(ctx) }
    switch (ctx.list) {
      case 'inbox':
        return c.html(inboxRender(c, { id, d }) as string)
      case 'service':
      case 'services':
        return c.html(
          servicesRender(c, ctx, {
            selected: { stack: found.update.stack, service: found.update.service },
            d,
          }) as string,
        )
      default:
        return c.html(updatesRender(c, ctx, { id, d }) as string)
    }
  })

  /** The same content, for the pane beside the list on a wide screen. */
  app.get('/updates/:id/panel', (c) => {
    const id = Number(c.req.param('id'))
    const found = updatePane(id, ctxOf(c, 'updates'))
    if (!found) {
      return c.html('<p class="px-4 py-3 text-xs opacity-60">That update no longer exists.</p>')
    }
    return c.html(found.pane as string)
  })

  /** One row, for a row that is refreshing itself while a deploy runs. */
  app.get('/updates/:id/card', (c) => {
    const id = Number(c.req.param('id'))
    const update = updateView(id)
    if (!update) return c.html('')
    const ctx = ctxOf(c, 'updates')
    return c.html(
      UpdateRow({ update, ctx: ctxString(ctx), showStage: ctx.list !== 'inbox' }) as string,
    )
  })

  app.get('/services', (c) => {
    const ctx = ctxOf(c, 'services')
    if (c.req.header('HX-Request')) {
      const services = filterServiceRows(serviceRows(), { filter: ctx.filter, q: ctx.q })
      return c.html(
        (ServicesList({
          services,
          grouped: ctx.grouped,
          ctx: ctxString({ ...ctx, list: 'services' }),
        }) as string) + (ListCount({ n: services.length, oob: true }) as string),
      )
    }
    return c.html(servicesRender(c, ctx) as string)
  })

  app.get('/fragments/services', (c) => {
    const ctx = ctxOf(c, 'services')
    const services = filterServiceRows(serviceRows(), { filter: ctx.filter, q: ctx.q })
    return c.html(
      ServicesList({
        services,
        grouped: ctx.grouped,
        ctx: ctxString({ ...ctx, list: 'services' }),
      }) as string,
    )
  })

  /** The pane's contents for one service. */
  const servicePane = (stack: string, service: string, ctx: ListCtx) => {
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

  app.get('/services/:stack/:service', (c) => {
    const stack = c.req.param('stack')
    const service = c.req.param('service')
    const ctx = ctxOf(c, 'services')
    const found = servicePane(stack, service, ctx)
    if (!found) return c.notFound()
    return c.html(
      servicesRender(c, ctx, {
        selected: { stack, service },
        d: {
          pane: found.pane,
          title: service,
          back: listHref({ ...ctx, list: 'services' }),
        },
      }) as string,
    )
  })

  app.get('/services/:stack/:service/panel', (c) => {
    const found = servicePane(c.req.param('stack'), c.req.param('service'), ctxOf(c, 'services'))
    if (!found) {
      return c.html('<p class="px-4 py-3 text-xs opacity-60">That service is no longer here.</p>')
    }
    return c.html(found.pane as string)
  })

  /** Re-check one service now, rather than waiting for a sweep that takes 156 seconds. */
  app.post('/services/:stack/:service/check', async (c) => {
    const { policy } = loadPolicy()
    const stack = c.req.param('stack')
    const service = c.req.param('service')
    const svc = scanRepo(env.repoDir, policy.exclude_stacks).find(
      (s) => s.stack === stack && s.service === service,
    )
    if (svc?.watched) await scanOne(svc, policy)
    const found = servicePane(stack, service, ctxOf(c, 'services'))
    if (!found) {
      toastHeader(c, 'warn', `${stack}/${service} is no longer here`)
      return c.html('')
    }
    // The pane, whichever button asked: the row's check button targets the pane too.
    return c.html(found.pane as string)
  })

  /**
   * Change what happens to this service without you, by writing the label into its
   * compose file and committing it.
   *
   * The file in git stays the source of truth -- which is the whole reason a browser may
   * edit it at all -- so this refuses on a dirty file rather than folding a hand-edit
   * into shipshape's commit.
   */
  app.post('/services/:stack/:service/labels', async (c) => {
    const stack = c.req.param('stack')
    const service = c.req.param('service')
    const body = await c.req.parseBody()
    const key = String(body.key ?? 'policy') as 'policy' | 'watch'
    const raw = String(body.value ?? '')
    const result = await setServiceLabel({
      stack,
      service,
      key,
      value: raw === '' ? null : raw,
    })
    toastHeader(c, result.ok ? 'info' : 'warn', result.message)
    if (!c.req.header('HX-Request')) return c.redirect(`/services/${stack}/${service}`, 303)
    const found = servicePane(stack, service, ctxOf(c, 'services'))
    return c.html(found ? (found.pane as string) : '')
  })

  /** The pending region alone, so it can refresh itself while a scan runs. */
  app.post('/scan', async (c) => {
    const result = await runScanNow()
    if (result.status === 'already-running') {
      return c.html('<span class="sub">a scan is already running&hellip;</span>')
    }
    return c.html(ScanStatus({ running: isScanning(), lastAt: scanInfo().lastAt }) as string)
  })

  app.get('/scan/status', (c) =>
    c.html(ScanStatus({ running: isScanning(), lastAt: scanInfo().lastAt }) as string),
  )

  /**
   * Every operator verb answers the same way: 200, a sentence, and the update's own
   * fragment. htmx swaps nothing on a 4xx, so a refusal that returned one would look like
   * a button that did nothing -- and the honest answer to "that is no longer available"
   * is the reason, not an error page.
   */
  const verbReply = (c: Context, id: number, r: VerbResult) => {
    toastHeader(c, r.ok ? 'info' : 'warn', r.message)
    if (!c.req.header('HX-Request')) return c.redirect(`/updates/${id}`, 303)
    return c.html(updateFragment(c, id))
  }

  /**
   * What comes back from a verb: the fragment the button sat in, redrawn. `view=row`
   * means a list row -- re-rendered with its stage showing, so the change is visible in
   * place, and gone entirely from the Inbox once it no longer belongs there -- and
   * anything else means the pane.
   */
  const updateFragment = (c: Context, id: number): string => {
    const update = updateView(id)
    if (!update) return ''
    const ctx = ctxOf(c, 'updates')
    if (c.req.query('view') === 'row') {
      if (ctx.list === 'inbox' && (update.state === 'skipped' || update.state === 'superseded')) {
        return ''
      }
      return UpdateRow({ update, ctx: ctxString(ctx), showStage: true }) as string
    }
    return (updatePane(id, ctx)?.pane as string | undefined) ?? ''
  }

  /** The update a pull-request verb was pressed on: named in the query, or the PR's first. */
  const updateOfPr = (c: Context, number: number): number | null => {
    const named = Number(c.req.query('update'))
    if (Number.isFinite(named) && named > 0) return named
    const row = getDb()
      .prepare(
        `SELECT pu.update_id AS id FROM pr_updates pu JOIN prs p ON p.id = pu.pr_id
         WHERE p.number = ? ORDER BY pu.update_id LIMIT 1`,
      )
      .get(number) as { id: number } | undefined
    return row?.id ?? null
  }

  /** Not this version. A dismissal is durable: the next scan must not offer it again. */
  app.post('/updates/:id/dismiss', (c) => {
    const id = Number(c.req.param('id'))
    const found = contextFor(id)
    if (!found) return verbReply(c, id, { ok: false, message: 'that update no longer exists' })
    if (!actionsFor(found.ctx).includes('skip')) {
      return verbReply(c, id, { ok: false, message: refusalFor('skip', found.ctx) })
    }
    setState(id, 'skipped', 'dismissed')
    logEvent({
      level: 'info',
      kind: 'pr',
      stack: found.row.stack,
      service: found.row.service,
      message: `${found.row.from_tag} -> ${found.row.to_tag} dismissed by the operator`,
    })
    return verbReply(c, id, {
      ok: true,
      message: 'Skipped. It will not be offered again unless you ask for it.',
    })
  })

  /**
   * Promote a held update so the PR engine will pick it up. Held rows are the
   * datastores: their migrations are deliberate, so the PR only exists once a human
   * has decided to do one.
   */
  app.post('/updates/:id/open-pr', (c) => {
    const id = Number(c.req.param('id'))
    const found = contextFor(id)
    if (!found) return verbReply(c, id, { ok: false, message: 'that update no longer exists' })
    if (!actionsFor(found.ctx).includes('open-pr')) {
      return verbReply(c, id, { ok: false, message: refusalFor('open-pr', found.ctx) })
    }
    getDb()
      .prepare(
        `UPDATE updates SET state = 'detected', tier = 'manual', updated_at = ? WHERE id = ?`,
      )
      .run(new Date().toISOString(), id)
    logEvent({
      level: 'info',
      kind: 'pr',
      stack: found.row.stack,
      service: found.row.service,
      message: 'held update released for PR by operator',
    })
    // Ask for it now rather than at some point in the next ten minutes. The button said
    // "open a pull request"; a wait with no feedback reads as nothing having happened.
    void runPrPass().catch(() => {})
    return verbReply(c, id, { ok: true, message: 'Opening a pull request\u2026' })
  })

  /** Bring up a merge that has been waiting, run it again, put it back, or say you saw it. */
  for (const verb of ['deploy', 'redeploy', 'retry', 'rollback', 'ack'] as const) {
    app.post(`/updates/:id/${verb}`, async (c) => {
      const id = Number(c.req.param('id'))
      return verbReply(c, id, await runVerb(id, verb))
    })
  }

  /** Read the changelog again: for a review that failed, or one that never ran. */
  app.post('/updates/:id/rerun-review', (c) => {
    const id = Number(c.req.param('id'))
    const found = contextFor(id)
    if (!found) return verbReply(c, id, { ok: false, message: 'that update no longer exists' })
    if (!actionsFor(found.ctx).includes('rerun-review')) {
      return verbReply(c, id, { ok: false, message: refusalFor('rerun-review', found.ctx) })
    }
    // Clear the backoff rather than the row: the attempt count is the history of how hard
    // this changelog has been to read, and an operator asking is not attempt one.
    getDb()
      .prepare(
        `UPDATE verdicts SET next_attempt_at = NULL WHERE image = ? AND from_tag = ? AND to_tag = ?`,
      )
      .run(found.row.image, found.row.from_tag, found.row.to_tag)
    void runAnalysisPass(1).catch(() => {})
    return verbReply(c, id, { ok: true, message: 'Reading the changelog again\u2026' })
  })

  /** Draft config changes for one pull request on demand. */
  app.post('/prs/:number/propose', async (c) => {
    const number = Number(c.req.param('number'))
    const id = updateOfPr(c, number) ?? 0
    const r = await runProposePass(number)
    if (r.drafted > 0) {
      return verbReply(c, id, { ok: true, message: 'Drafted. The changes are on the pull request.' })
    }
    if (r.failed > 0) {
      return verbReply(c, id, { ok: false, message: 'Could not draft; see the activity log.' })
    }
    return verbReply(c, id, { ok: false, message: 'Nothing to draft for this pull request.' })
  })

  /** What auto-merge would do right now, decided by the code that does it. */
  /**
   * What auto-merge would do right now, decided by the code that actually does it.
   *
   * Reachable from the System page. It was an orphan endpoint for a while -- no view
   * linked to it -- which is how its markup drifted out of step with everything else.
   */
  /**
   * Merge a pull request from here, rather than from GitHub.
   *
   * The whole point of the drawer is that everything needed to decide is already on
   * screen -- the diff, the verdict, the links. Sending someone to GitHub to press a
   * button, and then waiting for shipshape to notice, was the last step that left the
   * page for no reason.
   *
   * Deliberately narrow. It merges and then closes the loop, and does nothing else: it
   * writes no pull request state of its own, because `onMerged` is the only thing that
   * may do that. Marking the row merged here would drop it out of the `state = 'open'`
   * query that `onMerged` selects on, and the merge would be recorded with no commit
   * sha, no updates marked, no deploy queued, and no way to ever notice again -- the
   * exact permanent loss the deploy queue was written to eliminate.
   */
  app.post('/prs/:number/merge', async (c) => {
    const number = Number(c.req.param('number'))
    const force = c.req.query('force') === '1'
    const { policy } = loadPolicy()
    const id = updateOfPr(c, number) ?? 0
    const refuse = (message: string) => verbReply(c, id, { ok: false, message })

    const facts = mergeFacts(number)
    let gate = mergeGate(facts, { force })
    if (!gate.allowed) return refuse(gate.blocked ?? 'the merge gate refused')

    try {
      const { owner, repo } = repoParts()
      const live = await gh().rest.pulls.get({ owner, repo, pull_number: number })
      if (live.data.merged) return refuse(`#${number} has already been merged.`)
      // GitHub's own answer beats ours: it knows about conflicts and branch protection.
      gate = mergeGate({ ...facts, mergeable: live.data.mergeable }, { force })
      if (!gate.allowed) return refuse(gate.blocked ?? 'the merge gate refused')
      if (gate.needsForce) return refuse(gate.warnings.join('; '))

      await gh().rest.pulls.merge({
        owner,
        repo,
        pull_number: number,
        merge_method: policy.merge_method,
      })

      // Recorded as an override when policy would have refused, so the decision is
      // legible afterwards rather than indistinguishable from an automatic merge.
      logEvent({
        level: gate.warnings.length > 0 ? 'warn' : 'info',
        kind: 'pr',
        message: `#${number} merged from the dashboard`,
        detail: gate.warnings.length > 0 ? gate.warnings.join('; ') : 'no objections',
      })
    } catch (err) {
      const msg = (err as Error).message.slice(0, 200)
      return refuse(`GitHub refused the merge: ${msg}`)
    }

    // Close the loop now rather than waiting for the next tick: this is what captures
    // the commit sha, marks the updates, syncs the checkout and queues the deploy.
    // Never let a failure here report a merge that did land as a failure.
    try {
      await pollPrs()
    } catch {
      /* the scheduler will pick it up on its next pass */
    }

    return verbReply(c, id, {
      ok: true,
      message: policy.paused
        ? 'Merged. Ready to deploy \u2014 press Deploy when you are.'
        : 'Merged. The deploy is running and will be verified.',
    })
  })

  app.get('/merge/preview', async (c) => {
    const r = await runAutoMerge(true)
    const { policy } = loadPolicy()
    return c.html(MergePreview({ decisions: r.decisions, paused: policy.paused }) as string)
  })

  /**
   * The log, ordered by when a line was last seen rather than first written.
   *
   * A repeated message is one row with a count, so a fact that recurred all afternoon
   * sorts by the afternoon and not by the morning it started.
   */
  const activityRows = (opts: {
    kind: string
    problems: boolean
    q: string
    before?: string | null
    limit?: number
  }): ActivityRow[] => {
    const where: string[] = []
    const args: (string | number)[] = []
    if ((ACTIVITY_KINDS as readonly string[]).includes(opts.kind)) {
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

  const activityQuery = (c: Context) => ({
    kind: c.req.query('kind') ?? 'all',
    problems: c.req.query('level') === 'problems',
    q: c.req.query('q') ?? '',
  })

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

  app.get('/activity', (c) => {
    const query = activityQuery(c)
    const rows = activityRows(query)
    if (c.req.header('HX-Request')) {
      return c.html(
        ActivityList({ rows, repo: env.githubRepo, more: moreLink(c, rows) }) as string,
      )
    }
    return c.html(
      ActivityPage({
        rows,
        repo: env.githubRepo,
        more: moreLink(c, rows),
        ...query,
        chrome: chrome(c),
      }) as string,
    )
  })

  app.get('/fragments/activity', (c) => {
    const rows = activityRows({ ...activityQuery(c), before: c.req.query('before') })
    return c.html(ActivityList({ rows, repo: env.githubRepo, more: moreLink(c, rows) }) as string)
  })

  /** One prompt editor, rendered the same way whether saved, reset, or first shown. */
  const promptEditor = (name: PromptName) =>
    PromptEditor({
      name,
      title: PROMPTS[name].title,
      help: PROMPTS[name].help,
      text: prompt(name),
      customised: isCustomised(name),
    })

  const promptStates = () =>
    (Object.keys(PROMPTS) as PromptName[]).map((name) => ({
      name,
      body: prompt(name),
      customised: isCustomised(name),
    }))

  /**
   * The settings, split by whether getting one wrong changes what shipshape may do.
   *
   * Fourteen decisions are visible; the remaining twenty-one are tuning and live behind
   * Advanced with their defaults. The distinction is not how obscure a key is -- it is
   * whether it moves the line between what happens on its own and what waits for you.
   */
  const settingGroups = (advanced: boolean) => {
    const { policy } = loadPolicy()
    const groups: { title: string; prose?: string[]; items: SettingValue[] }[] = []
    for (const [title] of SECTIONS) {
      const items = SETTINGS.filter(
        (d) => d.section === title && !!d.advanced === advanced,
      ).map((def) => ({
        def,
        value: currentValue(policy, def.path),
        changed: currentValue(policy, def.path) !== def.defaultValue,
      }))
      // The prose belongs with the decisions. On Advanced these are tuning knobs whose
      // own `about` text is the explanation, and repeating the section essay there would
      // bury them.
      if (items.length > 0) {
        groups.push({ title, prose: advanced ? undefined : SECTION_PROSE[title], items })
      }
    }
    return groups
  }

  /** What the machine is doing and what it has spent, for the Status tab. */
  const statusData = (): StatusData => {
    const { policy } = loadPolicy()
    const db = getDb()
    const info = scanInfo()
    const sched = scheduleInfo()
    const month = new Date().toISOString().slice(0, 7)
    const spend = db
      .prepare(
        `SELECT model, purpose, COUNT(*) AS calls, SUM(cost_usd) AS cost
           FROM llm_calls WHERE created_at LIKE ? GROUP BY model, purpose ORDER BY cost DESC`,
      )
      .all(`${month}%`) as { model: string; purpose: string; calls: number; cost: number }[]
    const spent = (
      db
        .prepare(`SELECT value FROM budgets WHERE key = 'claude.spend_usd' AND window = ?`)
        .get(month) as { value: number } | undefined
    )?.value

    return {
      version: readPackageVersion(),
      repoDir: env.repoDir,
      repo: env.githubRepo,
      mergeMethod: policy.merge_method,
      pushMain: policy.sync.push_main,
      blackout: policy.sync.blackout,
      scan: {
        cron: sched.scan.cron,
        lastAt: info.lastAt,
        nextAt: sched.scan.nextAt,
        durationS: info.durationS,
      },
      digest: { cron: sched.digest.cron, nextAt: sched.digest.nextAt },
      credentials: [
        { name: 'GITHUB_TOKEN', state: env.githubToken ? 'set' : 'missing' },
        { name: 'ANTHROPIC_API_KEY', state: env.anthropicApiKey ? 'set' : 'missing' },
        { name: 'NTFY_URL + NTFY_TOKEN', state: ntfyState() },
        { name: 'SMTP_URL + MAIL_TO', state: emailConfigured() ? 'set' : 'not in use' },
        { name: 'DOCKER_HUB_LOGIN', state: process.env.DOCKER_HUB_LOGIN ? 'set' : 'not in use' },
      ],
      spend: spend.map((s) => ({ ...s, cost: s.cost ?? 0 })),
      budgetUsd: policy.claude.monthly_budget_usd,
      spentUsd: spent ?? 0,
      deploys: db
        .prepare(
          `SELECT COALESCE(finished_at, started_at, created_at) AS at, stack, services, status, trigger
             FROM deploys ORDER BY id DESC LIMIT 12`,
        )
        .all() as StatusData['deploys'],
      budgets: db
        .prepare(`SELECT key, value, window FROM budgets ORDER BY key`)
        .all() as StatusData['budgets'],
      sandbox: !!process.env.SHIPSHAPE_UI_DEV,
    }
  }

  /** Merged updates that will not move until someone presses Deploy. */
  const readyToDeploy = (): number =>
    (
      getDb()
        .prepare(`SELECT COUNT(*) AS n FROM deploys WHERE status IN ('ready','pending')`)
        .get() as { n: number }
    ).n

  app.get('/settings', async (c) =>
    c.html(
      SettingsPage({
        tab: 'general',
        groups: settingGroups(false),
        models: await listModels(),
        readyCount: loadPolicy().policy.paused ? readyToDeploy() : 0,
        chrome: chrome(c),
      }) as string,
    ),
  )

  app.get('/settings/advanced', async (c) =>
    c.html(
      SettingsPage({
        tab: 'advanced',
        groups: settingGroups(true),
        models: await listModels(),
        // The prompts are tuning of the same kind: rarely the answer, and dangerous to
        // reach for first. They were a tab of their own, which oversold them.
        extra: promptStates().map((st) => promptEditor(st.name)),
        extraNav: promptStates().map((st) => ({
          href: `#prompt-${st.name}`,
          label: PROMPTS[st.name].title,
        })),
        chrome: chrome(c),
      }) as string,
    ),
  )

  app.get('/settings/status', (c) => c.html(StatusPage({ data: statusData(), chrome: chrome(c) }) as string))

  app.post('/settings/prompt/:name', async (c) => {
    const name = c.req.param('name') as PromptName
    if (!(name in PROMPTS)) return c.text('unknown prompt', 404)
    const form = await c.req.parseBody()
    savePrompt(name, typeof form.text === 'string' ? form.text : '')
    return c.html(promptEditor(name) as string)
  })

  app.post('/settings/prompt/:name/reset', (c) => {
    const name = c.req.param('name') as PromptName
    if (!(name in PROMPTS)) return c.text('unknown prompt', 404)
    resetPrompt(name)
    return c.html(promptEditor(name) as string)
  })

  app.post('/settings', async (c) => {
    const form = await c.req.parseBody()
    const changes: Record<string, string> = {}
    for (const def of SETTINGS) {
      const v = form[def.path]
      if (typeof v === 'string') changes[def.path] = v
    }
    const result = applySettings(changes)
    // A schedule change should not wait for the old schedule to fire before applying.
    if (result.ok && result.applied.includes('scan.cron')) rescheduleScan()
    if (result.ok && result.applied.includes('notify.cron')) rescheduleDigest()
    const advanced = c.req.path.endsWith('/advanced')
    return c.html(
      SettingsForm({
        groups: settingGroups(advanced),
        models: await listModels(),
        advanced,
        readyCount: loadPolicy().policy.paused ? readyToDeploy() : 0,
        banner: result.ok
          ? result.applied.length
            ? { level: 'info', text: `Saved: ${result.applied.join(', ')}. Committed to git.` }
            : null
          : { level: 'error', text: result.errors.join(' ') },
      }) as string,
    )
  })

  // The same handler: which page it came from decides which half of the settings it can
  // write, so a save on one tab cannot silently reset the other.
  app.post('/settings/advanced', async (c) => app.fetch(new Request(new URL('/settings', c.req.url), c.req.raw)))

  /**
   * What the next digest would say, and a way to send it now.
   *
   * A batched notification is invisible until it fires, which makes it hard to trust and
   * hard to tune -- so the exact message is renderable on demand, by the same code that
   * sends it.
   */
  app.get('/settings/digest', (c) => {
    const rows = pendingDigest()
    const message = renderDigest(rows)
    return c.html(
      DigestPreview({
        title: message?.title ?? null,
        body: message?.body ?? null,
        count: rows.length,
      }) as string,
    )
  })

  app.post('/settings/digest/send', async (c) => {
    const r = await flushDigest('manual')
    return c.html(
      r.sent > 0
        ? `<span class="sub">sent ${r.sent} item(s)</span>`
        : `<span class="sub">${r.skipped ?? 'nothing to send'}</span>`,
    )
  })

  /**
   * Prove the mail path end to end.
   *
   * SMTP is the one piece of this that fails silently and for reasons nothing else can
   * observe -- a wrong port, a relay that refuses the sender, TLS that only works on 465.
   * A button that reports the server's own error beats reading logs after the fact.
   */
  app.post('/settings/email/test', async (c) => {
    if (!emailConfigured()) {
      return c.html(
        '<span class="sub">SMTP_URL and MAIL_TO are not both set — nothing to test.</span>',
      )
    }
    const r = await sendEmail({
      subject: 'shipshape: test message',
      text: 'If you are reading this, shipshape can send you email.\n\nSent from the Settings page.',
    })
    return c.html(
      r.ok
        ? '<span class="sub">sent — check the inbox</span>'
        : `<span class="warn-text">${escapeText(r.error ?? 'failed')}</span>`,
    )
  })


  app.get('/settings/raw', (c) => {
    let text: string
    try {
      text = readFile(paths.policy, 'utf8')
    } catch (err) {
      text = `policy.yaml could not be read: ${(err as Error).message}`
    }
    return c.html(RawPolicyPage({ text, chrome: chrome(c) }) as string)
  })

  // Old addresses, kept as redirects: a bookmark or a link in a months-old digest
  // should land on the page that replaced it rather than a 404.
  app.get('/system', (c) => c.redirect('/settings/status', 301))
  app.get('/images', (c) => c.redirect('/services', 301))


  return app
}

/** Read once: the file cannot change without the container restarting. */
let swCache: string | null = null

function swSource(): string {
  if (swCache === null) {
    try {
      swCache = readFileSync(join('./public', 'sw.js'), 'utf8')
    } catch {
      // Serving an empty worker is safe -- no fetch handler means no interception.
      swCache = ''
    }
  }
  return swCache
}

/**
 * The diff fragment, built once and shared by /updates/:id/diff and the drawer.
 *
 * Two endpoints rendering the same panel is exactly how the two drift, and this one
 * carries the proposal block and the reference links -- the parts a reviewer reads.
 */
function diffFragment(id: number): string {

        const result = buildUpdateDiff(id)
    const db = getDb()
    const pr = db
      .prepare(
        `SELECT p.number, p.scope FROM prs p JOIN pr_updates pu ON pu.pr_id = p.id
         WHERE pu.update_id = ? AND p.state = 'open'`,
      )
      .get(id) as { number: number; scope: string } | undefined

    // Links point at the TARGET tag: this panel is where the merge decision happens.
    const row = db
      .prepare(
        `SELECT u.image, u.to_tag, r.source_url FROM updates u
         JOIN images i ON i.stack = u.stack AND i.service = u.service
         LEFT JOIN resolutions r ON r.registry = i.registry AND r.repository = i.repository
         WHERE u.id = ?`,
      )
      .get(id) as { image: string; to_tag: string; source_url: string | null } | undefined

    const proposal = pr
      ? (db
          .prepare(
            `SELECT summary, notes, changed, error, model, hunks FROM proposals
             WHERE pr_id = (SELECT id FROM prs WHERE number = ?) ORDER BY id DESC LIMIT 1`,
          )
          .get(pr.number) as
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
        links: row ? refLinks(parseImageRef(row.image), row.to_tag, row.source_url) : undefined,
        prNumber: pr?.number ?? null,
        prUrl: pr ? `https://github.com/${env.githubRepo}/pull/${pr.number}` : null,
        prScope: pr?.scope ?? null,
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
        canPropose: !!pr && pr.scope === 'tag-only',
      }) as string
  )
}

interface ScanInfo {
  lastAt: string | null
  durationS: number | null
  counts: Record<string, number> | null
  running: boolean
}

function scanInfo(): ScanInfo {
  const rows = getDb()
    .prepare(`SELECT key, value, window FROM budgets WHERE key LIKE 'scan.%'`)
    .all() as { key: string; value: number; window: string | null }[]
  const by = new Map(rows.map((r) => [r.key, r]))
  const lastAt = by.get('scan.last_at')?.window ?? null
  const durationS = by.get('scan.last_duration_s')?.value ?? null
  let counts: Record<string, number> | null = null
  const raw = by.get('scan.last_counts')?.window
  if (raw) {
    try {
      counts = JSON.parse(raw) as Record<string, number>
    } catch {
      counts = null
    }
  }
  return { lastAt, durationS, counts, running: isScanning() }
}

function readPackageVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as
      { version: string }).version
  } catch {
    return 'unknown'
  }
}

export function startServer(): void {
  const app = createApp()
  serve({ fetch: app.fetch, port: env.port }, (info) => {
    console.log(`[system] shipshape listening on :${info.port}`)
  })
}
