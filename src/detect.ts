import { env } from './config.ts'
import type { ScannedService } from './compose/scan.ts'
import {
  listTags,
  headDigest,
  TagListTooLarge,
  RepositoryNotFound,
  type TagInfo,
} from './registry/index.ts'
import { probeByReleases } from './registry/probe.ts'
import { resolveSource, guessFromImagePath } from './resolver/index.ts'
import { fetchPrereleaseTags, normaliseReleaseTag } from './changelog/github.ts'
import { selectUpdate, type Comparison } from './versions/compare.ts'
import { inferPattern, isPatternKind, type PatternKind } from './versions/patterns.ts'

/**
 * One service in, one verdict out.
 *
 * Every non-update outcome is named. Nothing here may return "up to date" unless the
 * comparison genuinely ran and found nothing newer -- the two bugs found while building
 * this both took the shape of an unrelated failure disguising itself as "current".
 */
export type Detection =
  | { status: 'update'; tag: string; magnitude: string; via: Source; observed: TagInfo[] }
  | { status: 'up-to-date'; via: Source; observed: TagInfo[]; constrainedFrom?: string }
  /** Rolling or digest-pinned: compare digests, not tag strings. */
  | { status: 'digest-watch'; currentDigest: string | null }
  /** No `shipshape.pattern` label and none could be inferred -- needs a human. */
  | { status: 'no-pattern'; detail: string }
  /** The pinned tag does not match its declared pattern. */
  | { status: 'unparseable'; detail: string }
  | { status: 'bad-refinement'; detail: string }
  /** Never published to a registry (a locally-built image). */
  | { status: 'not-published'; detail: string }
  /** Too many tags to enumerate and no source repo to probe releases from. */
  | { status: 'unresolvable'; detail: string }
  | { status: 'error'; detail: string }

/** How the candidate tag list was obtained -- surfaced so a probe-derived result is
 *  never mistaken for an exhaustive one. */
export type Source = 'registry' | 'releases'

export function patternFor(svc: ScannedService): PatternKind | null {
  if (svc.pattern && isPatternKind(svc.pattern)) return svc.pattern
  if (svc.ref?.digest) return 'digest'
  return svc.ref?.tag ? inferPattern(svc.ref.tag) : null
}

