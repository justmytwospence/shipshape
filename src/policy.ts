import type { Policy, Rule } from './config.ts'
import { parseImageRef } from './images/ref.ts'
import type { Magnitude } from './versions/patterns.ts'

/**
 * The decision engine: what may happen to an update, given its service's class, what the
 * review found, and the standing rules.
 *
 * The model is one sentence: an update ships on its own unless a concrete hold says
 * otherwise. A hold is a reason a person is needed -- the service always asks, the review
 * found something to do or something unsafe, there is no evidence on a risky jump, the
 * migration cannot be undone and there is no restore point. Nothing here predicts how
 * "risky" a version looks; verification and rollback (src/deploy) carry the rest.
 *
 * Pure and exhaustively tested. The reader is still a one-directional damper -- a verdict
 * can hold an update, never cause one -- which is also the prompt-injection boundary:
 * release notes are untrusted text, and the worst a hostile changelog achieves is a card
 * asking you.
 */

/**
 * `pending` is not a verdict anyone wrote: it is "the review has not run yet, and it is
 * expected to". It waits, for a bounded time (REVIEW_WAIT_MS in policy-inputs.ts), so an
 * update detected in the same tick as five others does not ship unread just because the
 * analysis pass only reaches three of them per tick. Once the wait is over, or when no
 * review can run at all, the update reads `unavailable`.
 */
export type Verdict = 'approve' | 'caution' | 'block' | 'unavailable' | 'pending'
export type Confidence = 'low' | 'medium' | 'high'

/**
 * How much a service asks of you. One label, set rarely, `shipshape.class`.
 *
 *   normal    -- ships on its own
 *   stateful  -- ships on its own, with a restore point first; anything the review calls
 *                a one-way migration, or a jump with no evidence, asks
 *   ask       -- always asks
 *   lifeline  -- always asks, and no rule can waive it: the way back in (traefik,
 *                authelia, wireguard, pihole)
 *   frozen    -- tracked, nothing happens until you ask (disabled stacks, parked updates)
 *   skip      -- not tracked at all
 *
 * The old ladder is still read: `shipshape.policy: auto|manual|attended|on-request` and
 * `shipshape.pr: on-request` map onto these, so no compose file breaks on the day the
 * labels change.
 */
export type ServiceClass = 'normal' | 'stateful' | 'ask' | 'lifeline' | 'frozen' | 'skip'

/** What an operator may write in `shipshape.class`. */
export const CLASS_LABELS = ['normal', 'stateful', 'ask', 'lifeline', 'frozen'] as const

export interface ClassInput {
  /** `shipshape.class`. */
  classLabel: string | null
  /** `shipshape.policy`, the v1 ladder: read and mapped. */
  policyLabel: string | null
  /** `shipshape.pr`: on-request. Deprecated, still read. */
  prLabel: string | null
  /** The service carries a `disabled`/`standby` profile (see ScannedService.dormant). */
  dormant?: boolean
}

function clean(v: string | null | undefined): string | null {
  const s = v?.trim().toLowerCase()
  return s ? s : null
}

/** First match wins. An unrecognised value narrows to `ask`: a typo must never grant reach. */
export function classFor(i: ClassInput): ServiceClass {
  const cls = clean(i.classLabel)
  const policy = clean(i.policyLabel)
  const pr = clean(i.prLabel)

  if (policy === 'skip') return 'skip'
  // A disabled stack is watched so its updates are known, but nothing moves on its own.
  if (i.dormant) return 'frozen'
  if (cls !== null) return (CLASS_LABELS as readonly string[]).includes(cls) ? (cls as ServiceClass) : 'ask'
  if (policy !== null) {
    if (policy === 'auto') return 'normal'
    if (policy === 'attended') return 'lifeline'
    if (policy === 'on-request') return 'frozen'
    // manual, gated and model (all read as manual before), and anything unrecognised.
    return 'ask'
  }
  if (pr === 'on-request') return 'frozen'
  return 'normal'
}

/** Anything stored in `updates.tier` is a class; an older row's value narrows to `ask`. */
export function normaliseClass(v: string | null | undefined): ServiceClass {
  const s = clean(v)
  if (s === 'normal' || s === 'stateful' || s === 'ask' || s === 'lifeline' || s === 'frozen' || s === 'skip') return s
  if (s === 'auto') return 'normal'
  if (s === 'attended') return 'lifeline'
  if (s === 'held' || s === 'on-request') return 'frozen'
  return 'ask'
}

