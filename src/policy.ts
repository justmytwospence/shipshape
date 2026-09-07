import type { Policy } from './config.ts'
import type { Magnitude } from './versions/patterns.ts'

/**
 * The decision engine: what may happen to an update, given the static policy and
 * whatever Claude concluded.
 *
 * Pure and exhaustively tested, because the failure mode is silent and expensive --
 * auto-merging something that needed a human. The governing rule is that Claude is a
 * ONE-DIRECTIONAL damper: a verdict can demote an auto-merge to a human hold, never
 * promote anything. That is also the prompt-injection boundary, since release notes are
 * untrusted input: the worst a hostile changelog can achieve is to stop an update.
 */

export type Verdict = 'approve' | 'caution' | 'block' | 'unavailable'
export type Confidence = 'low' | 'medium' | 'high'

/**
 * One ladder, one axis: how much happens without you.
 *
 *   skip    -- never look at this service
 *   auto    -- open a PR and merge it, if the verdict allows
 *   manual  -- open a PR; you merge it
 *   held    -- do not even open a PR until you ask
 *
 * `model` is not a rung. It is a deferral: the merge path resolves it through
 * policy/model-tier.ts into `auto` or `manual` once a verdict exists.
 *
 * `gated` USED to be a fifth value and was byte-for-byte identical to `manual` in every
 * decision -- same merge answer, same PR answer, differing only in which word a group
 * badge showed. Two names for one behaviour is not control, it is a coin flip the
 * operator has to remember the result of, so it is now an accepted spelling of `manual`
 * (see `asTier`) rather than a value this module ever produces.
 *
 * `held` is not a policy the operator writes directly either -- it is what
 * `shipshape.pr: on-request` (or the newer `shipshape.policy: on-request`) produces. Held
 * updates are detected, persisted and rendered, but the PR engine never touches them;
 * only an explicit per-service action in the UI promotes one. Datastores live here: a
 * postgres major cannot be applied by bumping the tag at all (the new container refuses
 * the old datadir), so a standing merge-able PR would be a loaded gun.
 */
export type EffectiveTier = 'auto' | 'manual' | 'attended' | 'held' | 'skip' | 'model'

/** What an operator may write in `shipshape.policy` or in `defaults.*`. */
export const TIER_LABELS = ['auto', 'manual', 'attended', 'on-request', 'skip', 'model'] as const

export interface TierInput {
  magnitude: Magnitude
  /** `shipshape.policy`: auto | manual | on-request | skip | model (| gated, deprecated) */
  policyLabel: string | null
  /** `shipshape.pr`: on-request */
  prLabel: string | null
  defaults: Policy['defaults']
}

/** Every spelling `shipshape.policy` accepts, including the deprecated one. */
const KNOWN_LABELS = new Set(['auto', 'manual', 'attended', 'gated', 'on-request', 'skip', 'model'])

function clean(v: string | null): string | null {
  const s = v?.trim().toLowerCase()
  return s ? s : null
}

