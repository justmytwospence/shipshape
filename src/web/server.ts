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
  DocsPage,
  InboxPage,
  PromptsPage,
  RawPolicyPage,
  SettingsPage,
  StatusPage,
  ServicePage,
  ServicesPage,
  UpdatePage,
  UpdatesList,
  UpdatesPage,
} from './views/pages.tsx'
import {
  DigestPreview,
  PromptEditor,
  SettingsForm,
  type SettingValue,
  type StatusData,
} from './views/ui/settings.tsx'
import { Docs } from './views/ui/docs.tsx'
import { ServiceDetail, ServicesList } from './views/ui/services.tsx'
import { ActivityList, KINDS as ACTIVITY_KINDS, type ActivityRow } from './views/ui/activity.tsx'
import {
  filterServices as filterServiceRows,
  serviceDetail,
  serviceRows,
} from '../updates/services.ts'
import { setServiceLabel } from '../gitops/labels.ts'
import { InboxBody, type InboxData } from './views/ui/inbox.tsx'
import { MergePreview, ScanStatus } from './views/ui/parts.tsx'
import { UpdateCard, UpdateDetail } from './views/ui/update.tsx'
import { runPrPass } from '../gitops/pr.ts'
import { runAnalysisPass } from '../analyze/run.ts'
import { runProposePass } from '../propose/run.ts'
import { runAutoMerge } from '../gitops/automerge.ts'
import { PROMPTS, prompt, savePrompt, resetPrompt, isCustomised, type PromptName } from '../prompts/index.ts'
import { DiffView, DetailPanel, MergeBar, type DetailRow } from './views/diff.tsx'
import { mergeGate, type MergeFacts } from '../gitops/merge-gate.ts'
import { pollPrs } from '../gitops/poll.ts'
import { Octokit } from 'octokit'
import { applySettings, currentValue, SECTIONS, SETTINGS } from '../settings.ts'
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

