import { getDb } from '../db.ts'
import { parseImageRef, type ImageRef } from '../images/ref.ts'
import { ghRequest, rawFile, type GhFailure } from '../upstream/github.ts'
import { releaseIndex, type IndexedRelease } from '../upstream/releases.ts'
import { compareKeys, inRange, sameVersion, versionKey, type VersionKey } from '../versions/key.ts'
import { SECTION_CAP, TOTAL_CAP, fileVersion, sectionize, sectionsInRange, type Section } from './sectionize.ts'
import { externalNotes, type ExternalNotes } from './external.ts'
import type { ChangelogTarget } from '../resolver/labels.ts'

export { fileVersion } from './sectionize.ts'

/**
 * Everything the changelog review is shown about one update, and an honest account of what
 * could not be found.
 *
 * The review used to get one page of GitHub releases, prereleases removed, and a commit list
 * -- with every failure reported as "publishes no GitHub releases". So minuspod, which marks
 * most releases as prereleases and writes every version into CHANGELOG.md, was reviewed with
 * nothing, and a rate limit read the same as a project with no notes at all.
 *
 * Now the notes are chosen for the range the update actually crosses: the releases after the
 * running version up to the proposed one, prereleases marked rather than dropped; the
 * sections of the project's changelog file for those versions, where a release body does not
 * already say it; the newest commits between the two tags. Each fetch reports what happened,
 * and a failure that trying again could fix marks the notes incomplete, so the review can be
 * read again once it clears.
 */

export type FetchOutcome = 'found' | 'none' | 'not-found' | 'rate-limited' | 'unreachable' | 'skipped'

export interface Fetched {
  what: string
  outcome: FetchOutcome
  detail?: string
}

export interface NotesSource {
  repo: string | null
  tier: string
  confidence: string | null
  detail: string | null
  packagingRepo?: string | null
  /** `shipshape.changelog`, when a service names where its notes are. */
  changelog?: { value: string; target: ChangelogTarget } | null
}

export interface NotesBundle {
  source: NotesSource
  range: { from: string; to: string; approximate: boolean; basis: string }
  /** Releases in the range, newest first. */
  releases: IndexedRelease[]
  /** Releases in the range left out for length. */
  omitted: string[]
  /** Recent release names that could not be placed against the image's versions. */
  unplaced: string[]
  changelog: { file: string; sections: Section[]; omitted: string[] } | null
  /** What the link in `shipshape.changelog` gave, when there is one. */
  external: ExternalNotes | null
  commits: { from: string; to: string; total: number; subjects: string[] } | null
  container: { date: string; desc: string }[]
  fetches: Fetched[]
  notes: string[]
  /** Something could not be fetched for a reason that may clear: a rate limit, an outage. */
  incomplete: boolean
}

/** What a verdict keeps of its notes: enough to say what it was based on, and to read again. */
export interface NotesEvidence {
  repo: string | null
  tier: string
  confidence: string | null
  range: { from: string; to: string; approximate: boolean }
  releases: number
  changelogSections: number
  /** Sections for the range from the link in `shipshape.changelog`. */
  linkedSections: number
  commits: number
  omitted: number
  fetches: Fetched[]
  incomplete: boolean
}

export const RELEASES_CAP = 30_000
const COMMITS_SHOWN = 60
const DIRECTORY_FILES = 15
/** A release body this long says what changed; a changelog section for it would repeat it. */
const SUBSTANTIVE = 200

interface Range {
  from: VersionKey | null
  to: VersionKey | null
  /** For a floating tag with no version to go on: a window of publication dates. */
  after: string | null
  until: string | null
  approximate: boolean
  basis: string
}

