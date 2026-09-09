import { env } from '../config.ts'

/**
 * Gathering the raw material a release judgement needs.
 *
 * Deliberately raw: release tag names are NOT normalised to match image tags before the
 * model sees them. Upstream tag conventions are chaotic -- `10.11.11ubu2604-ls43`,
 * `RELEASE.2025-09-07T16-13-09Z`, bare `v` prefixes appearing and disappearing between
 * releases -- and every regex written to reconcile them eventually matches the wrong
 * thing silently. Handing over the whole list and letting the model do the matching is
 * both more robust and auditable.
 */

export interface Release {
  tag: string
  name: string | null
  published: string | null
  body: string
}

export interface ChangelogBundle {
  sourceRepo: string | null
  releases: Release[]
  /** Commit subjects between the two tags, when the tags resolve on GitHub. */
  commits: string[]
  /** Container-level changes for LinuxServer images, which the app changelog omits. */
  containerChangelog: { date: string; desc: string }[]
  notes: string[]
}

async function ghJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'shipshape/0.1',
        ...(env.githubToken ? { authorization: `Bearer ${env.githubToken}` } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/** Releases newest first, trimmed so one enormous body cannot crowd out the rest. */
export async function fetchReleases(ownerRepo: string): Promise<Release[]> {
  const raw = await ghJson<
    { tag_name: string; name: string | null; published_at: string | null; body: string | null; draft: boolean; prerelease: boolean }[]
  >(`/repos/${ownerRepo}/releases?per_page=60`)
  if (!raw) return []
  return raw
    .filter((r) => !r.draft && !r.prerelease)
    .map((r) => ({
      tag: r.tag_name,
      name: r.name,
      published: r.published_at,
      body: (r.body ?? '').slice(0, 6000),
    }))
}

/**
 * The tags this project has published as prereleases, normalised for comparison.
 *
 * The other half of the filter two lines above. `fetchReleases` drops prereleases so the
 * changelog review never reads a beta's notes -- but detection never knew about them, so
 * shipshape would target a beta, then hold it on a review that truthfully reported the
 * version "does not exist in the release history". It had removed it itself.
 *
 * n8n is the case that surfaced it: 2.39.0 and 2.39.1 are prereleases while 2.38.5 is
 * the current stable. Both are published to the registry with identical tag shapes, so
 * no pattern or regex can separate them -- the release metadata is the only signal.
 *
 * Returns an empty set on any failure, and the caller treats empty as "no evidence" and
 * proceeds. Absence of a release must never withhold an update: plenty of images are
 * published without a GitHub release at all, and failing closed here would freeze them.
 */
export async function fetchPrereleaseTags(ownerRepo: string): Promise<Set<string>> {
  const raw = await ghJson<{ tag_name: string; draft: boolean; prerelease: boolean }[]>(
    `/repos/${ownerRepo}/releases?per_page=60`,
  )
  if (!raw) return new Set()
  return new Set(raw.filter((r) => r.prerelease && !r.draft).map((r) => normaliseReleaseTag(r.tag_name)))
}

/**
 * A release tag and an image tag, reduced to the part that can be compared.
 *
 * Projects prefix release tags in ways the registry does not: n8n publishes `n8n@2.39.0`
 * for the image `2.39.0`, and a leading `v` appears on one side or the other constantly.
 * Anything left unmatched simply is not treated as a prerelease, which is the safe
 * direction.
 */
export function normaliseReleaseTag(tag: string): string {
  const afterAt = tag.includes('@') ? tag.slice(tag.lastIndexOf('@') + 1) : tag
  return afterAt.trim().replace(/^v/i, '')
}

/** Commit subjects between two refs, when both resolve. Cheap context for projects that
 *  publish releases with empty bodies. */
export async function fetchCompare(ownerRepo: string, from: string, to: string): Promise<string[]> {
  for (const [a, b] of candidatePairs(from, to)) {
    const cmp = await ghJson<{ commits: { commit: { message: string } }[] }>(
      `/repos/${ownerRepo}/compare/${encodeURIComponent(a)}...${encodeURIComponent(b)}`,
    )
    if (cmp?.commits) {
      return cmp.commits.map((c) => c.commit.message.split('\n')[0]!).slice(0, 60)
    }
  }
  return []
}

function candidatePairs(from: string, to: string): [string, string][] {
  const strip = (s: string) => s.replace(/@sha256:.*$/, '')
  const f = strip(from)
  const t = strip(to)
  return [
    [f, t],
    [`v${f}`, `v${t}`],
    [f.replace(/^v/, ''), t.replace(/^v/, '')],
  ]
}

/** LinuxServer publishes container-level changes separately from the app's own. */
export async function fetchContainerChangelog(
  repository: string,
): Promise<{ date: string; desc: string }[]> {
  if (!repository.startsWith('linuxserver/')) return []
  const name = repository.slice('linuxserver/'.length)
  try {
    const res = await fetch(
      'https://api.linuxserver.io/api/v1/images?include_config=false&include_deprecated=false',
      { headers: { 'user-agent': 'shipshape/0.1' }, signal: AbortSignal.timeout(20_000) },
    )
    if (!res.ok) return []
    const body = (await res.json()) as {
      data?: { repositories?: Record<string, { name: string; changelog?: { date: string; desc: string }[] }[]> }
    }
    for (const list of Object.values(body.data?.repositories ?? {})) {
      const hit = list.find((i) => i.name === name)
      if (hit?.changelog) return hit.changelog.slice(0, 12)
    }
  } catch {
    // Optional context; its absence is not an error.
  }
  return []
}

export async function assemble(opts: {
  sourceRepo: string | null
  repository: string
  fromTag: string
  toTag: string
}): Promise<ChangelogBundle> {
  const notes: string[] = []
  const bundle: ChangelogBundle = {
    sourceRepo: opts.sourceRepo,
    releases: [],
    commits: [],
    containerChangelog: [],
    notes,
  }

  bundle.containerChangelog = await fetchContainerChangelog(opts.repository)

  if (!opts.sourceRepo) {
    notes.push(
      'No upstream source repository is known for this image, so no release notes could be fetched directly.',
    )
    return bundle
  }

  bundle.releases = await fetchReleases(opts.sourceRepo)
  if (bundle.releases.length === 0) {
    notes.push(`${opts.sourceRepo} publishes no GitHub releases.`)
  }
  bundle.commits = await fetchCompare(opts.sourceRepo, opts.fromTag, opts.toTag)
  return bundle
}
