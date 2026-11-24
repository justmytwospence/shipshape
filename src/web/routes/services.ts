import type { Hono } from 'hono'
import { loadPolicy } from '../../config.ts'
import { env } from '../../env.ts'
import { scanRepo } from '../../compose/scan.ts'
import { checkService } from '../../scan/index.ts'
import { refreshServiceLabels } from '../../scan/inventory.ts'
import { sourceFor } from '../../resolver/index.ts'
import type { SourceInfo } from '../../resolver/types.ts'
import { ctxString, listHref } from '../ctx.ts'
import { LinkPreviewPane, ServicesList } from '../views/ui/services.tsx'
import { filterServices as filterServiceRows, serviceRows } from '../../updates/services.ts'
import {
  publishLabelEdits,
  setLabelsForServices,
  setServiceLabels,
  type LabelChange,
  type LabelKey,
} from '../../gitops/labels.ts'
import { previewLink } from '../../resolver/preview.ts'
import { ListCount } from '../views/ui/parts.tsx'
import { ctxOf, servicePane, servicesRender, toastHeader } from '../render.ts'

/** The labels a browser may write. */
const LABEL_KEYS = ['class', 'watch', 'source', 'changelog'] as const

/** A promise's value, its error, or 'timeout' once `ms` have passed -- whichever comes first. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | Error | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms)
  })
  try {
    return await Promise.race([
      p.catch((err: unknown) => (err instanceof Error ? err : new Error(String(err)))),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** What "Look again" found, as the sentence its toast says. */
function lookedAgain(s: SourceInfo): string {
  const found = s.inferred?.repo
  if (!found) {
    if (s.error) return `Could not look it up: ${s.error}`
    return s.packagingRepo
      ? `No upstream repository found. ${s.packagingRepo} packages it, and has only container changes.`
      : 'No upstream repository found.'
  }
  const likely = s.inferred?.confidence === 'high' ? '' : ', a likely match'
  const label =
    s.label && s.label.repo.toLowerCase() !== found.toLowerCase()
      ? ` Its shipshape.source label, ${s.label.repo}, still decides.`
      : ''
  return `Found ${found}${likely}.${label}`
}

