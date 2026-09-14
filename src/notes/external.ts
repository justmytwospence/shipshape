import { ghRequest, rawFile, type GhFailure } from '../upstream/github.ts'
import { releaseIndex } from '../upstream/releases.ts'
import { safeFetch } from '../upstream/safe-fetch.ts'
import { compareKeys, type VersionKey } from '../versions/key.ts'
import type { ChangelogTarget } from '../resolver/labels.ts'
import { SECTION_CAP, fileVersion, sectionize, sectionsInRange, type Section } from './sectionize.ts'

/**
 * Notes an operator linked with `shipshape.changelog`.
 *
 * Some projects keep their notes somewhere GitHub releases cannot show: plex on its own
 * site, a project on another forge, a changelog under a path discovery would not guess. A
 * link to GitHub is read through the GitHub client -- a file or directory at the ref in the
 * link, or a repository's releases -- and anything else through `safeFetch`. A page with
 * version headings is cut by version like any changelog; one without is shown from the top,
 * and the review is told it is not matched to the range. These notes are added to what
 * GitHub releases say, never instead of them.
 */

export const EXTERNAL_CAP = 20_000
const DIRECTORY_FILES = 15

export interface ExternalNotes {
  link: string
  /** The sections for the range, when the page has version headings. */
  sections: Section[]
  /** Sections in the range left out for length. */
  omitted: string[]
  /** The beginning of the page, when nothing on it could be placed in the range. */
  excerpt: string | null
  /** How many versioned sections the page has in all. */
  totalSections: number
}

/** A link, read: text to cut by version, or sections already cut. */
export type Linked =
  | {
      ok: true
      where: string
      bytes: number
      contentType: string | null
      text: string | null
      filename: string | null
      sections: Section[] | null
    }
  | { ok: false; reason: string; transient: boolean }

export async function fetchLinked(target: ChangelogTarget, repo: string | null, family?: VersionKey['family']): Promise<Linked> {
  if (target.kind === 'path') {
    if (!repo) {
      return { ok: false, reason: `${target.path} is a path in the upstream repository, and no upstream repository is known`, transient: false }
    }
    return fromRepo(repo, target.path, 'HEAD', family)
  }
  const gh = githubLink(target.url)
  if (gh) {
    return gh.kind === 'blob' || gh.kind === 'tree' ? fromRepo(gh.repo, gh.path, gh.ref, family) : fromReleases(gh.repo)
  }
  const page = await safeFetch(target.url)
  if (!page.ok) return page
  let filename: string | null = null
  try {
    filename = new URL(page.url).pathname.split('/').pop() || null
  } catch {
    filename = null
  }
  return { ok: true, where: page.url, bytes: page.bytes, contentType: page.contentType, text: page.text, filename, sections: null }
}

export async function externalNotes(
  target: ChangelogTarget,
  repo: string | null,
  range: { from: VersionKey | null; to: VersionKey | null },
): Promise<{ ok: true; notes: ExternalNotes } | { ok: false; reason: string; transient: boolean }> {
  const got = await fetchLinked(target, repo, range.to?.family)
  if (!got.ok) return got
  const link = target.kind === 'url' ? target.url : target.path
  const all = got.sections ?? sectionize(got.text ?? '', { filename: got.filename ?? undefined, family: range.to?.family })

  if (all.length > 0 && range.to) {
    const { sections, omitted } = sectionsInRange(all, range.from, range.to, EXTERNAL_CAP)
    return { ok: true, notes: { link, sections, omitted, excerpt: null, totalSections: all.length } }
  }
  // Nothing to place the range against: the tags float, or the page has no version headings.
  // Pages put the newest first, so the beginning is the part most likely to matter.
  const text = (got.text ?? all.map((s) => `## ${s.heading}\n${s.body}`).join('\n\n')).trim()
  return {
    ok: true,
    notes: { link, sections: [], omitted: [], excerpt: text ? text.slice(0, EXTERNAL_CAP) : null, totalSections: all.length },
  }
}

// ------------------------------------------------------------------ GitHub links

type GithubLink =
  | { kind: 'blob' | 'tree'; repo: string; ref: string; path: string }
  | { kind: 'releases' | 'repo'; repo: string }

