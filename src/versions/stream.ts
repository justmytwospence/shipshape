import { compareKeys, sameVersion, versionKey, type VersionKey } from './key.ts'

/**
 * Whether a service follows its project's stable releases or its prereleases.
 *
 * A GitHub prerelease is not an update for a service on the stable line: n8n publishes
 * 2.39.0 as a prerelease beside a stable 2.38.5, the registry cannot tell them apart, and
 * 2.39.0 sorts higher. But the same rule applied to every service freezes the ones whose
 * maintainers mark nearly every release a prerelease -- minuspod has 5 stable releases out
 * of 32, and the version running here, 2.96.17, sits on the prerelease line. An operator
 * running a prerelease has already chosen that stream.
 *
 * So the stream is read from where the service is now:
 *
 * 1. A floating or unparseable tag: unknown, and nothing is set aside.
 * 2. A running tag that is itself a prerelease (`1.3.0-rc.1`): the prerelease stream.
 * 3. No release to compare against: unknown.
 * 4. A release for the running version: its flag decides.
 * 5. Otherwise the nearest release below the running version decides; a version older than
 *    every release fetched is on the stable line, the conservative default.
 *
 * Only the stable stream sets anything aside. Pure, so every case is a table test.
 */

export interface StreamRelease {
  tag: string
  key: VersionKey | null
  prerelease: boolean
}

export interface Stream {
  stream: 'stable' | 'prerelease' | 'unknown'
  /** Why, in words, for the event log. */
  basis: string
}

export function prereleaseStream(currentTag: string, releases: StreamRelease[]): Stream {
  const cur = versionKey(currentTag)
  if (!cur || cur.partial) {
    return { stream: 'unknown', basis: `${currentTag} is a floating tag or not a version` }
  }
  if (cur.pre) return { stream: 'prerelease', basis: `the running tag ${currentTag} is itself a prerelease` }

  const comparable = releases.filter(
    (r): r is StreamRelease & { key: VersionKey } =>
      !!r.key && !r.key.partial && compareKeys(r.key, cur) !== null,
  )
  if (comparable.length === 0) return { stream: 'unknown', basis: 'no release to compare against' }

  const exact = comparable.find((r) => sameVersion(r.key, cur))
  if (exact) {
    return exact.prerelease
      ? { stream: 'prerelease', basis: `the running version's release, ${exact.tag}, is a prerelease` }
      : { stream: 'stable', basis: `the running version's release, ${exact.tag}, is stable` }
  }

  let below: (StreamRelease & { key: VersionKey }) | null = null
  for (const r of comparable) {
    if ((compareKeys(r.key, cur) ?? 0) >= 0) continue
    if (!below || (compareKeys(r.key, below.key) ?? 0) > 0) below = r
  }
  if (!below) return { stream: 'stable', basis: `${currentTag} is older than every release fetched` }
  return below.prerelease
    ? { stream: 'prerelease', basis: `the nearest release below it, ${below.tag}, is a prerelease` }
    : { stream: 'stable', basis: `the nearest release below it, ${below.tag}, is stable` }
}

/**
 * The image tags to set aside: on the stable stream, those whose version was published as a
 * prerelease and never as a release. On any other stream, none. Positive evidence only -- a
 * tag with no matching release is never excluded for the lack of one.
 */
export function prereleaseExclusions(tags: string[], releases: StreamRelease[], s: Stream): Set<string> {
  if (s.stream !== 'stable') return new Set()
  const usable = releases.filter((r): r is StreamRelease & { key: VersionKey } => !!r.key && !r.key.partial)
  const pre = usable.filter((r) => r.prerelease)
  const stable = usable.filter((r) => !r.prerelease)
  if (pre.length === 0) return new Set()
  return new Set(
    tags.filter((t) => {
      const k = versionKey(t)
      if (!k || k.partial) return false
      return pre.some((r) => sameVersion(r.key, k)) && !stable.some((r) => sameVersion(r.key, k))
    }),
  )
}
