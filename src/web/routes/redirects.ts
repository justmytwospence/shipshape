import type { Hono } from 'hono'

/** Addresses that moved, answered with a 301 to the page that replaced them. */
export function registerRedirects(app: Hono): void {
  // Old addresses, kept as redirects: a bookmark or a link in a months-old digest
  // should land on the page that replaced it rather than a 404.
  app.get('/system', (c) => c.redirect('/status', 301))
  // Settings was two tabs, a raw view and a digest preview nobody could reach; it is one
  // page now, and the old addresses land on the part of it that replaced them.
  app.get('/settings/advanced', (c) => c.redirect('/settings', 301))
  app.get('/settings/raw', (c) => c.redirect('/settings', 301))
  app.get('/settings/digest', (c) => c.redirect('/settings#notifications', 301))
  app.get('/settings/status', (c) => c.redirect('/status', 301))
  app.get('/images', (c) => c.redirect('/services', 301))
}
