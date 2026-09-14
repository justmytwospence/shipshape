import { getDb } from '../db.ts'
import { inferPattern, parseTag } from '../versions/patterns.ts'
import { registryFetch } from './http.ts'

/**
 * Release-driven candidate probing.
 *
 * Some repositories publish a tag per commit and per pull request. Measured on this
 * one real deployment: `ghcr.io/immich-app/immich-machine-learning` is past 148,000 tags and still
 * paginating after three minutes, and `docker.openhands.dev/openhands/openhands` carries
 * ~70,000. Enumerating those to find one release tag is hopeless, and ghcr returns tags
 * oldest-first so a truncated walk finds nothing useful.
 *
 * The inversion: ask the *source repo* what it released -- GitHub's releases endpoint is
 * newest-first, cheap, and paginated sanely -- then ask the registry only whether a
 * specific candidate tag exists. That is a handful of HEAD requests instead of 1,500
 * pages, and HEAD is not billed against the Docker Hub pull budget.
 */

export interface ProbeResult {
  /** Tags confirmed to exist in the registry, newest release first. */
  tags: string[]
  /** Release names that were checked, for diagnostics. */
  checked: number
}

/** How many recent releases to consider. Enough to cross a long-stale gap without
 *  turning into its own enumeration problem. */
const MAX_RELEASES = 40

/**
 * Candidate image tags derived from a release name. Registries and git tags disagree about
 * the `v` prefix often enough that both spellings are worth a probe, and a `pkg@1.2.3`
 * release publishes images without the package name. A variant image keeps its flavour: a
 * `2.96.17-cpu` pin probes `2.96.22-cpu` for release `v2.96.22`. Each guess costs one HEAD.
 */
export function candidateTagsFor(releaseTag: string, currentTag?: string): string[] {
  const base = releaseTag.includes('@') ? releaseTag.slice(releaseTag.lastIndexOf('@') + 1) : releaseTag
  const spellings = base.startsWith('v') ? [base, base.slice(1)] : [base, `v${base}`]
  const out = new Set<string>(spellings)
  const variant = currentTag ? variantOf(currentTag) : null
  if (variant) for (const s of spellings) out.add(`${s}-${variant}`)
  return [...out]
}

function variantOf(tag: string): string | null {
  const kind = inferPattern(tag)
  if (kind !== 'semver-variant' && kind !== 'semver-minor-variant' && kind !== 'major-variant') return null
  return parseTag(tag, kind)?.variant || null
}

/**
 * True when the tag resolves in the registry. HEAD only -- never billed against the
 * Docker Hub pull budget.
 *
 * Confirmed tags are remembered in `tags_seen`, and that cache is consulted first. A
 * published tag never stops existing, so a positive answer is permanently valid, and
 * without this every nightly scan would re-HEAD ~40 releases per pathological
 * repository -- which is exactly how the second scan of the day got rate-limited by
 * ghcr.io. Negative answers are NOT cached: a release can gain an image tag later.
 */
export async function tagExists(
  registry: string,
  repository: string,
  tag: string,
): Promise<boolean> {
  const known = getDb()
    .prepare(`SELECT 1 AS hit FROM tags_seen WHERE registry = ? AND repository = ? AND tag = ?`)
    .get(registry, repository, tag) as { hit: number } | undefined
  if (known) return true

  const host = registry === 'docker.io' ? 'registry-1.docker.io' : registry
  try {
    const res = await registryFetch(`https://${host}/v2/${repository}/manifests/${tag}`, {
      method: 'HEAD',
      accept: [
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.docker.distribution.manifest.v2+json',
      ].join(','),
    })
    if (res.ok) {
      getDb()
        .prepare(
          `INSERT INTO tags_seen (registry, repository, tag, digest, published_at, first_seen_at)
           VALUES (?, ?, ?, ?, NULL, ?)
           ON CONFLICT(registry, repository, tag) DO UPDATE SET
             digest = COALESCE(excluded.digest, tags_seen.digest)`,
        )
        .run(registry, repository, tag, res.headers.get('docker-content-digest'), new Date().toISOString())
    }
    return res.ok
  } catch {
    return false
  }
}

/**
 * Build a candidate tag list for a repository that is too large to enumerate, by
 * confirming which recent upstream releases actually exist as image tags.
 *
 * Returns the confirmed tags plus the current tag, which is what the ordinary comparator
 * then reasons over -- so pattern semantics, variant isolation and magnitude
 * classification all behave identically to the enumerated path.
 */
export async function probeByReleases(opts: {
  registry: string
  repository: string
  currentTag: string
  /** The project's releases, newest first, from the release index. Prereleases included:
   *  whether one is an update is decided afterwards, by the stream the service is on. */
  releases: { tag: string }[]
}): Promise<ProbeResult> {
  const { registry, repository, currentTag } = opts
  const confirmed: string[] = [currentTag]
  let checked = 0

  for (const rel of opts.releases.slice(0, MAX_RELEASES)) {
    checked++
    for (const cand of candidateTagsFor(rel.tag, currentTag)) {
      if (cand === currentTag) continue
      if (await tagExists(registry, repository, cand)) {
        confirmed.push(cand)
        break
      }
    }
  }
  return { tags: confirmed, checked }
}
