import type { StageFilter } from '../updates/queries.ts'

/**
 * Which list a detail was opened from, carried in the URL.
 *
 * On a desktop a row fills the pane and pushes `/updates/7?list=updates&stage=open`; a
 * reload of that URL has to rebuild the same list beside the same pane, with the same
 * row selected. So the query is not decoration: it is the whole state of the page, and
 * both the row that pushes it and the route that reads it go through here.
 */

export type ListKind = 'inbox' | 'updates' | 'services' | 'service'

export interface ListCtx {
  list: ListKind
  /** Updates */
  stage: StageFilter
  magnitude: string
  /** Services */
  filter: string
  grouped: boolean
  /** Shared search box */
  q: string
  /** `service`: the service whose history the update was opened from */
  stack?: string
  service?: string
}

const STAGES = new Set(['open', 'rolling', 'done', 'closed', 'all', 'releases'])
const LISTS = new Set<string>(['inbox', 'updates', 'services', 'service'])

export function readCtx(get: (k: string) => string | undefined, fallback: ListKind): ListCtx {
  const list = get('list')
  const stage = get('stage')
  return {
    list: list && LISTS.has(list) ? (list as ListKind) : fallback,
    stage: stage && STAGES.has(stage) ? (stage as StageFilter) : 'open',
    magnitude: get('magnitude') ?? 'all',
    filter: get('filter') ?? 'all',
    grouped: get('group') === 'stack',
    q: get('q') ?? '',
    stack: get('stack') || undefined,
    service: get('service') || undefined,
  }
}

/** The query string a row carries: only what its list actually filters on. */
export function ctxString(c: ListCtx): string {
  const p = new URLSearchParams({ list: c.list })
  switch (c.list) {
    case 'updates':
      p.set('stage', c.stage)
      if (c.magnitude !== 'all') p.set('magnitude', c.magnitude)
      if (c.q) p.set('q', c.q)
      break
    case 'services':
      if (c.filter !== 'all') p.set('filter', c.filter)
      if (c.q) p.set('q', c.q)
      if (c.grouped) p.set('group', 'stack')
      break
    case 'service':
      if (c.stack) p.set('stack', c.stack)
      if (c.service) p.set('service', c.service)
      if (c.filter !== 'all') p.set('filter', c.filter)
      if (c.q) p.set('q', c.q)
      if (c.grouped) p.set('group', 'stack')
      break
    default:
      break
  }
  return p.toString()
}

/** Where the list itself lives, for the pane's close control and the phone's back link. */
export function listHref(c: ListCtx): { href: string; label: string } {
  switch (c.list) {
    case 'inbox':
      return { href: '/', label: 'Inbox' }
    case 'updates': {
      const p = new URLSearchParams()
      if (c.stage !== 'open') p.set('stage', c.stage)
      if (c.magnitude !== 'all') p.set('magnitude', c.magnitude)
      if (c.q) p.set('q', c.q)
      const s = p.toString()
      return { href: `/updates${s ? `?${s}` : ''}`, label: 'Updates' }
    }
    case 'services':
    case 'service': {
      const p = new URLSearchParams()
      if (c.filter !== 'all') p.set('filter', c.filter)
      if (c.q) p.set('q', c.q)
      if (c.grouped) p.set('group', 'stack')
      const s = p.toString()
      if (c.list === 'service' && c.stack && c.service) {
        return {
          href: `/services/${c.stack}/${c.service}${s ? `?${s}` : ''}`,
          label: c.service,
        }
      }
      return { href: `/services${s ? `?${s}` : ''}`, label: 'Services' }
    }
  }
}