export async function assembleNotes(o: {
  image: string
  fromTag: string
  toTag: string
  source: NotesSource
  observedAt?: string
}): Promise<NotesBundle> {
  const ref = parseImageRef(o.image)
  const range = rangeFor(ref, o.fromTag, o.toTag, o.observedAt)
  const b: NotesBundle = {
    source: o.source,
    range: { from: o.fromTag, to: o.toTag, approximate: range.approximate, basis: range.basis },
    releases: [],
    omitted: [],
    unplaced: [],
    changelog: null,
    external: null,
    commits: null,
    container: [],
    fetches: [],
    notes: [],
    incomplete: false,
  }

  await containerChanges(b, ref)

  const repo = o.source.repo
  const linked = o.source.changelog?.target ?? null
  // Read whether or not a repository is known: a vendor's page is how plex's notes arrive.
  if (linked?.kind === 'url') await linkedNotes(b, linked, repo, range)

  if (!repo) {
    if (linked?.kind === 'path') {
      b.notes.push(`shipshape.changelog names ${linked.path}, a path in the upstream repository, and no upstream repository is known.`)
    }
    b.notes.push(
      b.external
        ? 'No upstream repository is known for this image; the notes linked by shipshape.changelog are what there is.'
        : o.source.packagingRepo
          ? `No upstream repository is known for this image. ${o.source.packagingRepo} packages it, and has only container changes.`
          : 'No upstream repository is known for this image, so no release notes could be fetched directly.',
    )
    b.fetches.push({ what: 'releases', outcome: 'skipped', detail: 'no upstream repository' })
    return b
  }

  const all = await releases(b, repo, range)
  await changelog(b, repo, range, all, linked?.kind === 'path' ? linked.path : null)
  if (range.from && range.to) await commits(b, repo, o.fromTag, o.toTag, range, all)
  else b.fetches.push({ what: 'commits', outcome: 'skipped', detail: 'the tags name no versions to compare' })
  return b
}

export function evidenceOf(b: NotesBundle): NotesEvidence {
  return {
    repo: b.source.repo,
    tier: b.source.tier,
    confidence: b.source.confidence,
    range: { from: b.range.from, to: b.range.to, approximate: b.range.approximate },
    releases: b.releases.length,
    changelogSections: b.changelog?.sections.length ?? 0,
    linkedSections: b.external?.sections.length ?? 0,
    commits: b.commits?.subjects.length ?? 0,
    omitted: b.omitted.length + (b.changelog?.omitted.length ?? 0) + (b.external?.omitted.length ?? 0),
    fetches: b.fetches,
    incomplete: b.incomplete,
  }
}

/**
 * Notes that describe the range: release bodies, changelog sections, and linked sections.
 * Commits are not notes, and neither is the unplaced beginning of a linked page.
 */
export function notesInRange(b: NotesBundle): number {
  return (
    b.releases.filter((r) => r.body.trim().length > 0).length +
    (b.changelog?.sections.length ?? 0) +
    (b.external?.sections.length ?? 0)
  )
}

async function linkedNotes(
  b: NotesBundle,
  target: Extract<ChangelogTarget, { kind: 'url' }>,
  repo: string | null,
  range: Range,
): Promise<void> {
  const res = await externalNotes(target, repo, { from: range.from, to: range.to })
  if (!res.ok) {
    b.fetches.push({ what: 'linked notes', outcome: res.transient ? 'unreachable' : 'not-found', detail: res.reason })
    b.notes.push(`The notes linked by shipshape.changelog could not be read: ${res.reason}.`)
    if (res.transient) b.incomplete = true
    return
  }
  const n = res.notes
  b.external = n
  b.fetches.push({
    what: 'linked notes',
    outcome: n.sections.length > 0 || n.excerpt ? 'found' : 'none',
    detail:
      n.sections.length > 0
        ? `${n.sections.length} sections of ${target.url} in the range`
        : n.excerpt
          ? `nothing on ${target.url} could be placed in the range, so its beginning is shown`
          : `none of the ${n.totalSections} sections of ${target.url} are in the range`,
  })
}

// ------------------------------------------------------------------ the range

/**
 * Which versions the update crosses. Tags that name versions say so directly. A floating tag
 * (`latest`, a digest move) is made concrete through a version tag that pointed at the same
 * digest, when the registry listing recorded one; otherwise the range is a window of
 * publication dates, and says it is approximate.
 */
