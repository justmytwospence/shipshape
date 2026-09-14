import { inferPattern, parseTag, type PatternKind } from './patterns.ts'

/**
 * A version, reduced to what two differently shaped tags have in common.
 *
 * A release tag and an image tag name the same version in different shapes: `v2.96.22`
 * and `2.96.22-cpu`, `n8n@2.39.0` and `2.39.0`, `v4.137.0` and `4.137.0-ls364`,
 * `version-v2.7.1` and `v2.7.1`. Comparing them as strings with a leading `v` stripped
 * missed 20 of the 42 upstream sources this lab resolves, which is why a minuspod beta was
 * never recognised as one.
 *
 * The tag patterns already take image tags apart for ordering, so this reuses them and adds
 * only what release tags need beyond that: a package or branch prefix, a dash-encoded
 * version, a prerelease word stuck to the number. Two rules keep it conservative, because a
 * wrong match here withholds a real update:
 *
 * - A floating tag (`16`, `12.4-ubuntu`) is marked `partial` and callers never let it stand
 *   for a release.
 * - A packaging build (LinuxServer's `-ls364`) only has to agree when both sides carry one,
 *   so `4.137.0-ls364` is the same version as upstream's `v4.137.0` but not as `-ls363`.
 *
 * What stays unmatched, on purpose: plex's build strings, commit shas, `RELEASE.<timestamp>`
 * tags, and wrapper images versioned after a different project.
 */

export interface VersionKey {
  family: 'semver' | 'date'
  /** Numeric components, most significant first. */
  core: number[]
  /** `alpha.1`, `beta.2`, `rc.1`, `dev`; null for a release. */
  pre: string | null
  /** A packaging build: LinuxServer's `[ls]` or `[r, ls]`, a package revision. */
  build: number[]
  /** A floating tag naming a line rather than one release. */
  partial: boolean
  raw: string
}

const PRE_WORD = /^(alpha|beta|rc|pre|preview|dev|nightly|canary|next|a|b)[.-]?(\d*)$/i

const VARIANT_KINDS = new Set<PatternKind>(['semver-variant', 'semver-minor-variant', 'major-variant'])
const PARTIAL_KINDS = new Set<PatternKind>([
  'semver-minor',
  'v-semver-minor',
  'major-only',
  'v-major-only',
  'semver-minor-variant',
  'major-variant',
])

export function versionKey(tag: string | null | undefined): VersionKey | null {
  if (!tag) return null
  let s = tag.trim().replace(/@sha256:[0-9a-f]+$/i, '')
  // `n8n@2.39.0`: the version is what follows the last `@`.
  if (s.includes('@')) s = s.slice(s.lastIndexOf('@') + 1)
  if (!s) return null
  // A commit sha is not a version, however many digits it happens to contain.
  if (/^[0-9a-f]{7,40}$/i.test(s) && /[a-f]/i.test(s)) return null
  return fromPattern(s, tag) ?? fromText(s, tag)
}

/** Same release. Builds only have to agree when both sides carry one. */
export function sameVersion(a: VersionKey, b: VersionKey): boolean {
  if (a.family !== b.family) return false
  if (compareNums(a.core, b.core) !== 0) return false
  if (a.pre !== b.pre) return false
  if (a.build.length > 0 && b.build.length > 0) return compareNums(a.build, b.build) === 0
  return true
}

/** Order two versions, or null when they cannot be compared (a date against a semver). */
export function compareKeys(a: VersionKey, b: VersionKey): number | null {
  if (a.family !== b.family) return null
  const core = compareNums(a.core, b.core)
  if (core !== 0) return core
  if (a.pre !== b.pre) {
    // A release outranks any prerelease of the same version.
    if (a.pre === null) return 1
    if (b.pre === null) return -1
    const [an, anum] = splitPre(a.pre)
    const [bn, bnum] = splitPre(b.pre)
    const ar = PRE_RANK[an] ?? 0
    const br = PRE_RANK[bn] ?? 0
    if (ar !== br) return ar < br ? -1 : 1
    if (anum !== bnum) return anum < bnum ? -1 : 1
    return an < bn ? -1 : an > bn ? 1 : 0
  }
  return compareNums(a.build, b.build)
}

