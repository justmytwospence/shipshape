import type { Hono } from 'hono'
import { InboxList } from '../views/ui/inbox.tsx'
import { inboxData, inboxRender } from '../render.ts'

/** The Inbox: the page, and its worklist alone for the poll. */
export function registerInboxRoutes(app: Hono): void {
  app.get('/', (c) => c.html(inboxRender(c) as string))

  /** The worklist alone, for the poll that runs while a scan is in flight. */
  app.get('/fragments/inbox', (c) => c.html(InboxList({ data: inboxData() }) as string))
}
