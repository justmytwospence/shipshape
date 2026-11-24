import type { Context, Hono } from 'hono'
import type { VerbResult } from '../../updates/verbs.ts'
import { runOperatorVerb } from '../../updates/operator-verbs.ts'
import { listUpdates, listReleases } from '../../updates/queries.ts'
import { updateView } from '../../updates/view.ts'
import { UpdatesList, type Detail } from '../views/pages.tsx'
import { ctxString, listHref } from '../ctx.ts'
import { ListCount } from '../views/ui/parts.tsx'
import { UpdateRow } from '../views/ui/update.tsx'
import { ReleaseList } from '../views/ui/releases.tsx'
import { ctxOf, inboxRender, servicesRender, toastHeader, updatePane, updatesRender, updatesTotal } from '../render.ts'

/** The Updates list, one update, and the verbs pressed on it. */
export function registerUpdateRoutes(app: Hono): void {
  app.get('/updates', (c) => {
    const ctx = ctxOf(c, 'updates')
    if (c.req.header('HX-Request')) {
      if (ctx.stage === 'releases') {
        const releases = listReleases({ q: ctx.q, magnitude: ctx.magnitude })
        return c.html(
          (ReleaseList({ releases, ctx: ctxString({ ...ctx, list: 'updates' }) }) as string) +
            (ListCount({ n: releases.length, oob: true }) as string),
        )
      }
      const updates = listUpdates({ stage: ctx.stage, q: ctx.q, magnitude: ctx.magnitude })
      return c.html(
        (UpdatesList({ updates, ctx: ctxString({ ...ctx, list: 'updates' }), total: updatesTotal() }) as string) +
          (ListCount({ n: updates.length, oob: true }) as string),
      )
    }
    return c.html(updatesRender(c, ctx) as string)
  })

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
    return c.html(UpdateRow({ update, ctx: ctxString(ctx), showStage: ctx.list !== 'inbox' }) as string)
  })

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

  /** Not this version. A dismissal is durable: the next scan must not offer it again. */
  app.post('/updates/:id/dismiss', async (c) => {
    const id = Number(c.req.param('id'))
    return verbReply(c, id, await runOperatorVerb(id, 'skip'))
  })

  /**
   * Every other verb, through the one dispatcher the alert cards and the MCP use. Ship,
   * snooze and always-ship wake the loop rather than doing the work here: a restore point
   * or a build can take minutes and the browser must not sit on the request.
   */
  for (const verb of [
    'ship',
    'snooze',
    'always-ship',
    'propose',
    'deploy',
    'redeploy',
    'retry',
    'rollback',
    'ack',
    'rerun-review',
  ] as const) {
    app.post(`/updates/:id/${verb}`, async (c) => {
      const id = Number(c.req.param('id'))
      return verbReply(c, id, await runOperatorVerb(id, verb))
    })
  }
}
