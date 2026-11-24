import { getDb } from '../db/index.ts'
import { readLabels, pickLabel } from './labels.ts'
import type { ImageKey, SourceOpts, SourceInfo } from './types.ts'
import { resetLsioMemo } from './lsio.ts'
import { compose, readRow, isStale, currentTagFor, type ResolutionRow, writeResolution } from './cache.ts'
import { lookUpImage } from './tiers.ts'


/**
 * Image -> upstream source repository, and the one way to ask.
 *
 * Measured across one real deployment's images: only about half carry an OCI annotation
 * pointing at the project that actually writes the release notes. Roughly a quarter point
 * at a *packaging* repo -- `traefik` -> `traefik-library-image`, every LinuxServer image ->
 * `linuxserver/docker-<app>` -- which is technically correct and useless. The rest carry
 * nothing.
 *
 * Two things about the answer used to be wrong, and both are why this module has one
 * accessor now.
 *
 * - **Labels were applied by some callers and not others.** `shipshape.source` short-
 *   circuited only when a caller remembered to pass it, and five of eight did not -- the
 *   changelog review among them -- so a labelled service was reviewed as if its upstream
 *   were unknown. `sourceFor` and `sourceForSync` apply labels themselves, per image: a
 *   label on one service links every service running that image, the requesting service's
 *   own label wins, and disagreements are reported rather than settled silently. Labels
 *   live in git and are never copied into the cache, so changing one needs no invalidation.
 *
 * - **Every answer was cached forever, failures included.** A Docker Hub budget stop, a 429
 *   or a timeout during the manifest walk became a `none` that was returned for good, and a
 *   resolver improvement never reached an image that already had a row. A failure is now
 *   recorded as a failure and retried with backoff; a found repository is kept; a clean
 *   "nothing found" is looked at again after a week; and rows written by an older resolver
 *   are re-resolved.
 *
 * The tiers, in order, stopping at the first answer that is certain:
 *
 * | Tier          | Signal                                                   | Confidence |
 * |---------------|----------------------------------------------------------|------------|
 * | `override`    | the curated map below                                    | high |
 * | `lsio`        | LinuxServer's API, when its project URL is on GitHub     | high |
 * | `lsio-build`  | the repository LinuxServer's build file reads releases from | high |
 * | `annotation`  | an OCI source annotation on the manifest                 | high |
 * | `ghcr-path`   | `ghcr.io/owner/name` is `owner/name`                     | high |
 * | `description` | a link in the registry's description of the image        | high when name and owner match, else medium |
 * | `annotation`  | a source label in the image config, unless inherited     | high when name or owner match, else medium |
 * | `lookup`      | a GitHub repository with the image's owner and name      | medium |
 *
 * Two tiers naming the same repository make it certain. Every inferred repository is checked
 * against GitHub first -- it must exist, and a fork counts only under the image's own owner.
 * On Docker Hub the manifest walk costs pulls, so there the free tiers go before it, and the
 * sweep during a scan skips it: such an image is looked at again, walk included, when
 * something needs its notes.
 *
 * Only a certain answer counts as linked where trust is extended (the screen's `routine`
 * requires it: see analyze/screen/decide.ts).
 * A likely one is still good enough to read release notes from.
 */


// ------------------------------------------------------------------ the accessor

/** The answer from what is already known: cache plus labels, never the network. */
export function sourceForSync(image: ImageKey, opts: SourceOpts = {}): SourceInfo {
  return compose(readLabels(image), readRow(image), opts)
}

/** The same answer, looking the image up first when nothing is cached or the row is due. */
export async function sourceFor(image: ImageKey, opts: SourceOpts = {}): Promise<SourceInfo> {
  const labels = readLabels(image)
  let row = readRow(image)
  const allowBilled = opts.allowBilled ?? true
  // A label answers the question by itself. Looking the image up anyway would spend Docker
  // Hub pulls on an answer nothing reads -- so only a forced look goes ahead regardless.
  const { label } = pickLabel(labels, opts)
  if (opts.force || (!label && (!row || isStale(row, Date.now(), allowBilled, image)))) {
    row = await resolveImage(image, opts.tag ?? currentTagFor(image), row, { allowBilled })
  }
  return compose(labels, row, opts)
}

