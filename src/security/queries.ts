import { getDb } from '../db.ts'
import type { Target } from './match.ts'

/** Read models for the MCP and the web UI. */

export interface ExposureView {
  slug: string
  title: string
  severity: string | null
  url: string | null
  exploited: boolean
  services: {
    stack: string
    service: string
    packages: { type: string; name: string; installed: string; fixed: string | null }[]
    since: string
    fix: { updateId: number; toTag: string; state: string; pr: number | null } | null
  }[]
}

export function exposureViews(slug?: string): ExposureView[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT e.*, i.title, i.severity, i.url, i.tags FROM exposures e JOIN security_incidents i ON i.slug = e.slug
        ${slug ? 'WHERE e.slug = ?' : ''} ORDER BY i.severity = 'critical' DESC, e.slug, e.stack, e.service`,
    )
    .all(...(slug ? [slug] : [])) as {
    slug: string
    stack: string
    service: string
    type: string
    package: string
    installed: string
    fixed: string | null
    first_seen_at: string
    title: string
    severity: string | null
    url: string | null
    tags: string
  }[]
  const fixes = db
    .prepare(
      `SELECT f.slug, f.update_id, u.stack, u.service, u.to_tag, u.state, p.number AS pr
         FROM security_fixes f JOIN updates u ON u.id = f.update_id
         LEFT JOIN pr_updates pu ON pu.update_id = u.id LEFT JOIN prs p ON p.id = pu.pr_id AND p.state = 'open'`,
    )
    .all() as { slug: string; update_id: number; stack: string; service: string; to_tag: string; state: string; pr: number | null }[]

  const out = new Map<string, ExposureView>()
  for (const r of rows) {
    let v = out.get(r.slug)
    if (!v) {
      const tags = JSON.parse(r.tags) as string[]
      v = {
        slug: r.slug,
        title: r.title,
        severity: r.severity,
        url: r.url,
        exploited: tags.includes('cisa-kev') || tags.includes('exploited') || tags.includes('zero-day'),
        services: [],
      }
      out.set(r.slug, v)
    }
    let s = v.services.find((x) => x.stack === r.stack && x.service === r.service)
    if (!s) {
      const f = fixes.find((x) => x.slug === r.slug && x.stack === r.stack && x.service === r.service)
      s = {
        stack: r.stack,
        service: r.service,
        packages: [],
        since: r.first_seen_at,
        fix: f ? { updateId: f.update_id, toTag: f.to_tag, state: f.state, pr: f.pr } : null,
      }
      v.services.push(s)
    }
    s.packages.push({ type: r.type, name: r.package, installed: r.installed, fixed: r.fixed })
    if (r.first_seen_at < s.since) s.since = r.first_seen_at
  }
  return [...out.values()]
}

export interface IncidentView {
  slug: string
  title: string
  category: string
  severity: string | null
  status: string | null
  url: string | null
  relevant: boolean | null
  targets: Target[] | null
  extractError: string | null
}

export function incidentViews(opts: { matchedOnly?: boolean } = {}): IncidentView[] {
  const rows = getDb()
    .prepare(
      `SELECT slug, title, category, severity, status, url, relevant, targets, extract_error FROM security_incidents
        ${opts.matchedOnly ? 'WHERE slug IN (SELECT slug FROM exposures)' : ''}
        ORDER BY updated_at DESC`,
    )
    .all() as {
    slug: string
    title: string
    category: string
    severity: string | null
    status: string | null
    url: string | null
    relevant: number | null
    targets: string | null
    extract_error: string | null
  }[]
  return rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    category: r.category,
    severity: r.severity,
    status: r.status,
    url: r.url,
    relevant: r.relevant === null ? null : r.relevant === 1,
    targets: r.targets ? (JSON.parse(r.targets) as Target[]) : null,
    extractError: r.extract_error,
  }))
}

/** What one service carries of a package, for "which version of X runs where". */
export function findPackage(name: string): { stack: string; service: string; type: string; version: string; path: string | null }[] {
  return getDb()
    .prepare(
      `SELECT DISTINCT r.stack, r.service, p.type, p.version, p.path FROM security_running r
         JOIN sbom_packages p ON p.image_id = r.image_id WHERE lower(p.name) = lower(?)
        ORDER BY r.stack, r.service LIMIT 500`,
    )
    .all(name) as { stack: string; service: string; type: string; version: string; path: string | null }[]
}
