/**
 * Tag pattern kinds.
 *
 * Every pattern's major slot is bounded to 1-3 digits. That is deliberate and load-
 * bearing: a bare `\d+` in the major position matches four-digit dates, and a naive
 * semver compare then ranks `2021.12.16` as newer than `2.17.0` forever. The repo this
 * was built for hit exactly that and encoded the `\d{1,3}` guard in every one of its 94
 * WUD tag regexes.
 */

export const PATTERN_KINDS = [
  'semver',
  'v-semver',
  // Two-component series are their own kind, never folded into semver. Precision is
  // preserved deliberately: `traefik:v3.7` must move to `v3.8`, never to `v3.8.0`,
  // because the compose file pins the shape the operator chose.
  'semver-minor',
  'v-semver-minor',
  // Four-component versions (apache/tika ships 3.3.1.0).
  'semver-quad',
  'major-only',
  'v-major-only',
  // "Version + variant" series: `postgres:16-alpine`, `grafana:12.4-ubuntu`,
  // `glances:4.5.4-full`, `minuspod:2.83.3-cpu`. The variant is captured and must match
  // exactly between the current tag and any candidate, so an `-alpine` pin can never
  // drift onto a plain tag (or onto `-bookworm`). These are separate kinds rather than
  // an implicit feature of `semver`, because implicit variant capture would silently
  // break the lsio kinds -- `2.2.0-ls374` would read as variant "ls374", unique to that
  // one build, and nothing would ever match it again.
  'semver-variant',
  'semver-minor-variant',
  'major-variant',
  'lsio-ls',
  'lsio-r-ls',
  'date',
  'digest',
  'latest',
  'regex',
] as const

export type PatternKind = (typeof PATTERN_KINDS)[number]

export function isPatternKind(s: string): s is PatternKind {
  return (PATTERN_KINDS as readonly string[]).includes(s)
}

/** A tag decomposed into comparable numeric components plus an opaque suffix. */
export interface ParsedTag {
  raw: string
  /** Ordered numeric components, most significant first. */
  parts: number[]
  /** Anything trailing that is compared lexically only as a tiebreak (rare). */
  suffix: string
  /** Flavour marker (`alpine`, `ubuntu`, `full`, `cpu`). Two tags are only comparable
   *  when their variants are identical -- a variant is a different image, not a newer
   *  version of the same one. */
  variant: string
}

const BUILTIN: Record<Exclude<PatternKind, 'regex' | 'latest' | 'digest'>, RegExp> = {
  // 2.17.0
  semver: /^(\d{1,3})\.(\d+)\.(\d+)$/,
  // v3.11.3
  'v-semver': /^v(\d{1,3})\.(\d+)\.(\d+)$/,
  // 12.4
  'semver-minor': /^(\d{1,3})\.(\d+)$/,
  // 3.3.1.0
  'semver-quad': /^(\d{1,3})\.(\d+)\.(\d+)\.(\d+)$/,
  // v3.7
  'v-semver-minor': /^v(\d{1,3})\.(\d+)$/,
  // 17
  'major-only': /^(\d{1,3})$/,
  // v2
  'v-major-only': /^v(\d{1,3})$/,
  // 2.2.0-ls374  (also matches a leading v, and an embedded distro marker like ubu2604)
  'lsio-ls': /^v?(\d{1,3})\.(\d+)\.(\d+)(?:[a-z]+\d*)?-ls(\d+)$/,
  // 5.1.4-r3-ls453
  'lsio-r-ls': /^v?(\d{1,3})\.(\d+)\.(\d+)-r(\d+)-ls(\d+)$/,
  // 2026.04.1  /  2026-07-28
  date: /^(\d{4})[.-](\d{1,2})[.-](\d{1,3})$/,
  // 4.5.4-full, 2.83.3-cpu  -- final group is the variant, not a number
  'semver-variant': /^(\d{1,3})\.(\d+)\.(\d+)-([A-Za-z][\w.]*)$/,
  // 12.4-ubuntu
  'semver-minor-variant': /^(\d{1,3})\.(\d+)-([A-Za-z][\w.]*)$/,
  // 16-alpine
  'major-variant': /^(\d{1,3})-([A-Za-z][\w.]*)$/,
}

/** Kinds whose LAST capture group is a variant string rather than a number. */
const VARIANT_KINDS = new Set<PatternKind>(['semver-variant', 'semver-minor-variant', 'major-variant'])

/**
 * Parse a tag under a pattern. Returns null when the tag does not belong to the series
 * -- which is how `latest`, `stable`, `nightly-*`, and unrelated variants get excluded
 * from comparison rather than mis-ranked.
 */