/** A plain sentence where the button was. Always 200: htmx swaps nothing on a 4xx. */
function noteBar(number: number, text: string, warn = false): string {
  const cls = warn ? 'diff-note warn-text' : 'diff-note'
  return `<div class="mergebar" id="mergebar-${number}"><p class="${cls}">${escapeText(text)}</p></div>`
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

  app.get('/', (c) => c.html(InboxPage({ data: inboxData(), chrome: chrome(c) }) as string))

  /** The worklist alone, for the poll that runs while a scan is in flight. */
  app.get('/fragments/inbox', (c) => c.html(InboxBody({ data: inboxData() }) as string))

  app.get('/updates', (c) => {
    const stage = (c.req.query('stage') ?? 'open') as StageFilter
    const q = c.req.query('q') ?? ''
    const updates = listUpdates({ stage, q })
    if (c.req.header('HX-Request')) {
      return c.html(UpdatesList({ updates, twoPane: true }) as string)
    }
    return c.html(UpdatesPage({ updates, stage, q, chrome: chrome(c) }) as string)
  })

  app.get('/fragments/updates', (c) => {
    const stage = (c.req.query('stage') ?? 'open') as StageFilter
    const q = c.req.query('q') ?? ''
    return c.html(UpdatesList({ updates: listUpdates({ stage, q }), twoPane: true }) as string)
  })

  /**
   * One update, addressable.
   *
   * The old detail was an offcanvas with no URL: it could not be linked to, shared,
   * bookmarked, or closed with the back button, and a notification had nowhere in the
   * app to point at.
   */
  app.get('/updates/:id', (c) => {
    const id = Number(c.req.param('id'))
    const update = updateView(id)
    if (!update) return c.notFound()
    return c.html(
      UpdatePage({
        update,
        milestones: updateTimeline(id),
        warnings: mergeWarnings(update),
        diff: updateDiff(id),
        chrome: chrome(c),
      }) as string,
    )
  })

  /** The same content, for the panel beside the list on a wide screen. */
  app.get('/updates/:id/panel', (c) => {
    const id = Number(c.req.param('id'))
    const update = updateView(id)
    if (!update) {
      return c.html('<p class="text-sm opacity-60">That update no longer exists.</p>')
    }
    return c.html(
      UpdateDetail({
        update,
        milestones: updateTimeline(id),
        warnings: mergeWarnings(update),
        diff: updateDiff(id),
      }) as string,
    )
  })

  app.get('/services', (c) => {
    const filter = c.req.query('filter') ?? 'all'
    const q = c.req.query('q') ?? ''
    const grouped = c.req.query('group') === 'stack'
    const services = filterServiceRows(serviceRows(), { filter, q })
    if (c.req.header('HX-Request')) {
      return c.html(ServicesList({ services, grouped }) as string)
    }
    return c.html(ServicesPage({ services, filter, q, grouped, chrome: chrome(c) }) as string)
  })

  app.get('/fragments/services', (c) => {
    const services = filterServiceRows(serviceRows(), {
      filter: c.req.query('filter') ?? 'all',
      q: c.req.query('q') ?? '',
    })
    return c.html(ServicesList({ services, grouped: c.req.query('group') === 'stack' }) as string)
  })

  app.get('/services/:stack/:service', (c) => {
    const data = serviceDetail(c.req.param('stack'), c.req.param('service'))
    if (!data) return c.notFound()
    return c.html(ServicePage({ data, chrome: chrome(c) }) as string)
  })

  app.get('/services/:stack/:service/panel', (c) => {
    const data = serviceDetail(c.req.param('stack'), c.req.param('service'))
    if (!data) return c.html('<p class="text-sm opacity-60">That service is no longer here.</p>')
    return c.html(ServiceDetail({ data }) as string)
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
    const data = serviceDetail(stack, service)
    if (!data) {
      c.header(
        'HX-Trigger',
        JSON.stringify({ toast: { level: 'warn', text: `${stack}/${service} is no longer here` } }),
      )
      return c.html('')
    }
    // The card, not the row: this comes back into either, and the card is the superset.
    return c.html(ServiceDetail({ data }) as string)
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
    c.header(
      'HX-Trigger',
      JSON.stringify({ toast: { level: result.ok ? 'info' : 'warn', text: result.message } }),
    )
    if (!c.req.header('HX-Request')) return c.redirect(`/services/${stack}/${service}`, 303)
    const data = serviceDetail(stack, service)
    return c.html(data ? (ServiceDetail({ data }) as string) : '')
  })

  /** One card, for a row that is refreshing itself while a deploy runs. */
  app.get('/updates/:id/card', (c) => {
    const id = Number(c.req.param('id'))
    const update = updateView(id)
    if (!update) return c.html('')
    return c.html(UpdateCard({ update }) as string)
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
    c.header(
      'HX-Trigger',
      JSON.stringify({ toast: { level: r.ok ? 'info' : 'warn', text: r.message } }),
    )
    if (!c.req.header('HX-Request')) return c.redirect(`/updates/${id}`, 303)
    return c.html(noteBar(id, r.message, !r.ok))
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
    const r = await runProposePass(number)
    if (r.drafted > 0) {
      return c.html('<span class="sub">drafted — reload to see the changes</span>')
    }
    if (r.failed > 0) return c.html('<span class="sub">could not draft; see the activity log</span>')
    return c.html('<span class="sub">nothing to draft for this pull request</span>')
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

    const facts = mergeFacts(number)
    let gate = mergeGate(facts, { force })
    if (!gate.allowed) return c.html(MergeBar({ number, gate }) as string)

    try {
      const { owner, repo } = repoParts()
      const live = await gh().rest.pulls.get({ owner, repo, pull_number: number })
      if (live.data.merged) {
        return c.html(noteBar(number, `#${number} has already been merged.`))
      }
      // GitHub's own answer beats ours: it knows about conflicts and branch protection.
      gate = mergeGate({ ...facts, mergeable: live.data.mergeable }, { force })
      if (!gate.allowed) return c.html(MergeBar({ number, gate }) as string)
      if (gate.needsForce) return c.html(MergeBar({ number, gate }) as string)

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
      return c.html(noteBar(number, `GitHub refused the merge: ${msg}`, true))
    }

    // Close the loop now rather than waiting for the next tick: this is what captures
    // the commit sha, marks the updates, syncs the checkout and queues the deploy.
    // Never let a failure here report a merge that did land as a failure.
    try {
      await pollPrs()
    } catch {
      /* the scheduler will pick it up on its next pass */
    }

    return c.html(
      noteBar(
        number,
        policy.paused
          ? `Merged. Ready to deploy — press Deploy when you are.`
          : `Merged. The deploy is running and will be verified.`,
      ),
    )
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
    const groups: { title: string; blurb?: string; items: SettingValue[] }[] = []
    for (const [title, blurb] of SECTIONS) {
      const items = SETTINGS.filter(
        (d) => d.section === title && !!d.advanced === advanced,
      ).map((def) => ({
        def,
        value: currentValue(policy, def.path),
        changed: currentValue(policy, def.path) !== def.defaultValue,
      }))
      if (items.length > 0) groups.push({ title, blurb: advanced ? undefined : blurb, items })
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
        { name: 'NTFY_TOKEN', state: process.env.NTFY_URL ? 'set' : 'not in use' },
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
        chrome: chrome(c),
      }) as string,
    ),
  )

  app.get('/settings/status', (c) => c.html(StatusPage({ data: statusData(), chrome: chrome(c) }) as string))

  app.get('/settings/prompts', (c) =>
    c.html(
      PromptsPage({
        // Called rather than written as JSX: this module is .ts, and the components
        // return nodes either way.
        editors: promptStates().map((s) => promptEditor(s.name)),
        chrome: chrome(c),
      }) as string,
    ),
  )

  app.get('/docs', (c) => c.html(DocsPage({ sections: Docs({}), chrome: chrome(c) }) as string))

  /** Prompts live in the database, not policy.yaml -- saved and reset on their own. */
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
