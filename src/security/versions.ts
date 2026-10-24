/**
 * Version comparison for inventory matching, across the shapes syft reports: semver
 * (npm, binaries), PEP 440 (python), Debian and Alpine package versions, and the
 * free-form four-part versions vendors ship (Plex's `1.43.4.10903-e5521bd8c`).
 *
 * Deliberately one loose comparator rather than one strict parser per ecosystem. The
 * ranges it is compared against come out of an advisory's prose, which is written in
 * upstream versions ("before 22.23.4"), so what matters is reading the upstream part of
 * whatever a package manager reports and ordering it the way a person would.
 */

/** Package types whose version carries a packaging revision after the upstream version. */
const REVISIONED = new Set(['deb', 'apk', 'rpm', 'alpm'])

/**
 * The upstream version, as an advisory would write it.
 *
 * Strips a leading `v`, a Debian epoch (`1:`), and -- for distribution packages, or a
 * trailing build hash -- the packaging revision: `9.20.30-1~deb13u1` -> `9.20.30`,
 * `1.2.3-r0` -> `1.2.3`, `1.43.4.10903-e5521bd8c` -> `1.43.4.10903`.
 */
export function upstreamVersion(version: string, type?: string): string {
  let v = version.trim()
  v = v.replace(/^[vV](?=\d)/, '')
  v = v.replace(/^\d+:/, '')
  if (type && REVISIONED.has(type)) {
    const dash = v.lastIndexOf('-')
    if (dash > 0) v = v.slice(0, dash)
    // Debian's `+dfsg`, `~rc1` packaging suffixes on the upstream part.
    v = v.replace(/\+(dfsg|ds|repack)\d*$/i, '')
  } else {
    // A trailing hex build id is not a version component.
    v = v.replace(/-(?:g)?[0-9a-f]{7,40}$/i, '')
  }
  return v
}

type Token = number | string

/** Split a release into comparable tokens, and say where a pre-release begins. */
function parse(v: string): { release: Token[]; pre: Token[] | null } {
  // PEP 440 and semver pre-releases: 1.2.3-rc.1, 1.2.3rc1, 1.2.3a1, 1.2.3.dev4, 1.2.3-beta
  const m = v.match(/^([0-9][0-9._]*)(?:[-._]?((?:a|b|c|rc|alpha|beta|pre|preview|dev|canary|next|nightly|snapshot)[0-9a-z.]*))?(.*)$/i)
  const head = m ? m[1]! : v
  const preText = m?.[2] ?? null
  const rest = m?.[3] ?? ''
  const tokens = (s: string): Token[] =>
    s
      .split(/[._\-+]+|(?<=\d)(?=[a-z])|(?<=[a-z])(?=\d)/i)
      .filter((t) => t !== '')
      .map((t) => (/^\d+$/.test(t) ? Number(t) : t.toLowerCase()))
  const release = tokens(head.replace(/[._]+$/, ''))
  // A post-release (`1.2.3.post1`, `1.2.3-1`) sorts after the release: keep it in release.
  if (rest) release.push(...tokens(rest.replace(/^[-.]/, '')))
  return { release, pre: preText ? tokens(preText) : null }
}

function cmpTokens(a: Token[], b: Token[]): number {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined && y === undefined) return 0
    // A missing trailing component reads as 0: 22.23 == 22.23.0.
    if (x === undefined) return typeof y === 'number' ? (y === 0 ? 0 : -1) : -1
    if (y === undefined) return typeof x === 'number' ? (x === 0 ? 0 : 1) : 1
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x < y ? -1 : 1
      continue
    }
    // A number outranks a word at the same position (1.0.1 > 1.0.beta).
    if (typeof x === 'number') return 1
    if (typeof y === 'number') return -1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** -1, 0 or 1. Both arguments are compared in their upstream form. */
export function compareVersions(a: string, b: string, type?: string): number {
  const pa = parse(upstreamVersion(a, type))
  const pb = parse(upstreamVersion(b, type))
  const r = cmpTokens(pa.release, pb.release)
  if (r !== 0) return r
  // Same release: a pre-release sorts before the release itself.
  if (pa.pre && !pb.pre) return -1
  if (!pa.pre && pb.pre) return 1
  if (pa.pre && pb.pre) return cmpTokens(pa.pre, pb.pre)
  return 0
}

/** One affected interval. Every bound optional; an empty object means every version. */
export interface Range {
  gte?: string
  gt?: string
  lt?: string
  lte?: string
}

export function inRange(version: string, r: Range, type?: string): boolean {
  if (r.gte !== undefined && compareVersions(version, r.gte, type) < 0) return false
  if (r.gt !== undefined && compareVersions(version, r.gt, type) <= 0) return false
  if (r.lt !== undefined && compareVersions(version, r.lt, type) >= 0) return false
  if (r.lte !== undefined && compareVersions(version, r.lte, type) > 0) return false
  return true
}

/** Whether a version is affected by any of the ranges. No ranges at all means none is. */
export function affected(version: string, ranges: Range[], type?: string): boolean {
  return ranges.some((r) => inRange(version, r, type))
}

/** Something that reads as a version at all: it starts with a digit after the upstream strip. */
export function looksLikeVersion(version: string, type?: string): boolean {
  return /^\d/.test(upstreamVersion(version, type))
}