/** The registry and repository an image reference names, without tag or digest. */
export function repositoryOf(image: string): string {
  const ref = parseImageRef(image)
  return `${ref.registry}/${ref.repository}`
}

/** `ghcr.io/agentgateway/agentgateway` -> `agentgateway`: the name a card leads with. */
export function shortRepository(image: string): string {
  const repo = parseImageRef(image).repository
  return repo.split('/').pop() ?? repo
}

const MAGNITUDE_RANK: Record<Magnitude, number> = { digest: 0, patch: 1, minor: 2, major: 3 }

/** A group is labelled with its largest jump -- one `major` badge, not one per member. */
export function foldGroupMagnitude(ms: Magnitude[]): Magnitude {
  if (ms.length === 0) return 'patch'
  return ms.reduce((a, b) => (MAGNITUDE_RANK[b] > MAGNITUDE_RANK[a] ? b : a))
}

const CLASS_RANK: Record<ServiceClass, number> = { skip: 0, normal: 1, stateful: 2, ask: 3, lifeline: 4, frozen: 5 }

/** A group is as careful as its most careful member; `skip` members do not count. */
export function foldGroupClass(classes: string[]): ServiceClass {
  const all = classes.map(normaliseClass).filter((c) => c !== 'skip')
  if (all.length === 0) return 'normal'
  return all.reduce((a, b) => (CLASS_RANK[b] > CLASS_RANK[a] ? b : a))
}

/** Whether a reader is configured at all. `review.model: off` turns it off. */
export function readerOn(policy: Policy): boolean {
  return policy.review.model.trim().toLowerCase() !== 'off'
}

/**
 * Whether any stage can write a verdict the gate should read.
 *
 * `off` only when neither can: the reader is off and the screen is not deciding.
 */
export function reviewMode(policy: Policy): 'advisory' | 'off' {
  return !readerOn(policy) && policy.review.screen !== 'on' ? 'off' : 'advisory'
}

// ------------------------------------------------------------------ holds

/**
 * Why an update is waiting for a person. Only some can be waived by a rule: a `lifeline`,
 * an `unsafe` verdict and a `needs-action` list are never waivable.
 */
export type HoldKind = 'lifeline' | 'ask' | 'unsafe' | 'needs-action' | 'no-evidence' | 'irreversible' | 'no-restore-point'

export interface Hold {
  kind: HoldKind
  waivable: boolean
  text: string
  /** The rule that waived it. A hold with this set no longer blocks. */
  waivedBy?: string
}

export interface HoldVerdict {
  recommendation: 'approve' | 'caution' | 'block'
  confidence: Confidence
  breaking: string[]
  steps: string[]
  irreversible: boolean
  /** Release bodies + changelog sections the review had for its range; null when unknown. */
  notesInRange: number | null
}

export interface HoldInput {
  cls: ServiceClass
  magnitude: Magnitude
  verdict: HoldVerdict | null
  verdictState: 'present' | 'pending' | 'unavailable'
  /** `shipshape.review: required`: this service would rather stall than ship unread. */
  required: boolean
  /**
   * A restore point can be taken for this stack: some service carries `shipshape.snapshot`,
   * or the configured offsite backup has a job for it.
   */
  hasSnapshot: boolean
  /** The last restore point attempt failed, and why. */
  restoreError: string | null
  /** A verified security fix (src/security/act.ts): lifts `ask` and `no-evidence`. */
  securityFix: boolean
}

/** Reading that cannot be trusted to have seen the jump: nothing read, or read thinly. */
function weakEvidence(i: HoldInput): boolean {
  if (i.verdictState === 'unavailable') return true
  if (!i.verdict) return false
  return i.verdict.notesInRange === 0 || i.verdict.confidence === 'low'
}