/**
 * Look up the watched images whose answer is missing or due, a bounded number at a time.
 *
 * Without this an image was looked up only when an update needed its release notes, so
 * most of them never were, and the Services page called them unresolved indefinitely. The
 * scan runs it unbilled: a Docker Hub image that needs the manifest walk gets it later, when
 * an update, a review or "Look again" asks.
 */
export async function resolveWatched(
  o: { allowBilled?: boolean; limit?: number; budgetMs?: number } = {},
): Promise<{ looked: number; linked: number; failed: number; due: number }> {
  const allowBilled = o.allowBilled ?? false
  const limit = o.limit ?? 60
  const budgetMs = o.budgetMs ?? 90_000
  const started = Date.now()

  const due = watchedImages()
    .filter((i) => !pickLabel(readLabels(i), {}).label)
    .map((i) => ({ image: i, row: readRow(i) }))
    .filter((i) => !i.row || isStale(i.row, started, allowBilled, i.image))
    // Never looked up first, then whichever has waited longest.
    .sort((a, b) => (a.row?.checked_at ?? '').localeCompare(b.row?.checked_at ?? ''))

  const out = { looked: 0, linked: 0, failed: 0, due: due.length }
  for (const { image, row } of due) {
    if (out.looked >= limit || Date.now() - started >= budgetMs) break
    out.looked++
    try {
      const after = await resolveImage(image, currentTagFor(image), row, { allowBilled })
      if (after?.source_url && after.confidence === 'high') out.linked++
      if (after?.error) out.failed++
    } catch {
      // Writing the answer failed, which is a bug rather than an upstream's doing. One image.
      out.failed++
    }
  }
  return out
}

/** How many watched images have a certain upstream, a likely one, or none -- for Status. */
export function sourceCounts(): {
  total: number
  linked: number
  likely: number
  notFound: number
  notLooked: number
  failing: number
} {
  const out = { total: 0, linked: 0, likely: 0, notFound: 0, notLooked: 0, failing: 0 }
  for (const image of watchedImages()) {
    const s = sourceForSync(image)
    out.total++
    if (s.repo && s.confidence === 'high') out.linked++
    else if (s.repo) out.likely++
    else if (!s.inferred) out.notLooked++
    else out.notFound++
    if (s.error) out.failing++
  }
  return out
}

/** Tests only: forget memoised upstream answers between cases. */
export function resetResolverMemo(): void {
  resetLsioMemo()
}

/** ghcr images very often live in the repo whose path they mirror. Used only as a probe
 *  hint when nothing else resolved -- never written to the cache as a real resolution. */
export function guessFromImagePath(registry: string, repository: string): string | null {
  if (registry !== 'ghcr.io') return null
  const parts = repository.split('/')
  if (parts.length < 2) return null
  return `${parts[0]}/${parts[1]}`
}

function watchedImages(): ImageKey[] {
  return getDb()
    .prepare(
      `SELECT DISTINCT registry, repository FROM images
       WHERE watched = 1 AND repository IS NOT NULL AND repository != ''
       ORDER BY registry, repository`,
    )
    .all() as ImageKey[]
}

// ------------------------------------------------------------------ labels


// ------------------------------------------------------------------ the cache


async function resolveImage(
  image: ImageKey,
  tag: string | null,
  prior: ResolutionRow | null,
  o: { allowBilled: boolean },
): Promise<ResolutionRow | null> {
  const found = await lookUpImage(image, tag, o)
  writeResolution(image, found, prior)
  return readRow(image)
}

// ------------------------------------------------------------------ looking it up