/** `from < k <= to`. A null `from` means everything up to `to`. */
export function inRange(k: VersionKey, from: VersionKey | null, to: VersionKey): boolean {
  const upper = compareKeys(k, to)
  if (upper === null || upper > 0) return false
  if (!from) return true
  const lower = compareKeys(k, from)
  return lower !== null && lower > 0
}

// ------------------------------------------------------------------ internals

const PRE_RANK: Record<string, number> = { dev: 0, nightly: 0, canary: 0, next: 0, alpha: 1, beta: 2, pre: 3, preview: 3, rc: 4 }

function splitPre(pre: string): [string, number] {
  const [name, num] = pre.split('.')
  return [name ?? '', num ? Number(num) : 0]
}

function normalisePre(s: string): string | null {
  const m = PRE_WORD.exec(s)
  if (!m) return null
  const word = m[1]!.toLowerCase()
  const name = word === 'a' ? 'alpha' : word === 'b' ? 'beta' : word
  return m[2] ? `${name}.${Number(m[2])}` : name
}

function compareNums(x: number[], y: number[]): number {
  const n = Math.max(x.length, y.length)
  for (let i = 0; i < n; i++) {
    const a = x[i] ?? 0
    const b = y[i] ?? 0
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/** Shapes the image tag patterns already understand. */
function fromPattern(s: string, raw: string): VersionKey | null {
  const kind = inferPattern(s)
  if (!kind || kind === 'latest' || kind === 'digest' || kind === 'regex') return null
  const p = parseTag(s, kind)
  if (!p) return null
  if (kind === 'lsio-ls' || kind === 'lsio-r-ls') {
    // The upstream version is the first three slots; the rest is the packaging build.
    return { family: 'semver', core: p.parts.slice(0, 3), pre: null, build: p.parts.slice(3), partial: false, raw }
  }
  if (kind === 'date') return { family: 'date', core: p.parts, pre: null, build: [], partial: false, raw }
  // `1.2.3-rc.1` parses as a variant called `rc.1`. It is a prerelease, not a flavour.
  const pre = VARIANT_KINDS.has(kind) && p.variant ? normalisePre(p.variant) : null
  return { family: 'semver', core: p.parts, pre, build: [], partial: PARTIAL_KINDS.has(kind), raw }
}

/** Release-tag shapes the image patterns do not cover. */
function fromText(s: string, raw: string): VersionKey | null {
  // `version-v2.7.1`, `release-1.2.3`
  let t = s.replace(/^(?:version|release|rel|ver)[-_]?(?=v?\d)/i, '')
  // A package or branch prefix: `mariadb-10.11.8`, `develop-v2.19.0-ls10`. Never `v0-...`,
  // whose "prefix" is the major version.
  t = t.replace(/^(?!v\d)[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z][A-Za-z0-9]*)*[-_](?=v?\d)/, '')
  if (t !== s) {
    const k = fromPattern(t, raw)
    if (k) return k
  }
  t = t.replace(/^v(?=\d)/i, '')

  // Dash-encoded, with a packaging revision on the end: `0-14-7-1` is 0.14.7.
  const dashed = /^(\d{1,3})-(\d+)-(\d+)(?:-(\d+))?$/.exec(t)
  if (dashed) {
    return {
      family: 'semver',
      core: [Number(dashed[1]), Number(dashed[2]), Number(dashed[3])],
      pre: null,
      build: dashed[4] ? [Number(dashed[4])] : [],
      partial: false,
      raw,
    }
  }

  // A prerelease word stuck to the number: `1.2.3b2`, `2.0.0rc1`.
  const pre = /^(\d{1,3}(?:\.\d+){0,3})[-.]?((?:alpha|beta|rc|pre|preview|dev|a|b)[.-]?\d*)(?:[-+].*)?$/i.exec(t)
  if (pre) {
    return { family: 'semver', core: pre[1]!.split('.').map(Number), pre: normalisePre(pre[2]!), build: [], partial: false, raw }
  }

  // Anything else that starts with a dotted version: keep the number, drop the rest.
  const generic = /^(\d{1,3}(?:\.\d+){1,3})(?:[-+_].*)?$/.exec(t)
  if (generic) {
    return { family: 'semver', core: generic[1]!.split('.').map(Number), pre: null, build: [], partial: false, raw }
  }
  return null
}