/** Every reason this update would wait for a person, in the order they are shown. */
export function holdsFor(i: HoldInput): Hold[] {
  const out: Hold[] = []
  const v = i.verdict
  // A digest move under the same tag is a rebuild of the version already running: there
  // are no release notes to read and no data migration to protect against, and a rollback
  // is just the old digest. Missing evidence or a missing restore point says nothing there.
  const rebuild = i.magnitude === 'digest'

  if (i.cls === 'lifeline') {
    out.push({ kind: 'lifeline', waivable: false, text: 'lifeline service: deploys only when you ship it' })
  }
  if (i.cls === 'ask' && !i.securityFix) {
    out.push({ kind: 'ask', waivable: true, text: 'this service always asks' })
  }
  if (v?.recommendation === 'block') {
    out.push({
      kind: 'unsafe',
      waivable: false,
      text: `Unsafe: ${v.breaking[0] ?? 'the review found a breaking change'}`,
    })
  } else if (v && (v.steps.length > 0 || v.breaking.length > 0)) {
    out.push({ kind: 'needs-action', waivable: false, text: `Needs: ${v.steps[0] ?? v.breaking[0]}` })
  }
  if (!rebuild && !i.securityFix && weakEvidence(i) && (i.magnitude === 'major' || i.cls === 'stateful' || i.required)) {
    out.push({ kind: 'no-evidence', waivable: true, text: 'no release notes were read for this jump' })
  }
  if (v?.irreversible) {
    out.push({
      kind: 'irreversible',
      waivable: true,
      text: `the review says this migrates data one-way${i.hasSnapshot ? ' -- a restore point is taken first' : ''}`,
    })
  }
  if (i.cls === 'stateful' && !rebuild && (!i.hasSnapshot || i.restoreError)) {
    out.push({
      kind: 'no-restore-point',
      waivable: true,
      text: i.restoreError ?? 'no shipshape.snapshot and no backup job for this stack, so no restore point can be taken',
    })
  }
  return out
}

export interface RuleTarget {
  /** The update's image reference; compared by repository. */
  image: string
  stack: string
  service: string
  /** One of our own builds, watched through its base image. */
  baseBuild: boolean
}

/** Every key a rule names must match. */
export function ruleMatches(rule: Rule, m: RuleTarget): boolean {
  const k = rule.match
  if (k.image !== undefined && k.image !== repositoryOf(m.image)) return false
  if (k.stack !== undefined && k.stack !== m.stack) return false
  if (k.service !== undefined && k.service !== m.service) return false
  if (k.base_build !== undefined && k.base_build !== m.baseBuild) return false
  return true
}

/**
 * Mark the holds a standing rule waives. The first matching rule that names a hold's kind
 * wins; a hold that is not waivable is never touched. Returns new objects.
 */
export function applyRules(holds: Hold[], rules: readonly Rule[], m: RuleTarget): Hold[] {
  const matching = rules.filter((r) => ruleMatches(r, m))
  return holds.map((h) => {
    if (!h.waivable) return h
    const rule = matching.find((r) => (r.waive as string[]).includes(h.kind))
    return rule ? { ...h, waivedBy: rule.id } : h
  })
}

/** The holds that still ask for a person. */
export function blocking(holds: readonly Hold[]): Hold[] {
  return holds.filter((h) => !h.waivedBy)
}

export type ShipStatus =
  | { status: 'ready' }
  | { status: 'waiting'; why: string }
  | { status: 'decision'; holds: Hold[] }

export interface ShipInput extends HoldInput {
  target: RuleTarget
  rules: readonly Rule[]
  /** The operator said ship. */
  approved: boolean
  paused: boolean
  snoozedUntil: string | null
  /** How old the release is, and how old it must be to ship on its own. */
  cooldown: { ageMs: number; requiredMs: number } | null
  now?: number
}

/**
 * Where one update stands. In this order:
 *
 *   approved            -> ready (you said ship: holds, cooldown and pause do not apply)
 *   review still coming -> waiting
 *   blocking holds      -> decision (or waiting, while snoozed)
 *   cooldown            -> waiting
 *   paused              -> waiting
 *   otherwise           -> ready
 */
export function shipStatus(i: ShipInput): ShipStatus {
  if (i.approved) return { status: 'ready' }
  if (i.verdictState === 'pending') return { status: 'waiting', why: 'review pending' }

  const holds = applyRules(holdsFor(i), i.rules, i.target)
  const open = blocking(holds)
  if (open.length > 0) {
    const now = i.now ?? Date.now()
    if (i.snoozedUntil && Date.parse(i.snoozedUntil) > now) {
      return { status: 'waiting', why: `snoozed until ${i.snoozedUntil.slice(0, 10)}` }
    }
    return { status: 'decision', holds: open }
  }

  if (i.cooldown && i.cooldown.ageMs < i.cooldown.requiredMs) {
    return { status: 'waiting', why: `cooldown: ${ageWords(i.cooldown.requiredMs - i.cooldown.ageMs)} left` }
  }
  if (i.paused) return { status: 'waiting', why: 'paused' }
  return { status: 'ready' }
}

/** `3 days`, `5 hours`, `20 minutes`: the largest unit that fits. */
export function ageWords(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`
  const d = Math.floor(h / 24)
  return `${d} day${d === 1 ? '' : 's'}`
}