function rangeFor(ref: ImageRef, fromTag: string, toTag: string, observedAt?: string): Range {
  const from = versionKey(fromTag)
  const to = versionKey(toTag)
  if (from && to) return { from, to, after: null, until: null, approximate: false, basis: 'the tags name the versions' }

  const fromTagged = taggedAs(ref, digestOf(fromTag))
  const toTagged = taggedAs(ref, digestOf(toTag))
  if (fromTagged.key && toTagged.key) {
    return {
      from: fromTagged.key,
      to: toTagged.key,
      after: null,
      until: null,
      approximate: false,
      basis: `the digests were also tagged ${fromTagged.key.raw} and ${toTagged.key.raw}`,
    }
  }
  const until = toTagged.seen ?? observedAt ?? new Date().toISOString()
  const after = fromTagged.seen
  return {
    from: null,
    to: null,
    after,
    until,
    approximate: true,
    basis: after
      ? `the tags float, so this is the releases published between ${after.slice(0, 10)} and ${until.slice(0, 10)}`
      : `the tags float, so this is the newest releases published by ${until.slice(0, 10)}; which of them the running image already had is not known`,
  }
}

const digestOf = (tag: string): string | null => (tag.includes('@') ? tag.slice(tag.indexOf('@') + 1) : null)

function taggedAs(ref: ImageRef, digest: string | null): { key: VersionKey | null; seen: string | null } {
  if (!digest) return { key: null, seen: null }
  const rows = getDb()
    .prepare(
      `SELECT tag, COALESCE(published_at, first_seen_at) AS at FROM tags_seen
       WHERE registry = ? AND repository = ? AND digest = ?`,
    )
    .all(ref.registry, ref.repository, digest) as { tag: string; at: string | null }[]
  let key: VersionKey | null = null
  for (const r of rows) {
    const k = versionKey(r.tag)
    if (k && !k.partial && (!key || (compareKeys(k, key) ?? 0) > 0)) key = k
  }
  const seen = rows.map((r) => r.at).filter((a): a is string => !!a).sort()[0] ?? null
  return { key, seen }
}

function placed(r: IndexedRelease, range: Range): boolean {
  if (range.to) return !!r.key && inRange(r.key, range.from, range.to)
  if (!r.published) return false
  return r.published <= (range.until ?? '9999') && (!range.after || r.published > range.after)
}

// ------------------------------------------------------------------ releases

async function releases(b: NotesBundle, repo: string, range: Range): Promise<IndexedRelease[]> {
  const index = await releaseIndex(repo, { until: range.from && !range.from.partial ? range.from : null, maxPages: 5, bodies: true })
  if (!index.ok) {
    failed(b, 'releases', index.kind, `${repo}'s GitHub releases`, index.detail, index.resetAt)
    return []
  }
  if (index.stale) b.notes.push(`GitHub could not be reached, so ${repo}'s releases are from shipshape's last copy.`)
  if (index.releases.length === 0) {
    b.fetches.push({ what: 'releases', outcome: 'none', detail: `${repo} publishes no GitHub releases` })
    b.notes.push(`${repo} publishes no GitHub releases.`)
    return []
  }

  let inRangeNewestFirst = index.releases.filter((r) => placed(r, range))
  // Without versions the window is a guess, so it is kept short.
  if (!range.to && !range.after) inRangeNewestFirst = inRangeNewestFirst.slice(0, 5)

  let used = 0
  for (const r of inRangeNewestFirst) {
    if (used + r.body.length > RELEASES_CAP && b.releases.length > 0) {
      b.omitted.push(r.tag)
      continue
    }
    b.releases.push(r)
    used += r.body.length
  }
  if (range.to) {
    b.unplaced = index.releases
      .filter((r) => !r.key || r.key.family !== range.to!.family)
      .slice(0, 10)
      .map((r) => r.tag)
  }
  b.fetches.push({
    what: 'releases',
    outcome: b.releases.length > 0 ? 'found' : 'none',
    detail: `${b.releases.length} of ${index.releases.length} read are in the range`,
  })
  if (!index.complete && range.from && !index.releases.some((r) => r.key && (compareKeys(r.key, range.from!) ?? 1) <= 0)) {
    b.notes.push(`Only the newest ${index.releases.length} of ${repo}'s releases were read; older ones in the range may be missing.`)
  }
  return index.releases
}

