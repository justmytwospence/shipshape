/**
 * Whether the operator may merge this pull request from shipshape's own interface, and
 * what they should be told first.
 *
 * This is not `decide()` with a different trigger. `decide()` answers "may this merge
 * happen with nobody watching", and almost every clause in it is deferring to a person
 * who is not there. Here that person is present and clicking, so those clauses have
 * already been satisfied by the click itself -- the rung, the magnitude, the verdict, the
 * `merge.auto` switch, the per-run ceiling. Re-applying them would mean a button that
 * refuses on the grounds that nobody asked for it.
 *
 * What survives is only what a click cannot make true:
 *
 * - **Blocked** -- facts about the world. The pull request is not open, or every update
 *   on it has been superseded by a newer target. Merging a superseded one lands a version
 *   nothing is tracking any more, and no amount of intent changes that.
 * - **Warned** -- true things worth reading before acting, none of which a person is
 *   forbidden to overrule. The verdict objected; the branch carries more than an image
 *   line; someone has pushed to it. The button then says "anyway", which is the whole
 *   confirmation: a verb attached to a stated reason, rather than a dialog repeating
 *   generic text.
 *
 * Everything else is silent, deliberately. A warning that fires on the common path is
 * noise, and noise is how a real warning stops being read.
 */

export interface MergeFacts {
  prNumber: number | null
  prState: string | null
  /** Updates behind the pull request that are still live -- not superseded. */
  liveMembers: number
  totalMembers: number
  /** `tag-only` | `proposed` | `modified`. */
  scope: string | null
  userOwned: boolean
  /** The changelog verdict, when there is one. */
  recommendation: string | null
  /** GitHub's own answer, when we have asked. Null means not asked yet. */
  mergeable: boolean | null
  /** A required check that has already failed. */
  checksFailing: boolean
}

export interface MergeGate {
  /** Whether to render a button at all. */
  allowed: boolean
  /** Shown instead of the button when blocked, or above it when warning. */
  blocked?: string
  warnings: string[]
  /** True when a red check needs a second, deliberate click. */
  needsForce: boolean
}

export function mergeGate(f: MergeFacts, opts: { force?: boolean } = {}): MergeGate {
  const warnings: string[] = []

  if (!f.prNumber || f.prState !== 'open') {
    return { allowed: false, blocked: 'there is no open pull request for this update', warnings, needsForce: false }
  }

  // The one refusal that is not about attendance. Its successor rewrites the same line
  // from the same base, so merging this one restores a version nothing is tracking --
  // which is true whoever clicks.
  if (f.totalMembers > 0 && f.liveMembers === 0) {
    return {
      allowed: false,
      blocked: 'this update has been superseded by a newer version — merging it would land a version nothing is tracking',
      warnings,
      needsForce: false,
    }
  }

  // GitHub has already said no. Nothing here can talk it round.
  if (f.mergeable === false) {
    return {
      allowed: false,
      blocked: 'GitHub reports this branch cannot be merged — it probably conflicts with main',
      warnings,
      needsForce: false,
    }
  }

  // Ordered by how much they should change your mind, not by severity of language.
  if (f.recommendation === 'block' || f.recommendation === 'caution') {
    warnings.push(`the changelog review returned ${f.recommendation}`)
  }
  if (f.scope === 'proposed') {
    warnings.push(
      'this carries drafted config changes as well as the image line — and because it is more than a tag bump, a failed deploy will be reported rather than rolled back',
    )
  } else if (f.scope === 'modified') {
    warnings.push(
      'this branch has been edited since shipshape wrote it, so the preview above is not the whole change — and a failed deploy will be reported rather than rolled back',
    )
  }
  if (f.userOwned) {
    warnings.push('you have pushed to this branch, so it is no longer only what shipshape wrote')
  }

  // A red check is the one thing worth a second click. Not because a person may not
  // overrule it -- they may -- but because "a check failed" is a fact they might not
  // have seen, unlike a verdict pill sitting in the header.
  const needsForce = f.checksFailing && !opts.force
  if (f.checksFailing) warnings.push('a required check is failing on this pull request')

  return { allowed: true, warnings, needsForce }
}

/** The button's verb. Saying "anyway" under a stated reason is the confirmation. */
export function mergeLabel(number: number, gate: MergeGate): string {
  if (gate.needsForce) return `Merge #${number} anyway`
  return gate.warnings.length > 0 ? `Merge #${number} anyway` : `Merge #${number}`
}