export function parseTag(tag: string, kind: PatternKind, customRegex?: string | null): ParsedTag | null {
  if (kind === 'latest' || kind === 'digest') {
    // Not orderable. Movement is detected by digest, never by comparing tag strings.
    return null
  }

  if (kind === 'regex') {
    if (!customRegex) return null
    let re: RegExp
    try {
      re = new RegExp(customRegex)
    } catch {
      return null
    }
    const m = re.exec(tag)
    if (!m) return null
    // Prefer named groups when supplied (major/minor/patch/build), else positional.
    const g = m.groups
    const nums = g
      ? ['major', 'minor', 'patch', 'build', 'revision'].map((k) => g[k]).filter((v): v is string => v !== undefined)
      : m.slice(1)
    const parts = nums.map((v) => Number(v)).filter((n) => Number.isFinite(n))
    return { raw: tag, parts, suffix: '', variant: g?.variant ?? '' }
  }

  const re = BUILTIN[kind]
  const m = re.exec(tag)
  if (!m) return null

  let groups = m.slice(1)
  let variant = ''
  if (VARIANT_KINDS.has(kind)) {
    variant = groups[groups.length - 1] ?? ''
    groups = groups.slice(0, -1)
  }

  const parts = groups.map(Number)
  if (parts.some((n) => !Number.isFinite(n))) return null
  return { raw: tag, parts, suffix: '', variant }
}

/** Numeric component-wise comparison. Missing components sort as 0. */
export function compareTags(a: ParsedTag, b: ParsedTag): number {
  const n = Math.max(a.parts.length, b.parts.length)
  for (let i = 0; i < n; i++) {
    const x = a.parts[i] ?? 0
    const y = b.parts[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  if (a.suffix === b.suffix) return 0
  return a.suffix < b.suffix ? -1 : 1
}

export type Magnitude = 'major' | 'minor' | 'patch' | 'digest'

/**
 * Which slot changed. For the LSIO kinds the upstream version occupies the first three
 * slots and the packaging build counter the rest, so a pure `-lsN` bump is correctly a
 * patch -- the app did not change, only the container did.
 */
export function classify(from: ParsedTag, to: ParsedTag, kind: PatternKind): Magnitude {
  const a = from.parts
  const b = to.parts
  if ((a[0] ?? 0) !== (b[0] ?? 0)) return 'major'

  // A single-component series ("17" -> "18") only ever moves its major.
  if (kind === 'major-only' || kind === 'v-major-only') return 'major'

  // Variant kinds classify on their numeric prefix; `major-variant` has only one slot.
  if (kind === 'major-variant') return 'major'

  // A two-component series has no patch slot, so second-slot movement is a minor.
  if (kind === 'semver-minor' || kind === 'v-semver-minor' || kind === 'semver-minor-variant') {
    return (a[1] ?? 0) !== (b[1] ?? 0) ? 'minor' : 'patch'
  }

  // Date tags: treat the year as major, the month as minor, the rest as patch. A year
  // rollover is not semantically breaking, but it is the coarsest movement available
  // and deserves a human, which the major tier provides.
  if ((a[1] ?? 0) !== (b[1] ?? 0)) return 'minor'
  if ((a[2] ?? 0) !== (b[2] ?? 0)) return 'patch'
  return 'patch'
}

/**
 * Best-effort inference of the pattern kind from a concrete tag, used by the label
 * migration to seed `shipshape.pattern`. Order matters: the most specific shapes are
 * tested first.
 */
export function inferPattern(tag: string): PatternKind | null {
  if (BUILTIN['lsio-r-ls'].test(tag)) return 'lsio-r-ls'
  if (BUILTIN['lsio-ls'].test(tag)) return 'lsio-ls'
  if (BUILTIN.date.test(tag)) return 'date'
  if (BUILTIN['semver-quad'].test(tag)) return 'semver-quad'
  if (BUILTIN['semver-variant'].test(tag)) return 'semver-variant'
  if (BUILTIN['v-semver'].test(tag)) return 'v-semver'
  if (BUILTIN.semver.test(tag)) return 'semver'
  if (BUILTIN['v-semver-minor'].test(tag)) return 'v-semver-minor'
  if (BUILTIN['semver-minor'].test(tag)) return 'semver-minor'
  if (BUILTIN['semver-minor-variant'].test(tag)) return 'semver-minor-variant'
  if (BUILTIN['v-major-only'].test(tag)) return 'v-major-only'
  if (BUILTIN['major-only'].test(tag)) return 'major-only'
  if (BUILTIN['major-variant'].test(tag)) return 'major-variant'
  if (/^(latest|stable|main|master|edge|nightly|apache|stable-alpine)$/.test(tag)) return 'latest'
  return null
}
