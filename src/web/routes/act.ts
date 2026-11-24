import type { Hono } from 'hono'
import { isOperatorVerb, runOperatorVerb } from '../../updates/operator-verbs.ts'
import { verifyAction } from '../../notify/links.ts'
import { ACT_EXPIRED, ACT_GONE, ActConfirm, ActDone, ActError } from '../views/ui/act.tsx'
import { updateView } from '../../updates/view.ts'

/** The page a signed link from a notification lands on. */
export function registerActRoutes(app: Hono): void {
  /**
   * A signed link from an email or an ntfy button. The page names the update and the verb
   * and asks first; the POST does it. Behind the same authentication as everything else,
   * so a leaked link alone does nothing.
   */
  app.get('/act/:token', (c) => {
    const act = verifyAction(c.req.param('token'))
    if (!act || !isOperatorVerb(act.verb)) return c.html(ActError(ACT_EXPIRED) as string, 404)
    const v = updateView(act.updateId)
    if (!v) return c.html(ActError(ACT_GONE) as string, 404)
    const label = v.presented[act.verb as keyof typeof v.presented]?.label ?? act.verb
    return c.html(
      ActConfirm({
        verb: act.verb,
        label,
        title: `${v.stack}/${v.service} ${v.fromTag} -> ${v.toTag}`,
        steps: v.presented[act.verb as keyof typeof v.presented]?.steps,
        token: c.req.param('token'),
      }) as string,
    )
  })

  app.post('/act/:token', async (c) => {
    const act = verifyAction(c.req.param('token'))
    if (!act || !isOperatorVerb(act.verb)) return c.html(ActError(ACT_EXPIRED) as string, 404)
    const r = await runOperatorVerb(act.updateId, act.verb)
    return c.html(ActDone({ ok: r.ok, message: r.message, id: act.updateId }) as string)
  })
}
