import { affected, looksLikeVersion, type Range } from './versions.ts'

/**
 * Matching an incident's extracted targets against an image inventory. Pure.
 *
 * The feed's prose is turned into {@link Target}s once, by a model (extract.ts). From here
 * on nothing is judged: a package either is in the inventory with a version inside an
 * affected range, or it is not.
 */

/** Where a package comes from, as the extraction names it. */
export const ECOSYSTEMS = ['binary', 'npm', 'pypi', 'go', 'gem', 'maven', 'cargo', 'deb', 'apk', 'any'] as const
export type Ecosystem = (typeof ECOSYSTEMS)[number]

export interface Target {
  ecosystem: Ecosystem
  /** Package names as a package manager or syft would report them. */
  names: string[]
  /** Affected intervals. Empty means the target names nothing matchable. */
  affected: Range[]
  /** Fixed versions, for people. Never consulted by the matcher. */
  fixed: string[]
}

/** One row of an inventory: syft's package type, name and version. */
export interface Package {
  type: string
  name: string
  version: string
  path?: string | null
}

/** syft package types an ecosystem covers. `any` covers all of them. */
const TYPES: Record<Exclude<Ecosystem, 'any'>, string[]> = {
  binary: ['binary'],
  npm: ['npm'],
  pypi: ['python'],
  go: ['go-module'],
  gem: ['gem'],
  maven: ['java-archive'],
  cargo: ['rust-crate'],
  deb: ['deb'],
  apk: ['apk'],
}

/**
 * The name as compared. PyPI treats `-`, `_` and `.` as one (PEP 503); everything is
 * compared case-insensitively.
 */
export function normaliseName(name: string, type?: string): string {
  const n = name.trim().toLowerCase()
  return type === 'python' || type === 'pypi' ? n.replace(/[-_.]+/g, '-') : n
}

function typeMatches(eco: Ecosystem, type: string): boolean {
  return eco === 'any' || TYPES[eco].includes(type)
}

export interface Hit {
  type: string
  name: string
  version: string
  /** The fixed versions the target lists, for the card. */
  fixed: string[]
}

/**
 * Every package in the inventory a target marks affected, one per (type, name, version).
 */
export function matchPackages(targets: Target[], packages: Package[]): Hit[] {
  const out = new Map<string, Hit>()
  for (const t of targets) {
    if (t.affected.length === 0 || t.names.length === 0) continue
    for (const p of packages) {
      if (!typeMatches(t.ecosystem, p.type)) continue
      const pn = normaliseName(p.name, p.type)
      if (!t.names.some((n) => normaliseName(n, p.type) === pn)) continue
      if (!looksLikeVersion(p.version, p.type)) continue
      if (!affected(p.version, t.affected, p.type)) continue
      const key = `${p.type}\u0000${pn}\u0000${p.version}`
      if (!out.has(key)) out.set(key, { type: p.type, name: p.name, version: p.version, fixed: t.fixed })
    }
  }
  return [...out.values()]
}

export interface FixCheck {
  verified: boolean
  /** Per exposed package: what the candidate carries instead. */
  evidence: { type: string; name: string; from: string; to: string[] }[]
  /** Why it is not verified, when it is not. */
  reason?: string
}

/**
 * Whether a candidate image removes every exposure the running image has to one incident.
 *
 * Verified only when each exposed (type, name) is present in the candidate and none of
 * its versions there is affected. A package that vanished is not proof of anything --
 * the inventory may simply have stopped seeing it -- so it does not verify.
 */
export function checkFix(targets: Target[], running: Hit[], candidate: Package[]): FixCheck {
  if (running.length === 0) return { verified: false, evidence: [], reason: 'nothing to fix' }
  const stillHit = matchPackages(targets, candidate)
  const evidence: FixCheck['evidence'] = []
  for (const h of running) {
    const pn = normaliseName(h.name, h.type)
    const same = candidate.filter((p) => p.type === h.type && normaliseName(p.name, p.type) === pn)
    const versions = [...new Set(same.map((p) => p.version))]
    evidence.push({ type: h.type, name: h.name, from: h.version, to: versions })
    if (versions.length === 0) {
      return { verified: false, evidence, reason: `${h.name} is not in the new image's inventory` }
    }
    const bad = stillHit.find((s) => s.type === h.type && normaliseName(s.name, s.type) === pn)
    if (bad) return { verified: false, evidence, reason: `${h.name} ${bad.version} is still affected` }
  }
  // Anything else the incident names, newly carried by the candidate, is exposure too.
  if (stillHit.length > 0) {
    const s = stillHit[0]!
    return { verified: false, evidence, reason: `${s.name} ${s.version} would be affected` }
  }
  return { verified: true, evidence }
}
