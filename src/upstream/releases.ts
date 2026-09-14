import { ghRequest, type GhFailure } from './github.ts'
import { compareKeys, versionKey, type VersionKey } from '../versions/key.ts'

/**
 * A project's GitHub releases, newest first, each with a version key.
 *
 * One reader replaces three: the changelog review, the prerelease filter and the release
 * probe each fetched a single page of their own, and two dropped prereleases before anything
 * could ask about them. Here drafts are dropped and prereleases are kept and marked, so the
 * caller decides what a prerelease means.
 *
 * Pages are fetched while they are full, up to `maxPages`, and stop early once a page reaches
 * a release at or below `until` -- a project that cuts forty betas between two stable
 * releases no longer pushes the running version off the first page. Every page is cached and
 * revalidated with its ETag, and a cached page stands in when GitHub is limiting or down.
 * Release bodies are only kept when asked for: detection needs tags and flags, and a hundred
 * bodies per page per repository is a lot of cache for nothing.
 */

export interface IndexedRelease {
  tag: string
  key: VersionKey | null
  prerelease: boolean
  name: string | null
  published: string | null
  body: string
}

export type ReleaseIndex =
  | { ok: true; releases: IndexedRelease[]; complete: boolean; stale: boolean }
  | { ok: false; kind: GhFailure; detail: string; resetAt?: string }

interface StoredRelease {
  tag_name: string
  name: string | null
  published_at: string | null
  body: string | null
  draft: boolean
  prerelease: boolean
}

const PER_PAGE = 100
const BODY_CAP = 6000

export async function releaseIndex(
  repo: string,
  o: { until?: VersionKey | null; maxPages?: number; bodies?: boolean } = {},
): Promise<ReleaseIndex> {
  const maxPages = o.maxPages ?? 3
  const out: IndexedRelease[] = []
  let stale = false

  for (let page = 1; page <= maxPages; page++) {
    const path = `/repos/${repo}/releases?per_page=${PER_PAGE}&page=${page}`
    const res = await ghRequest<StoredRelease[]>(path, {
      cacheKey: `github:${path}${o.bodies ? '#bodies' : ''}`,
      trim: (raw) => trim(raw, !!o.bodies),
    })
    if (!res.ok) {
      if (page === 1) return { ok: false, kind: res.kind, detail: res.detail, resetAt: res.resetAt }
      // Later pages failing still leaves the newest releases, which is most of what matters.
      return { ok: true, releases: out, complete: false, stale }
    }
    stale ||= res.stale === true

    const batch = res.data
      .filter((r) => !r.draft)
      .map((r) => ({
        tag: r.tag_name,
        key: versionKey(r.tag_name),
        prerelease: r.prerelease,
        name: r.name,
        published: r.published_at,
        body: r.body ?? '',
      }))
    out.push(...batch)

    if (res.data.length < PER_PAGE) return { ok: true, releases: out, complete: true, stale }
    const until = o.until
    if (until && batch.some((r) => r.key && (compareKeys(r.key, until) ?? 1) <= 0)) {
      return { ok: true, releases: out, complete: true, stale }
    }
  }
  return { ok: true, releases: out, complete: false, stale }
}

function trim(raw: unknown, bodies: boolean): StoredRelease[] {
  if (!Array.isArray(raw)) return []
  return raw.map((r: Record<string, unknown>) => ({
    tag_name: String(r.tag_name ?? ''),
    name: typeof r.name === 'string' ? r.name : null,
    published_at: typeof r.published_at === 'string' ? r.published_at : null,
    body: bodies && typeof r.body === 'string' ? r.body.slice(0, BODY_CAP) : null,
    draft: r.draft === true,
    prerelease: r.prerelease === true,
  }))
}