// ------------------------------------------------------------------ changelog files

const CHANGELOG_FILE = /^(changelog|changes|history|news|releases?|release[-_]notes)(\.(md|markdown|rst|txt|adoc))?$/i
const CHANGELOG_DIR = /^(changelogs?|changes|release-notes)$/i
const FILE_RANK = ['changelog', 'changes', 'history', 'news', 'release_notes', 'release-notes', 'releases', 'release']

interface Entry {
  name: string
  path: string
  type: string
}

async function changelog(
  b: NotesBundle,
  repo: string,
  range: Range,
  all: IndexedRelease[],
  /** A path from `shipshape.changelog`, which replaces discovery. */
  override: string | null,
): Promise<void> {
  if (!range.to) {
    b.fetches.push({ what: 'changelog', outcome: 'skipped', detail: 'the tags name no versions to find in a changelog' })
    return
  }

  let found: { file: Entry | null; dir: Entry | null }
  if (override) {
    // Tried as a file first; a path that is not one is tried as a directory below.
    found = { file: { name: override.split('/').pop() ?? override, path: override, type: 'file' }, dir: null }
  } else {
    const root = await listing(repo, '')
    if (!root.ok) {
      if (root.kind !== 'not-found') failed(b, 'changelog', root.kind, `${repo}'s files`, root.detail, root.resetAt)
      return
    }
    found = pick(root.entries)
    if (!found.file && !found.dir) {
      const docs = root.entries.find((e) => e.type === 'dir' && e.name.toLowerCase() === 'docs')
      if (docs) {
        const inside = await listing(repo, docs.path)
        if (inside.ok) found = pick(inside.entries)
      }
    }
  }

  // A section a substantive release body already covers would say the same thing twice.
  const covered = (s: Section) =>
    all.some((r) => r.key && s.key && sameVersion(r.key, s.key) && r.body.trim().length >= SUBSTANTIVE)

  if (found.file) {
    const text = await rawFile(repo, found.file.path)
    if (!text.ok && text.kind === 'not-found' && override) {
      found = { file: null, dir: { name: found.file.name, path: override, type: 'dir' } }
    } else if (!text.ok) {
      if (text.kind !== 'not-found') failed(b, 'changelog', text.kind, found.file.path, text.detail)
      return
    }
  }

  if (found.file) {
    const text = await rawFile(repo, found.file.path)
    if (!text.ok) {
      if (text.kind !== 'not-found') failed(b, 'changelog', text.kind, found.file.path, text.detail)
      return
    }
    const sections = sectionize(text.text, { filename: found.file.name, family: range.to.family })
    const inRangeCount = sectionsInRange(sections, range.from, range.to, Number.POSITIVE_INFINITY).sections.length
    const { sections: kept, omitted } = sectionsInRange(sections.filter((s) => !covered(s)), range.from, range.to)
    b.changelog = { file: found.file.path, sections: kept, omitted }
    b.fetches.push({
      what: 'changelog',
      outcome: kept.length > 0 ? 'found' : 'none',
      detail:
        sections.length === 0
          ? `${found.file.path} has no versioned sections`
          : `${kept.length} sections of ${found.file.path} in the range${alreadyCovered(inRangeCount - kept.length - omitted.length)}`,
    })
    return
  }

  if (found.dir) {
    const dir = await listing(repo, found.dir.path)
    if (!dir.ok) {
      if (dir.kind !== 'not-found') failed(b, 'changelog', dir.kind, found.dir.path, dir.detail)
      else if (override) {
        b.fetches.push({ what: 'changelog', outcome: 'not-found', detail: `shipshape.changelog names ${override}, which ${repo} does not have` })
        b.notes.push(`shipshape.changelog names ${override}, which ${repo} does not have.`)
      }
      return
    }
    // One file per version, named for it: grocy's `83_4.7.1_2026-09-04.md`.
    const files = dir.entries
      .filter((e) => e.type === 'file')
      .map((e) => ({ e, key: fileVersion(e.name, range.to!.family) }))
      .filter((f): f is { e: Entry; key: VersionKey } => !!f.key && inRange(f.key, range.from, range.to!))
      .sort((x, y) => (compareKeys(y.key, x.key) ?? 0))
      .slice(0, DIRECTORY_FILES)
    const sections: Section[] = []
    for (const f of files) {
      const text = await rawFile(repo, f.e.path)
      if (!text.ok) {
        if (text.kind !== 'not-found') failed(b, 'changelog', text.kind, f.e.path, text.detail)
        continue
      }
      const body = text.text.trim()
      sections.push({
        heading: f.e.name,
        key: f.key,
        unreleased: false,
        body: body.length > SECTION_CAP ? `${body.slice(0, SECTION_CAP)}\n[the rest of this file was cut]` : body,
      })
    }
    const { sections: kept, omitted } = sectionsInRange(sections.filter((s) => !covered(s)), range.from, range.to, TOTAL_CAP)
    b.changelog = { file: `${found.dir.path}/`, sections: kept, omitted }
    b.fetches.push({
      what: 'changelog',
      outcome: kept.length > 0 ? 'found' : 'none',
      detail: `${kept.length} files in ${found.dir.path}/ for the range${alreadyCovered(sections.length - kept.length - omitted.length)}`,
    })
    return
  }

  b.fetches.push({ what: 'changelog', outcome: 'not-found', detail: 'no changelog file in the repository' })
}

