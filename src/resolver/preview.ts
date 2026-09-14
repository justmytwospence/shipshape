import { getDb } from '../db.ts'
import { fetchLinked } from '../notes/external.ts'
import { sectionize } from '../notes/sectionize.ts'
import { getRepo } from '../upstream/github.ts'
import { releaseIndex } from '../upstream/releases.ts'
import { sameVersion, versionKey, type VersionKey } from '../versions/key.ts'
import { parseChangelogLabel, parseSourceLabel } from './labels.ts'
import { sourceForSync, type ResolutionTier } from './index.ts'

/**
 * What a repository or notes link would give a service, before it is written.
 *
 * Linking the wrong repository is quiet: its releases read as this image's, and nothing looks
 * broken. So the dialog shows what the link leads to -- the repository as GitHub names it,
 * whether it is a fork or archived, its releases and whether one matches the running version;
 * for a notes link, what was fetched and whether it has a section for the running version --
 * and only then offers to write it. Nothing here writes a label or a resolution.
 */

export interface SourcePreview {
  input: string
  removing: boolean
  /** False when writing it would be a mistake: unparseable, or no such repository. */
  ok: boolean
  reason: string | null
  /** As GitHub names it when it could be asked, else as typed. */
  repo: string | null
  checked: boolean
  /** The repository it was forked from, when it is a fork. */
  forkOf: string | null
  archived: boolean
  releases: { count: number; newest: string | null; newestPrerelease: boolean } | null
  runningRelease: string | null
  /** What shipshape finds for this image without the service's own label. */
  inferred: { repo: string | null; tier: ResolutionTier; confidence: string | null } | null
}

export interface NotesPreview {
  input: string
  removing: boolean
  ok: boolean
  reason: string | null
  where: string | null
  bytes: number
  sections: number
  runningSection: boolean
  excerpt: string | null
}

export interface LinkPreview {
  stack: string
  service: string
  runningTag: string | null
  /** Null when the box matches what the compose file already says. */
  source: SourcePreview | null
  changelog: NotesPreview | null
  /** Something would change, and nothing that would is refused. */
  writable: boolean
  /** What the write form sends. */
  values: { source: string; changelog: string }
}

export async function previewLink(o: {
  stack: string
  service: string
  source: string
  changelog: string
  current: { source: string | null; changelog: string | null }
}): Promise<LinkPreview> {
  const image = getDb()
    .prepare(`SELECT registry, repository, current_tag FROM images WHERE stack = ? AND service = ?`)
    .get(o.stack, o.service) as { registry: string; repository: string; current_tag: string | null } | undefined
  const runningTag = image?.current_tag ?? null
  const running = versionKey(runningTag)
  const service = { stack: o.stack, service: o.service }
  const sourceIn = o.source.trim()
  const notesIn = o.changelog.trim()

  const out: LinkPreview = {
    stack: o.stack,
    service: o.service,
    runningTag,
    source: null,
    changelog: null,
    writable: false,
    values: { source: sourceIn, changelog: notesIn },
  }

  if (sourceIn !== (o.current.source ?? '').trim()) {
    const inferred = image
      ? sourceForSync({ registry: image.registry, repository: image.repository }, { service, ownLabel: null }).inferred
      : null
    out.source = await previewSource(sourceIn, inferred, running)
    if (out.source.repo) out.values.source = out.source.repo
  }

  if (notesIn !== (o.current.changelog ?? '').trim()) {
    // A path is read from the repository being linked alongside it, if there is one.
    const repo =
      out.source?.ok && out.source.repo
        ? out.source.repo
        : image
          ? sourceForSync({ registry: image.registry, repository: image.repository }, { service }).repo
          : null
    out.changelog = await previewNotes(notesIn, repo, running)
  }

  const changes = [out.source, out.changelog].filter((p) => p !== null)
  out.writable = changes.length > 0 && changes.every((p) => p.ok)
  return out
}

async function previewSource(
  input: string,
  inferred: SourcePreview['inferred'],
  running: VersionKey | null,
): Promise<SourcePreview> {
  const base: SourcePreview = {
    input,
    removing: input === '',
    ok: true,
    reason: null,
    repo: null,
    checked: false,
    forkOf: null,
    archived: false,
    releases: null,
    runningRelease: null,
    inferred,
  }
  if (input === '') return base
  const p = parseSourceLabel(input)
  if (!p.ok) return { ...base, ok: false, reason: p.reason }

  const r = await getRepo(p.repo)
  // Writing needs no network, so GitHub being unavailable does not stop it -- it is said.
  if (!r.ok) return { ...base, repo: p.repo, reason: `GitHub could not be asked about it: ${r.detail}` }
  if (!r.data) return { ...base, ok: false, repo: p.repo, reason: `GitHub has no repository ${p.repo}` }

  const repo = r.data.fullName
  const index = await releaseIndex(repo, { maxPages: 1 })
  return {
    ...base,
    repo,
    checked: true,
    forkOf: r.data.fork ? (r.data.parent ?? 'another repository') : null,
    archived: r.data.archived,
    releases: index.ok
      ? { count: index.releases.length, newest: index.releases[0]?.tag ?? null, newestPrerelease: index.releases[0]?.prerelease ?? false }
      : null,
    runningRelease:
      index.ok && running ? (index.releases.find((x) => x.key && sameVersion(x.key, running))?.tag ?? null) : null,
    reason: index.ok ? null : `its releases could not be read: ${index.detail}`,
  }
}

async function previewNotes(input: string, repo: string | null, running: VersionKey | null): Promise<NotesPreview> {
  const base: NotesPreview = {
    input,
    removing: input === '',
    ok: true,
    reason: null,
    where: null,
    bytes: 0,
    sections: 0,
    runningSection: false,
    excerpt: null,
  }
  if (input === '') return base
  const p = parseChangelogLabel(input)
  if (!p.ok) return { ...base, ok: false, reason: p.reason }

  const got = await fetchLinked(p.kind === 'url' ? { kind: 'url', url: p.url } : { kind: 'path', path: p.path }, repo, running?.family)
  // A link that answers "not now" may still be right; one that is refused or missing is not.
  if (!got.ok) return { ...base, ok: got.transient, reason: got.reason }

  const sections = got.sections ?? sectionize(got.text ?? '', { filename: got.filename ?? undefined, family: running?.family })
  const first = (sections[0]?.body ?? got.text ?? '').trim()
  return {
    ...base,
    where: got.where,
    bytes: got.bytes,
    sections: sections.length,
    runningSection: !!running && sections.some((s) => s.key !== null && sameVersion(s.key, running)),
    excerpt: first ? first.slice(0, 300) : null,
  }
}
