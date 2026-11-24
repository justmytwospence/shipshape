import type { ChangelogTarget } from './labels.ts'

export type ResolutionTier =
  | 'label'
  | 'override'
  | 'lsio'
  | 'lsio-build'
  | 'annotation'
  | 'ghcr-path'
  | 'description'
  | 'lookup'
  | 'none'

export type SourceConfidence = 'high' | 'medium' | 'low'

export interface ImageKey {
  registry: string
  repository: string
}

export interface ServiceKey {
  stack: string
  service: string
}

export interface SourceLabelInfo {
  value: string
  /** The service whose label this is -- not always the one asking. */
  from: ServiceKey
  repo: string
  /** Other services on the same image whose labels name a different repository. */
  conflicts: (ServiceKey & { value: string })[]
}

export interface InvalidLabel {
  value: string
  from: ServiceKey
  reason: string
}

export interface ChangelogLabelInfo {
  value: string
  /** The service whose label this is -- not always the one asking. */
  from: ServiceKey
  target: ChangelogTarget
}

export interface SourceInfo {
  repo: string | null
  tier: ResolutionTier
  confidence: SourceConfidence | null
  detail: string | null
  /** What the resolver found on its own, underneath any label. Null when never looked up. */
  inferred: { repo: string | null; tier: ResolutionTier; confidence: SourceConfidence | null } | null
  /** A packaging repository: container changes only, never the application's source. */
  packagingRepo: string | null
  label: SourceLabelInfo | null
  /** The requesting service's own label, when it could not be parsed. */
  invalidLabel: InvalidLabel | null
  /** `shipshape.changelog`: where the release notes are when GitHub releases do not have them. */
  changelog: ChangelogLabelInfo | null
  /** The requesting service's own `shipshape.changelog`, when it could not be parsed. */
  invalidChangelog: InvalidLabel | null
  checkedAt: string | null
  nextCheckAt: string | null
  /** The last lookup's failure, when it failed. */
  error: string | null
  /** No lookup yet, or the last one is due to be repeated. */
  pending: boolean
}

export interface SourceOpts {
  /** The service asking. Its own label wins over a sibling's. */
  service?: ServiceKey
  /**
   * That service's label as the caller just read it from the compose file. Omit to use the
   * last scan's copy; pass null to say it has none.
   */
  ownLabel?: string | null
  /** That service's `shipshape.changelog`, likewise: omit for the last scan's copy. */
  ownChangelog?: string | null
  /** The tag to walk for annotations. Defaults to the image's current tag. */
  tag?: string | null
  /** Look again even when the cached answer is fresh. */
  force?: boolean
  /**
   * May a lookup spend Docker Hub pulls on the manifest walk? Defaults to yes: the callers
   * that ask are about to read release notes for a real update. The scan's sweep says no.
   */
  allowBilled?: boolean
}

/** What one lookup considered, for the report and for anyone asking why. */
export interface ResolutionEvidence {
  candidates: { tier: ResolutionTier; repo: string; confidence: SourceConfidence | null; why: string }[]
  /** Tiers not run, and why. */
  skipped: string[]
  /** The billed walk was skipped and could still change the answer. */
  billedPending: boolean
}

export interface Lookup {
  repo: string | null
  tier: ResolutionTier
  confidence: SourceConfidence | null
  detail: string | null
  packagingRepo: string | null
  /** Why the lookup could not finish, when it could not. Never set on a certain answer. */
  failure: string | null
  evidence: ResolutionEvidence
}

/** Bump when tier logic changes, so rows written by the previous logic are looked at again. */
export const RESOLVER_VERSION = 2

export const HOUR = 60 * 60_000

export const DAY = 24 * HOUR

/** A clean "nothing found" is not forever: an image can gain an annotation. */
export const NONE_TTL_MS = 7 * DAY

/** A likely answer is looked at again now and then, in case something more certain appears. */
export const MEDIUM_TTL_MS = 30 * DAY
