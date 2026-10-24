import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Policy } from '../config.ts'
import { getDb, logEvent } from '../db.ts'

/**
 * Reading the incident index (pwn.watch's incidents.json).
 *
 * One file carries every incident in every category with its affected and fixed version
 * text and an `updatedAt`, so a poll is one conditional GET: the ETag makes an unchanged
 * index a 304, and an incident is only re-stored when its own `updatedAt` moves.
 *
 * Only live incidents are taken in. A closed one that is already stored stays, with its
 * new status, because "the news is over" is not "the vulnerable version is gone": an
 * exposure outlives the headline.
 */

const Incident = z.object({
  slug: z.string().min(1),
  title: z.string(),
  url: z.string().optional(),
  category: z.string(),
  status: z.string(),
  severity: z.string().nullish(),
  patchStatus: z.string().nullish(),
  product: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  stacks: z.array(z.string()).nullish(),
  cveIds: z.array(z.string()).nullish(),
  affectedVersions: z.array(z.string()).nullish(),
  fixedVersions: z.array(z.string()).nullish(),
  summary: z.string().nullish(),
  updatedAt: z.string().nullish(),
  isExample: z.boolean().nullish(),
})
export type FeedIncident = z.infer<typeof Incident>

const Index = z.object({ incidents: z.array(z.unknown()) })

/** The text an extraction reads. A change anywhere else in an incident does not re-run it. */
export function versionsHash(i: FeedIncident): string {
  const text = JSON.stringify({
    product: i.product ?? '',
    affected: i.affectedVersions ?? [],
    fixed: i.fixedVersions ?? [],
  })
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export interface FeedResult {
  /** Not modified since the last read. */
  unchanged: boolean
  /** Incidents stored or re-stored this read. */
  stored: number
  /** Entries in the index that could not be read; skipped, never fatal. */
  malformed: number
}

/** Parse an index body, keeping what is readable. Exported for the tests. */
export function parseIndex(body: unknown): { incidents: FeedIncident[]; malformed: number } {
  const idx = Index.parse(body)
  const incidents: FeedIncident[] = []
  let malformed = 0
  for (const raw of idx.incidents) {
    const r = Incident.safeParse(raw)
    if (r.success) incidents.push(r.data)
    else malformed++
  }
  return { incidents, malformed }
}

/** Upsert what an index says. Returns how many rows were written. Exported for the tests. */
export function storeIncidents(incidents: FeedIncident[], categories: readonly string[]): number {
  const db = getDb()
  const now = new Date().toISOString()
  const existing = new Map(
    (db.prepare(`SELECT slug, updated_at FROM security_incidents`).all() as { slug: string; updated_at: string | null }[]).map(
      (r) => [r.slug, r.updated_at],
    ),
  )
  const upsert = db.prepare(
    `INSERT INTO security_incidents
       (slug, category, title, severity, patch_status, status, tags, cve_ids, url, updated_at, raw, fetched_at, versions_hash)
     VALUES (@slug, @category, @title, @severity, @patch_status, @status, @tags, @cve_ids, @url, @updated_at, @raw, @fetched_at, @versions_hash)
     ON CONFLICT(slug) DO UPDATE SET
       category = excluded.category, title = excluded.title, severity = excluded.severity,
       patch_status = excluded.patch_status, status = excluded.status, tags = excluded.tags,
       cve_ids = excluded.cve_ids, url = excluded.url, updated_at = excluded.updated_at,
       raw = excluded.raw, fetched_at = excluded.fetched_at, versions_hash = excluded.versions_hash`,
  )
  let n = 0
  db.transaction(() => {
    for (const i of incidents) {
      if (i.isExample) continue
      if (!categories.includes(i.category)) continue
      const known = existing.has(i.slug)
      // New incidents only while they are live; known ones follow their status either way.
      if (!known && i.status !== 'live') continue
      if (known && existing.get(i.slug) === (i.updatedAt ?? null)) continue
      upsert.run({
        slug: i.slug,
        category: i.category,
        title: i.title,
        severity: i.severity ?? null,
        patch_status: i.patchStatus ?? null,
        status: i.status,
        tags: JSON.stringify(i.tags ?? []),
        cve_ids: JSON.stringify(i.cveIds ?? []),
        url: i.url ?? null,
        updated_at: i.updatedAt ?? null,
        raw: JSON.stringify(i),
        fetched_at: now,
        versions_hash: versionsHash(i),
      })
      n++
    }
  })()
  return n
}

/** One conditional read of the index. */
export async function pollFeed(policy: Policy, fetchImpl: typeof fetch = fetch): Promise<FeedResult> {
  const url = policy.security.feed
  const db = getDb()
  const cached = db.prepare(`SELECT etag FROM http_cache WHERE url = ?`).get(url) as { etag: string | null } | undefined
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'shipshape (homelab update bot)' }
  if (cached?.etag) headers['if-none-match'] = cached.etag

  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30_000) })
  if (res.status === 304) return { unchanged: true, stored: 0, malformed: 0 }
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  const body = (await res.json()) as unknown
  const { incidents, malformed } = parseIndex(body)
  const stored = storeIncidents(incidents, policy.security.categories)

  // The ETag is only kept once the body has been stored: a read that failed half way must
  // be repeated in full, not answered 304.
  db.prepare(
    `INSERT INTO http_cache (url, etag, body, fetched_at) VALUES (?, ?, NULL, ?)
     ON CONFLICT(url) DO UPDATE SET etag = excluded.etag, body = NULL, fetched_at = excluded.fetched_at`,
  ).run(url, res.headers.get('etag'), new Date().toISOString())

  if (malformed > 0) {
    logEvent({ level: 'warn', kind: 'system', message: 'security feed: some incidents could not be read', detail: `${malformed} skipped` })
  }
  return { unchanged: false, stored, malformed }
}

export interface StoredIncident {
  slug: string
  category: string
  title: string
  severity: string | null
  patch_status: string | null
  status: string | null
  tags: string[]
  cve_ids: string[]
  url: string | null
  raw: FeedIncident
}

export function readIncident(slug: string): StoredIncident | null {
  const r = getDb().prepare(`SELECT * FROM security_incidents WHERE slug = ?`).get(slug) as
    | (Omit<StoredIncident, 'tags' | 'cve_ids' | 'raw'> & { tags: string; cve_ids: string; raw: string })
    | undefined
  if (!r) return null
  return { ...r, tags: JSON.parse(r.tags) as string[], cve_ids: JSON.parse(r.cve_ids) as string[], raw: JSON.parse(r.raw) as FeedIncident }
}

/** Exploited in the wild, by the feed's own tags. */
export function exploited(tags: readonly string[]): boolean {
  return tags.includes('cisa-kev') || tags.includes('exploited') || tags.includes('zero-day')
}