/** First match wins. */
export function tierFor(i: TierInput): EffectiveTier {
  const label = clean(i.policyLabel)
  const pr = clean(i.prLabel)

  if (label === 'skip') return 'skip'
  // Both spellings reach the same rung. `shipshape.pr` came first and is kept working;
  // `shipshape.policy: on-request` is the one to write, because the whole ladder then
  // lives in one label rather than being split across two that have to be read together.
  if (pr === 'on-request' || label === 'on-request') return 'held'
  if (label === 'manual' || label === 'gated') return 'manual'
  // One rung further than manual: the pull request still opens and is still reviewed, but
  // the host is not touched until a person presses Deploy. It is the answer to "I want to
  // see this and decide, and I want to be watching when it lands" -- infrastructure that
  // carries the way back in, anything whose restart takes other services down with it,
  // anything a rollback could not put back.
  if (label === 'attended') return 'attended'
  // Deferred, not decided: `model` needs a verdict, which tierFor has not got. The
  // merge path resolves it through policy/model-tier.ts and falls back to the static
  // tier -- `manual` for a major -- whenever the guards refuse.
  if (label === 'model') return 'model'
  // A label nobody recognises narrows to a human, and never falls through to the
  // defaults. Falling through is what it used to do, and it is the wrong direction: a
  // service the operator meant to pin -- `shipshape.policy: manaul` -- would land on
  // whatever `defaults.patch` says, which is `auto`. A typo must never grant reach.
  if (label !== null && !KNOWN_LABELS.has(label)) return 'manual'
  // `auto` deliberately has no branch of its own: it means "no exception here, follow
  // the defaults", so it falls through to the magnitude rules below and cannot be used
  // to talk a major past the line under it.
  // Majors always need a human, whatever the defaults say. Not configurable.
  if (i.magnitude === 'major') return 'manual'
  if (i.magnitude === 'digest') return asTier(i.defaults.digest)
  return asTier(i.defaults[i.magnitude])
}

/** Anything unrecognised narrows to `manual`: a typo must never grant reach. */
export function asTier(v: string): EffectiveTier {
  const s = clean(v) ?? ''
  if (s === 'gated') return 'manual' // deprecated spelling, folded on read
  if (s === 'on-request') return 'held'
  return s === 'auto' || s === 'manual' || s === 'attended' || s === 'skip' ? s : 'manual'
}

const TIER_RANK: Record<EffectiveTier, number> = {
  skip: 0,
  auto: 1,
  // Unresolved sits above auto: a group containing one is never merged on the strength
  // of its other members.
  model: 2,
  manual: 3,
  attended: 4,
  held: 5,
}

/**
 * A grouped PR takes the most conservative tier among its members. One held member
 * holds the whole group. `skip` members never join a group in the first place (they
 * produce no update row), so they cannot drag a group down.
 *
 * Rows written before the `gated` collapse still carry that word, so every value is
 * normalised on the way in rather than trusted to be current.
 */
export function foldGroupTier(tiers: string[]): EffectiveTier {
  const real = tiers.map(normaliseTier).filter((t) => t !== 'skip')
  if (real.length === 0) return 'skip'
  return real.reduce((a, b) => (TIER_RANK[b] > TIER_RANK[a] ? b : a))
}

/** A tier read back from the database or a label, mapped onto the current ladder. */
export function normaliseTier(v: string): EffectiveTier {
  if (v === 'held' || v === 'model') return v
  return asTier(v)
}

/**
 * Does changing this service need a person present at the moment it changes?
 *
 * Merging is a decision and deploying is carrying it out, and for almost everything the
 * second should follow the first without being asked twice -- an update that is merged but
 * not applied is going to be applied eventually anyway, by a reboot or by the next time
 * anything recreates the stack, and it will land then with no health check and no rollback
 * window. Deploying on merge is what puts that moment somewhere shipshape is watching.
 *
 * These two rungs are where that reasoning stops. `attended` is chosen per service for
 * exactly this; `held` is the on-request rung, where the datastores live, and a postgres
 * major cannot be applied by bumping a tag at all. For both, the deploy waits for a button
 * however the merge happened.
 */
export function deployNeedsYou(tier: EffectiveTier): boolean {
  return tier === 'attended' || tier === 'held'
}

const MAGNITUDE_RANK: Record<Magnitude, number> = { digest: 0, patch: 1, minor: 2, major: 3 }

/** A group is labelled with its largest jump -- one `major` badge, not one per member. */
export function foldGroupMagnitude(ms: Magnitude[]): Magnitude {
  if (ms.length === 0) return 'patch'
  return ms.reduce((a, b) => (MAGNITUDE_RANK[b] > MAGNITUDE_RANK[a] ? b : a))
}

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 }

