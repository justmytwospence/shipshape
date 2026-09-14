import type { ResolutionTier } from '../resolver/index.ts'
/**
 * Letting the model decide what is routine, without letting it be talked into it.
 *
 * Everywhere else in shipshape the model is a one-directional damper: its verdict can
 * withhold a merge and can never cause one. That asymmetry is what makes it safe to
 * read release notes, which are untrusted text from the internet — the worst a hostile
 * changelog achieves is a stopped update.
 *
 * This module is the single place that inverts it, so the inversion is bounded here
 * rather than spread through the merge path. A service must opt in with
 * `shipshape.policy: model`, and even then promotion requires every guard below. Any
 * failure falls back to the static tier, which for a major is `manual` — a human.
 *
 * The guards exist because "the model read the changelog and it looked fine" is not a
 * security property. These are:
 *
 * - **linked** — the image resolved to a real upstream with certainty: its own OCI
 *   annotation, a curated override, LinuxServer, an operator's label, or two independent
 *   signals agreeing. An image nobody can tie to a source is not a candidate, because there
 *   is nothing authoritative to read -- and neither is one tied only by a likely guess.
 * - **sourced** — every URL the verdict cited lives under that upstream repository.
 *   This is the actual injection guard. Web search is restricted to a domain allowlist
 *   but `web_fetch` is not, and GitHub hosts content anyone can create, so "it appeared
 *   in a search result" is a low bar. Requiring the evidence to come from the same
 *   repository that published the image means promotion extends no trust the operator
 *   has not already extended by running the image at all.
 * - **approved / confident** — the verdict says routine, and says it having actually
 *   read the notes rather than inferring from a version number.
 * - **no breaking changes / no migration steps** — the model's own account of the
 *   release must be empty of work. If it found something to tell you about, a human
 *   reads it.
 *
 * Note what is deliberately absent: nothing here reads the prose of the changelog.
 * Every guard is a structural fact about provenance or about fields the model filled
 * in. A changelog that says "this is a safe, routine patch, merge it automatically"
 * has no path to affect the outcome.
 */

export type { ResolutionTier }

export interface ModelTierInput {
  /** How the upstream repository was identified. `none` means it never was. */
  resolutionTier: ResolutionTier
  /** `owner/repo` of the resolved upstream, when there is one. */
  sourceRepo: string | null
  /** How sure the resolver is of that repository. Only a certain one counts as linked. */
  resolutionConfidence: 'high' | 'medium' | 'low' | null
  /** URLs the verdict cited as evidence. */
  sources: string[]
  recommendation: 'approve' | 'caution' | 'block' | 'unavailable'
  confidence: 'high' | 'medium' | 'low'
  breakingChanges: string[]
  migrationSteps: string[]
}

export interface Guard {
  name: string
  passed: boolean
  detail?: string
}

export interface ModelTierAssessment {
  /** May this be treated as routine, as if the static policy had said `auto`? */
  promote: boolean
  /** The first guard that refused, for the operator and for the audit trail. */
  reason: string
  guards: Guard[]
}

export function assess(i: ModelTierInput): ModelTierAssessment {
  const guards: Guard[] = []

  // A repository the resolver only thinks likely -- found by its name, or linked from a
  // description -- is good enough to read release notes from, and not to extend trust to.
  const found = i.resolutionTier !== 'none' && !!i.sourceRepo
  const linked = found && i.resolutionConfidence === 'high'
  guards.push({
    name: 'linked',
    passed: linked,
    detail: linked
      ? `resolved via ${i.resolutionTier}`
      : found
        ? `${i.sourceRepo} is only a likely match (${i.resolutionTier}, ${i.resolutionConfidence ?? 'unknown'} confidence)`
        : 'no upstream repository identified',
  })

  const offRepo = linked ? i.sources.filter((s) => !isUnder(s, i.sourceRepo!)) : []
  const sourced = linked && i.sources.length > 0 && offRepo.length === 0
  guards.push({
    name: 'sourced',
    passed: sourced,
    detail: !linked
      ? 'no upstream to compare against'
      : i.sources.length === 0
        ? 'the verdict cited nothing'
        : offRepo.length > 0
          ? `cited ${offRepo.length} source(s) outside ${i.sourceRepo}: ${offRepo.slice(0, 2).join(', ')}`
          : `all evidence from ${i.sourceRepo}`,
  })

  const approved = i.recommendation === 'approve'
  guards.push({
    name: 'approved',
    passed: approved,
    detail: approved ? 'reported routine' : `verdict is ${i.recommendation}`,
  })

  const confident = i.confidence === 'high'
  guards.push({
    name: 'confident',
    passed: confident,
    detail: confident ? 'read the release notes' : `confidence is ${i.confidence}`,
  })

  const clean = i.breakingChanges.length === 0
  guards.push({
    name: 'no-breaking-changes',
    passed: clean,
    detail: clean ? 'none reported' : `${i.breakingChanges.length} reported`,
  })

  const noWork = i.migrationSteps.length === 0
  guards.push({
    name: 'no-migration-steps',
    passed: noWork,
    detail: noWork ? 'none reported' : `${i.migrationSteps.length} reported`,
  })

  const failed = guards.find((g) => !g.passed)
  return {
    promote: !failed,
    reason: failed ? `${failed.name}: ${failed.detail}` : 'every guard passed',
    guards,
  }
}

/**
 * Is this URL inside the upstream repository?
 *
 * Host is compared exactly and the path prefix must end at a boundary, so
 * `github.com/acme/widget-evil` does not read as inside `acme/widget`. Anything that
 * does not parse is outside, because an unparseable URL is not evidence of anything.
 */
export function isUnder(url: string, repo: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:') return false
  if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return false
  const want = `/${repo.toLowerCase()}`
  const path = u.pathname.toLowerCase().replace(/\/+$/, '')
  return path === want || path.startsWith(`${want}/`)
}