/** The Services list, one service, and what may be written to its labels. */
export function registerServiceRoutes(app: Hono): void {
  app.get('/services', (c) => {
    const ctx = ctxOf(c, 'services')
    if (c.req.header('HX-Request')) {
      const all = serviceRows()
      const services = filterServiceRows(all, { filter: ctx.filter, q: ctx.q })
      return c.html(
        (ServicesList({
          services,
          total: all.length,
          filter: ctx.filter,
          q: ctx.q,
          grouped: ctx.grouped,
          ctx: ctxString({ ...ctx, list: 'services' }),
        }) as string) + (ListCount({ n: services.length, oob: true }) as string),
      )
    }
    return c.html(servicesRender(c, ctx) as string)
  })

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
    const stack = c.req.param('stack')
    const service = c.req.param('service')
    await checkService(stack, service)
    const found = servicePane(stack, service, ctxOf(c, 'services'))
    if (!found) {
      toastHeader(c, 'warn', `${stack}/${service} is no longer here`)
      return c.html('')
    }
    // The pane, whichever button asked: the row's check button targets the pane too.
    return c.html(found.pane as string)
  })

  /**
   * Look again for the repository this service's image comes from, now, spending what that
   * takes -- the Docker Hub manifest walk included. A label does not stop it: the pane shows
   * what was found underneath. The answer is waited on for 30 seconds; a slower one carries on
   * and shows the next time the pane loads.
   */
  app.post('/services/:stack/:service/resolve', async (c) => {
    const { policy } = loadPolicy()
    const stack = c.req.param('stack')
    const service = c.req.param('service')
    const svc = scanRepo(env.repoDir, policy.exclude_stacks).find((s) => s.stack === stack && s.service === service)
    if (!svc?.ref) {
      toastHeader(c, 'warn', `${stack}/${service} has no image to look up`)
    } else {
      const look = sourceFor(
        { registry: svc.ref.registry, repository: svc.ref.repository },
        { service: { stack, service }, ownLabel: svc.sourceLabel, force: true, allowBilled: true },
      )
      const outcome = await within(look, 30_000)
      if (outcome === 'timeout') toastHeader(c, 'info', 'Still looking. The answer will show here when it arrives.')
      else if (outcome instanceof Error) toastHeader(c, 'warn', `Could not look: ${outcome.message}`)
      else toastHeader(c, outcome.inferred?.repo || !outcome.error ? 'info' : 'warn', lookedAgain(outcome))
    }
    if (!c.req.header('HX-Request')) return c.redirect(`/services/${stack}/${service}`, 303)
    const found = servicePane(stack, service, ctxOf(c, 'services'))
    return c.html(found ? (found.pane as string) : '')
  })

  /**
   * What a repository or notes link would give this service, before anything is written. The
   * write form comes back inside this fragment, so what is written is what was shown. Capped at
   * 15 seconds, and always a 200: htmx swaps nothing on an error.
   */
  app.get('/services/:stack/:service/link/preview', async (c) => {
    const { policy } = loadPolicy()
    const stack = c.req.param('stack')
    const service = c.req.param('service')
    const svc = scanRepo(env.repoDir, policy.exclude_stacks).find((s) => s.stack === stack && s.service === service)
    if (!svc) return c.html(LinkPreviewPane({ failure: `${stack}/${service} is no longer here.` }) as string)
    const outcome = await within(
      previewLink({
        stack,
        service,
        source: c.req.query('source') ?? '',
        changelog: c.req.query('changelog') ?? '',
        current: { source: svc.sourceLabel, changelog: svc.changelogLabel },
      }),
      15_000,
    )
    if (outcome === 'timeout') {
      return c.html(
        LinkPreviewPane({ failure: 'Checking the link took longer than 15 seconds. Try again in a moment.' }) as string,
      )
    }
    if (outcome instanceof Error) {
      return c.html(LinkPreviewPane({ failure: `Could not check the link: ${outcome.message}` }) as string)
    }
    return c.html(LinkPreviewPane({ preview: outcome, ctx: ctxString(ctxOf(c, 'services')) }) as string)
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
    const changes: LabelChange[] = []
    if (body.link !== undefined) {
      // From the link dialog's preview: the repository and the notes link, whichever it sent,
      // in one commit.
      for (const key of ['source', 'changelog'] as const) {
        if (body[key] === undefined) continue
        const value = String(body[key]).trim()
        changes.push({ key, value: value === '' ? null : value })
      }
    } else {
      const key = String(body.key ?? 'class')
      if (!(LABEL_KEYS as readonly string[]).includes(key)) {
        toastHeader(c, 'warn', `shipshape does not write a "${key}" label.`)
        if (!c.req.header('HX-Request')) return c.redirect(`/services/${stack}/${service}`, 303)
        const found = servicePane(stack, service, ctxOf(c, 'services'))
        return c.html(found ? (found.pane as string) : '')
      }
      const raw = String(body.value ?? '')
      changes.push({ key: key as LabelKey, value: raw === '' ? null : raw })
    }
    const result = await setServiceLabels({ stack, service, changes })
    // The labels module leaves the images table to its caller, and nothing refreshed it, so
    // the pane answered from the last scan until the next one. Refresh this service's row.
    if (result.ok) refreshServiceLabels(stack, service)
    toastHeader(c, result.ok ? 'info' : 'warn', result.message)
    if (!c.req.header('HX-Request')) return c.redirect(`/services/${stack}/${service}`, 303)
    const found = servicePane(stack, service, ctxOf(c, 'services'))
    return c.html(found ? (found.pane as string) : '')
  })

  /**
   * Watch every service the Not watched filter shows (with its search), one commit per
   * compose file. Answers with the list as the filter now sees it.
   */
  app.post('/services/watch', async (c) => {
    const q = String((await c.req.parseBody()).q ?? '')
    const targets = filterServiceRows(serviceRows(), { filter: 'unwatched', q })
    if (targets.length === 0) {
      toastHeader(c, 'warn', 'Nothing to watch: every service shown is already watched or cannot be.')
    } else {
      const groups = new Map<string, { stack: string; services: string[] }>()
      for (const t of targets) {
        const key = `${t.stack}\0${t.composeFile ?? ''}`
        const g = groups.get(key) ?? { stack: t.stack, services: [] }
        g.services.push(t.service)
        groups.set(key, g)
      }
      let okCount = 0
      let okCommits = 0
      const failures: { stack: string; message: string }[] = []
      for (const g of groups.values()) {
        const r = await setLabelsForServices({
          stack: g.stack,
          services: g.services,
          changes: [{ key: 'watch', value: 'true' }],
          publish: false,
        })
        if (r.ok) {
          okCount += g.services.length
          okCommits++
          for (const s of g.services) refreshServiceLabels(g.stack, s)
        } else {
          failures.push({ stack: g.stack, message: r.message.slice(0, 120) })
        }
      }
      const n = targets.length
      const publishNote = okCommits > 0 ? await publishLabelEdits() : ''
      toastHeader(
        c,
        failures.length ? 'warn' : 'info',
        failures.length
          ? `Watching ${okCount} of ${n}. Not written: ${failures.map((f) => `${f.stack} (${f.message})`).join('; ')}`
          : `Watching ${n} ${n === 1 ? 'service' : 'services'}, in ${okCommits} ${okCommits === 1 ? 'commit' : 'commits'}.${publishNote}`,
      )
    }
    if (!c.req.header('HX-Request')) return c.redirect('/services?filter=unwatched', 303)
    const all = serviceRows()
    const services = filterServiceRows(all, { filter: 'unwatched', q })
    return c.html(
      (ServicesList({
        services,
        grouped: false,
        ctx: ctxString({ ...ctxOf(c, 'services'), filter: 'unwatched', q, list: 'services' }),
        total: all.length,
        filter: 'unwatched',
        q,
      }) as string) + (ListCount({ n: services.length, oob: true }) as string),
    )
  })
}