export interface AutoMergeInput {
  tier: EffectiveTier
  magnitude: Magnitude
  /** `tag-only` | `proposed` | `modified`. Anything but tag-only contains changes no
   *  policy or verdict ever evaluated, so it always needs a person. */
  prScope?: 'tag-only' | 'proposed' | 'modified'
  verdict: Verdict
  confidence: Confidence | null
  /** `shipshape.claude: required` -- flips this service to fail-closed. */
  claudeRequired: boolean
  claudeMode: Policy['claude']['mode']
  minConfidence: Confidence
  /**
   * Why this pull request is being held, if it is: an instruction nobody has answered
   * yet, or a hold the operator asked for in a comment.
   *
   * Checked before anything else, and it is the reason "don't merge this yet" works at
   * all. The sentence takes effect the moment the comment is *recorded*, which happens
   * with no model involved -- so a hold does not have to win a race against the pass
   * that reads it.
   */
  hold?: string | null
}

export type AutoMergeDecision =
  | { merge: true }
  | { merge: false; reason: string; label?: 'claude-hold' | 'claude-block' | 'needs-analysis' }

/**
 * Whether an update may be merged without a human.
 *
 * Note the deliberate asymmetry on `unavailable`: by default an absent verdict falls
 * back to the static policy (fail-open), because the static policy is exactly what runs
 * today without any analysis at all -- a provider outage must not freeze every update.
 * Services that would rather stall than proceed unread carry `shipshape.claude: required`.
 */
export function canAutoMerge(i: AutoMergeInput): AutoMergeDecision {
  // First, and it can only ever refuse. Like a verdict, a comment may withhold a merge
  // and may never cause one -- so there is no branch here that returns { merge: true }.
  if (i.hold) return { merge: false, reason: i.hold }
  if (i.tier !== 'auto') return { merge: false, reason: `tier is ${i.tier}` }
  if (i.prScope && i.prScope !== 'tag-only') {
    return {
      merge: false,
      reason:
        i.prScope === 'proposed'
          ? 'the pull request carries drafted config changes'
          : 'the pull request has been edited',
    }
  }
  if (i.magnitude === 'major') return { merge: false, reason: 'majors always need a human' }
  if (i.magnitude === 'digest') return { merge: false, reason: 'digest bumps always need a human' }

  if (i.claudeMode === 'off') return { merge: true }

  switch (i.verdict) {
    case 'block':
      return { merge: false, reason: 'Claude flagged breaking changes', label: 'claude-block' }
    case 'caution':
      return { merge: false, reason: 'Claude recommends a human read this', label: 'claude-hold' }
    case 'unavailable':
      return i.claudeRequired
        ? {
            merge: false,
            reason: 'analysis unavailable and this service is fail-closed',
            label: 'needs-analysis',
          }
        : { merge: true }
    case 'approve': {
      const conf = i.confidence ?? 'low'
      if (CONFIDENCE_RANK[conf] < CONFIDENCE_RANK[i.minConfidence]) {
        return {
          merge: false,
          reason: `Claude approved but only at ${conf} confidence`,
          label: 'claude-hold',
        }
      }
      return { merge: true }
    }
  }
}

/**
 * Whether the PR engine should open a PR for this update at all.
 *
 * `coexist` is for running alongside another updater that already applies routine
 * patches and minors itself: shipshape takes only what such a tool leaves alone --
 * majors, digest pins, and anything not on the auto tier -- so the two can never write
 * to the same file for the same reason. Not by timing, by construction. `full` takes
 * over everything and is the right setting once shipshape is the only updater.
 */
export function shouldOpenPr(opts: {
  scope: 'coexist' | 'full'
  tier: EffectiveTier
  magnitude: Magnitude
  /** Rolling `latest` movement has nothing to change in git. */
  rolling: boolean
}): boolean {
  if (opts.rolling) return false
  if (opts.tier === 'skip' || opts.tier === 'held') return false
  if (opts.scope === 'full') return true
  return opts.magnitude === 'major' || opts.magnitude === 'digest' || opts.tier !== 'auto'
}