export async function detect(svc: ScannedService): Promise<Detection> {
  const ref = svc.ref
  if (!ref) return { status: 'no-pattern', detail: 'no image reference' }

  const kind = patternFor(svc)
  if (!kind) {
    return {
      status: 'no-pattern',
      detail:
        `cannot infer a pattern from tag "${ref.tag}" -- ` +
        `add a shipshape.pattern label (use "regex" with shipshape.tag.include for odd shapes)`,
    }
  }

  // Rolling tags and digest pins have no ordering; movement shows up as a digest change.
  if (kind === 'latest' || kind === 'digest' || !ref.tag) {
    try {
      const digest = await headDigest(ref.registry, ref.repository, ref.tag ?? 'latest')
      return { status: 'digest-watch', currentDigest: digest }
    } catch (err) {
      return { status: 'error', detail: (err as Error).message }
    }
  }

  const tagInclude = normaliseInclude(svc.tagInclude)

  let tags: string[]
  let observed: TagInfo[] = []
  let via: Source = 'registry'
  try {
    observed = await listTags(ref.registry, ref.repository)
    tags = observed.map((t) => t.tag)
  } catch (err) {
    if (err instanceof RepositoryNotFound) {
      return {
        status: 'not-published',
        detail: `${ref.registry}/${ref.repository} is not in the registry (locally built?)`,
      }
    }
    if (err instanceof TagListTooLarge) {
      // The repository tags every commit and PR (immich-machine-learning is past
      // 148,000 tags). Ask the source project what it released instead, and confirm
      // each candidate with a HEAD.
      //
      // This whole fallback runs INSIDE a catch block, so it needs its own guard --
      // resolveSource and probeByReleases both make network calls, and an exception
      // from either would otherwise escape detect() entirely and abort the scan.
      try {
        const resolved = await resolveSource({
          registry: ref.registry,
          repository: ref.repository,
          tag: ref.tag,
          sourceLabel: svc.sourceLabel,
        })
        const sourceRepo = resolved.sourceRepo ?? guessFromImagePath(ref.registry, ref.repository)
        if (!sourceRepo) {
          return {
            status: 'unresolvable',
            detail:
              `${err.message}, and no source repo is known to probe releases from -- ` +
              `add a shipshape.source label`,
          }
        }
        const probe = await probeByReleases({
          registry: ref.registry,
          repository: ref.repository,
          currentTag: ref.tag,
          sourceRepo,
          githubToken: env.githubToken,
        })
        if (probe.tags.length <= 1) {
          return {
            status: 'unresolvable',
            detail: `${err.message}; probing ${sourceRepo} releases confirmed no image tags`,
          }
        }
        observed = probe.tags.map((tag) => ({ tag }))
        tags = probe.tags
        via = 'releases'
      } catch (fallbackErr) {
        return {
          status: 'error',
          detail: `release probing failed: ${(fallbackErr as Error).message}`,
        }
      }
    } else {
      return { status: 'error', detail: (err as Error).message }
    }
  }

  const select = (available: string[]): Comparison =>
    selectUpdate({ currentTag: ref.tag!, availableTags: available, kind, tagInclude, regex: tagInclude })

  let cmp: Comparison = select(tags)

  // A prerelease is not an update.
  //
  // The registry publishes betas and stable builds with identical tag shapes -- n8n
  // ships 2.39.0 (prerelease) alongside 2.38.5 (stable) -- so nothing about the tag
  // itself can tell them apart, and 2.39.0 sorts higher. shipshape would target the
  // beta and then hold it on a changelog review that could not find its notes, because
  // `fetchReleases` had already filtered prereleases out. Two halves of the same
  // opinion, applied in one place and not the other.
  //
  // Done here, after a candidate exists, rather than by filtering the tag list up
  // front: the fetch costs nothing on the services that are up to date, which is most
  // of them on most scans.
  if (cmp.status === 'update') {
    const excluded = await prereleaseTagsAmong(svc, ref, ref.tag, tags)
    // Only re-run when the tag actually chosen is one of them. A project can have betas
    // in its history without the current candidate being one, and re-selecting then
    // would spend a comparison to reach the same answer.
    if (excluded.has(cmp.tag)) {
      // `kept` is a subset, so the worst this can do is report up-to-date. It never
      // widens the candidate set.
      cmp = select(tags.filter((t) => !excluded.has(t)))
    }
  }

  switch (cmp.status) {
    case 'update':
      return { status: 'update', tag: cmp.tag, magnitude: cmp.magnitude, via, observed }
    case 'up-to-date':
      return { status: 'up-to-date', via, observed, constrainedFrom: cmp.constrainedFrom }
    case 'unparseable-current':
      return { status: 'unparseable', detail: cmp.detail }
    case 'bad-refinement':
      return { status: 'bad-refinement', detail: cmp.detail }
    case 'not-orderable':
      return { status: 'digest-watch', currentDigest: null }
  }
}

/**
 * Which of these image tags the upstream project published as prereleases.
 *
 * Positive evidence only. A tag is excluded when it matches a GitHub release marked
 * `prerelease`, and never for the absence of one -- most images here have no release to
 * match at all (locally built, mirrored, or simply a project that does not cut GitHub
 * releases), and treating "no release" as "not a real version" would freeze them.
 *
 * Every failure path returns the empty set, so an unresolvable repo, a rate limit or a
 * GitHub outage costs nothing but the filter. Updates keep flowing on the old behaviour;
 * they do not stop.
 */
async function prereleaseTagsAmong(
  svc: ScannedService,
  ref: NonNullable<ScannedService['ref']>,
  currentTag: string,
  tags: string[],
): Promise<Set<string>> {
  try {
    const resolved = await resolveSource({
      registry: ref.registry,
      repository: ref.repository,
      tag: currentTag,
      sourceLabel: svc.sourceLabel,
    })
    const sourceRepo = resolved.sourceRepo ?? guessFromImagePath(ref.registry, ref.repository)
    if (!sourceRepo) return new Set()

    const pre = await fetchPrereleaseTags(sourceRepo)
    if (pre.size === 0) return new Set()
    return new Set(tags.filter((t) => pre.has(normaliseReleaseTag(t))))
  } catch {
    return new Set()
  }
}

/** Compose escapes a literal `$` as `$$`; the labels are read raw from the file, so the
 *  escape has to be undone before the string is used as a regex. */
function normaliseInclude(raw: string | null | undefined): string | null {
  return raw ? raw.replace(/\$\$/g, '$') : null
}