/** Said beside a count that left some out, so "0 sections" does not read as "no notes". */
const alreadyCovered = (n: number): string => (n > 0 ? `, and ${n} more that releases above already cover` : '')

function pick(entries: Entry[]): { file: Entry | null; dir: Entry | null } {
  const rank = (name: string) => {
    const stem = name.toLowerCase().replace(/\.(md|markdown|rst|txt|adoc)$/, '')
    const i = FILE_RANK.indexOf(stem)
    return i === -1 ? FILE_RANK.length : i
  }
  const file = entries
    .filter((e) => e.type === 'file' && CHANGELOG_FILE.test(e.name))
    .sort((a, b) => rank(a.name) - rank(b.name))[0] ?? null
  const dir = entries.find((e) => e.type === 'dir' && CHANGELOG_DIR.test(e.name)) ?? null
  return { file, dir }
}


async function listing(
  repo: string,
  path: string,
): Promise<{ ok: true; entries: Entry[] } | { ok: false; kind: GhFailure; detail: string; resetAt?: string }> {
  const api = `/repos/${repo}/contents/${path}`
  const res = await ghRequest<Entry[]>(api, {
    cacheKey: `github:${api}`,
    trim: (raw) =>
      Array.isArray(raw)
        ? raw.map((e: Record<string, unknown>) => ({ name: String(e.name ?? ''), path: String(e.path ?? ''), type: String(e.type ?? '') }))
        : [],
  })
  return res.ok ? { ok: true, entries: res.data } : res
}

// ------------------------------------------------------------------ commits