/** `github.com/o/r`, `.../releases`, `.../blob/<ref>/<path>`, `.../tree/<ref>/<path>`. */
export function githubLink(url: string): GithubLink | null {
  const m = /^https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]+?)(?:\.git)?(\/.*)?$/.exec(url.replace(/[?#].*$/, ''))
  if (!m) return null
  const repo = `${m[1]}/${m[2]}`
  const rest = (m[3] ?? '').replace(/\/+$/, '')
  if (!rest) return { kind: 'repo', repo }
  if (/^\/releases(\/.*)?$/.test(rest)) return { kind: 'releases', repo }
  const file = /^\/(blob|tree)\/([^/]+)(?:\/(.*))?$/.exec(rest)
  if (file) return { kind: file[1] as 'blob' | 'tree', repo, ref: file[2]!, path: file[3] ?? '' }
  return null
}

const transientKind = (k: GhFailure) => k === 'rate-limited' || k === 'network' || k === 'server'

async function fromRepo(repo: string, path: string, ref: string, family?: VersionKey['family']): Promise<Linked> {
  if (path) {
    const file = await rawFile(repo, path, ref)
    if (file.ok) {
      return {
        ok: true,
        where: `https://github.com/${repo}/blob/${ref}/${path}`,
        bytes: Buffer.byteLength(file.text),
        contentType: null,
        text: file.text,
        filename: path.split('/').pop() ?? null,
        sections: null,
      }
    }
    if (file.kind !== 'not-found') return { ok: false, reason: file.detail, transient: transientKind(file.kind) }
  }

  // Not a file: a directory of one file per version, like grocy's changelog/.
  const api = `/repos/${repo}/contents/${path}${ref === 'HEAD' ? '' : `?ref=${encodeURIComponent(ref)}`}`
  const dir = await ghRequest<{ name: string; path: string; type: string }[]>(api, {
    cacheKey: `github:${api}`,
    trim: (raw) =>
      Array.isArray(raw)
        ? raw.map((e: Record<string, unknown>) => ({ name: String(e.name ?? ''), path: String(e.path ?? ''), type: String(e.type ?? '') }))
        : [],
  })
  if (!dir.ok) {
    return dir.kind === 'not-found'
      ? { ok: false, reason: `${repo} has nothing at ${path || 'its root'}`, transient: false }
      : { ok: false, reason: dir.detail, transient: transientKind(dir.kind) }
  }
  const files = dir.data
    .filter((e) => e.type === 'file')
    .map((e) => ({ e, key: fileVersion(e.name, family ?? 'semver') }))
    .filter((f): f is { e: { name: string; path: string; type: string }; key: VersionKey } => f.key !== null)
    .sort((x, y) => compareKeys(y.key, x.key) ?? 0)
    .slice(0, DIRECTORY_FILES)
  if (files.length === 0) {
    return { ok: false, reason: `${path || repo} is a directory with no files named for versions`, transient: false }
  }
  const sections: Section[] = []
  let bytes = 0
  for (const f of files) {
    const text = await rawFile(repo, f.e.path, ref)
    if (!text.ok) {
      if (text.kind === 'not-found') continue
      return { ok: false, reason: text.detail, transient: transientKind(text.kind) }
    }
    bytes += Buffer.byteLength(text.text)
    const body = text.text.trim()
    sections.push({ heading: f.e.name, key: f.key, unreleased: false, body: body.length > SECTION_CAP ? `${body.slice(0, SECTION_CAP)}\n[the rest of this file was cut]` : body })
  }
  return { ok: true, where: `https://github.com/${repo}/tree/${ref}/${path}`, bytes, contentType: null, text: null, filename: null, sections }
}

/** Another repository's GitHub releases: the notes of a project published from elsewhere. */
async function fromReleases(repo: string): Promise<Linked> {
  const index = await releaseIndex(repo, { maxPages: 2, bodies: true })
  if (!index.ok) {
    return {
      ok: false,
      reason: index.kind === 'not-found' ? `GitHub has no repository ${repo}` : index.detail,
      transient: transientKind(index.kind),
    }
  }
  const sections: Section[] = index.releases.map((r) => ({
    heading: `${r.tag}${r.prerelease ? ' (prerelease)' : ''}`,
    key: r.key,
    unreleased: false,
    body: r.body,
  }))
  return {
    ok: true,
    where: `https://github.com/${repo}/releases`,
    bytes: sections.reduce((n, s) => n + Buffer.byteLength(s.body), 0),
    contentType: null,
    text: null,
    filename: null,
    sections,
  }
}
