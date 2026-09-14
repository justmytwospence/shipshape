import { getDb } from '../db.ts'
import { ghRequest } from '../upstream/github.ts'
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

interface GhRelease {
  tag_name: string
  draft: boolean
  prerelease: boolean
  published_at: string | null
}

/**
 * Candidate image tags derived from a release name. Registries and git tags disagree
 * about the `v` prefix often enough that both spellings are worth a probe -- this is
 * cheap, and guessing wrong costs one HEAD.
 */
export function candidateTagsFor(releaseTag: string): string[] {
  const out = new Set<string>()
  out.add(releaseTag)
  if (releaseTag.startsWith('v')) out.add(releaseTag.slice(1))
  else out.add(`v${releaseTag}`)
  return [...out]
}

export async function fetchReleases(
  ownerRepo: string,
  githubToken: string,
): Promise<GhRelease[]> {
  // Through the shared client, which gives this call the timeout it never had -- a hung
  // connection here used to hold detection open indefinitely.
  const res = await ghRequest<GhRelease[]>(
    `/repos/${ownerRepo}/releases?per_page=${MAX_RELEASES}`,
    { token: githubToken },
  )
  if (!res.ok) {
    // Unreachable is still an exception, as it was when fetch threw: the caller reports
    // "release probing failed" rather than claiming the releases confirmed no tags.
    if (res.kind === 'network') throw new Error(res.detail)
    return []
  }
  return res.data.filter((r) => !r.draft && !r.prerelease)
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
  sourceRepo: string
  githubToken: string
}): Promise<ProbeResult> {
  const { registry, repository, currentTag, sourceRepo, githubToken } = opts
  const releases = await fetchReleases(sourceRepo, githubToken)
  const confirmed: string[] = [currentTag]
  let checked = 0

  for (const rel of releases) {
    checked++
    for (const cand of candidateTagsFor(rel.tag_name)) {
      if (cand === currentTag) continue
      if (await tagExists(registry, repository, cand)) {
        confirmed.push(cand)
        break
      }
    }
  }
  return { tags: confirmed, checked }
}