async function commits(
  b: NotesBundle,
  repo: string,
  fromTag: string,
  toTag: string,
  range: Range,
  all: IndexedRelease[],
): Promise<void> {
  // The project's own tag names first, from its releases: an image tag is rarely a git tag.
  const named = (k: VersionKey | null) =>
    k && !k.partial ? (all.find((r) => r.key && sameVersion(r.key, k))?.tag ?? null) : null
  // Failing that, the version itself as a tag name: minuspod tags every version `v2.96.17`
  // and publishes releases for a few, and no git tag is spelled like the image's `-cpu`.
  const spelled = (k: VersionKey | null, prefix: string) =>
    k && !k.partial && k.family === 'semver' && k.pre === null ? `${prefix}${k.core.join('.')}` : null
  const f = fromTag.replace(/@.*$/, '')
  const t = toTag.replace(/@.*$/, '')
  const pairs: [string, string][] = []
  for (const [a, c] of [
    [named(range.from) ?? spelled(range.from, 'v'), named(range.to) ?? spelled(range.to, 'v')],
    [spelled(range.from, 'v'), spelled(range.to, 'v')],
    [spelled(range.from, ''), spelled(range.to, '')],
    [f, t],
  ] as [string | null, string | null][]) {
    if (a && c && !pairs.some(([x, y]) => x === a && y === c)) pairs.push([a, c])
  }

  for (const [a, c] of pairs) {
    const path = `/repos/${repo}/compare/${encodeURIComponent(a)}...${encodeURIComponent(c)}`
    const res = await ghRequest<{ total: number; subjects: string[] }>(path, {
      cacheKey: `github:${path}`,
      trim: (raw) => {
        const body = raw as { total_commits?: number; commits?: { commit?: { message?: string } }[] }
        const list = (body.commits ?? []).map((x) => (x.commit?.message ?? '').split('\n')[0]!)
        return { total: body.total_commits ?? list.length, subjects: list }
      },
    })
    if (res.ok) {
      // GitHub lists the oldest first. The newest are nearest the proposed version.
      const subjects = res.data.subjects.slice(-COMMITS_SHOWN).reverse()
      b.commits = { from: a, to: c, total: res.data.total, subjects }
      b.fetches.push({ what: 'commits', outcome: 'found', detail: `${subjects.length} of ${res.data.total} between ${a} and ${c}` })
      return
    }
    if (res.kind !== 'not-found') {
      failed(b, 'commits', res.kind, `the commits between ${a} and ${c}`, res.detail, res.resetAt)
      return
    }
  }
  b.fetches.push({ what: 'commits', outcome: 'not-found', detail: `no pair of git tags for ${f} and ${t}` })
}

// ------------------------------------------------------------------ LinuxServer

/** LinuxServer publishes container-level changes separately from the application's. */
async function containerChanges(b: NotesBundle, ref: ImageRef): Promise<void> {
  if (!ref.repository.startsWith('linuxserver/')) return
  const name = ref.repository.slice('linuxserver/'.length)
  try {
    const res = await fetch('https://api.linuxserver.io/api/v1/images?include_config=false&include_deprecated=false', {
      headers: { 'user-agent': 'shipshape/0.1' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      b.fetches.push({ what: 'container changes', outcome: 'unreachable', detail: `the LinuxServer API answered ${res.status}` })
      return
    }
    const body = (await res.json()) as {
      data?: { repositories?: Record<string, { name: string; changelog?: { date: string; desc: string }[] }[]> }
    }
    for (const list of Object.values(body.data?.repositories ?? {})) {
      const hit = list.find((i) => i.name === name)
      if (hit?.changelog) {
        b.container = hit.changelog.slice(0, 12)
        b.fetches.push({ what: 'container changes', outcome: 'found', detail: `${b.container.length} from LinuxServer` })
        return
      }
    }
    b.fetches.push({ what: 'container changes', outcome: 'none' })
  } catch (err) {
    // Optional context: its absence is reported, and is not a reason to read again.
    b.fetches.push({ what: 'container changes', outcome: 'unreachable', detail: (err as Error).message })
  }
}

// ------------------------------------------------------------------ saying what failed

function failed(b: NotesBundle, what: string, kind: GhFailure, subject: string, detail: string, resetAt?: string): void {
  switch (kind) {
    case 'rate-limited':
      b.fetches.push({ what, outcome: 'rate-limited', detail })
      b.notes.push(`GitHub's rate limit was reached${resetAt ? ` (it resets ${resetAt})` : ''}, so ${subject} could not be read.`)
      b.incomplete = true
      return
    case 'not-found':
      b.fetches.push({ what, outcome: 'not-found', detail })
      b.notes.push(`GitHub has nothing at ${subject}.`)
      return
    default:
      b.fetches.push({ what, outcome: 'unreachable', detail })
      b.notes.push(`${subject} could not be read: ${detail}.`)
      b.incomplete = true
  }
}
