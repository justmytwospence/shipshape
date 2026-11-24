import { getDb } from '../db/index.ts'
import { verifiedFix, type SecurityFix } from '../security/act.ts'
import { forkConflictFor } from '../forks.ts'
import { loadPolicy } from '../config.ts'
import { env } from '../env.ts'
import { normaliseClass, type Hold, type ServiceClass } from '../policy.ts'
import { currentDecisions, holdsForRow, type Decision, type HoldRow } from './holds.ts'
import { changeUrl } from '../gitops/change.ts'
import { restorePointsFor } from '../restore/index.ts'
import { present, type Presentation } from './present.ts'
import { screenFor } from '../analyze/screen/run.ts'
import { reviewOffReason } from '../analyze/review-state.ts'
import type { Magnitude } from '../versions/patterns.ts'
import { actionsFor, isTransient, primaryVerb, type ActionContext, type Verb } from './actions.ts'
import type { UpdateState } from './state.ts'

export interface UpdateView {
  id: number
  stack: string
  service: string
  image: string
  fromTag: string
  toTag: string
  magnitude: Magnitude
  /** The service's class (`updates.tier` stores it; the column kept its name). */
  cls: ServiceClass
  state: UpdateState
  detail: string | null
  rolling: boolean
  /** The service runs our own build of this image, which shipshape rebases and retires. */
  fork: boolean
  /** Why the fork's last replay onto this target opened nothing: the commit and file that conflicted. */
  forkConflict: string | null
  detectedAt: string
  updatedAt: string
  ackedAt: string | null
  /** What landed (or will land) on the published branch for this update: a merge commit. */
  change: {
    id: number
    state: string
    scope: 'tag-only' | 'proposed'
    branch: string
    mergeCommitSha: string | null
    /** The merge commit or pull request page, when there is one to point at. */
    url: string | null
  } | null
  /** Why a person is needed: holds nothing has waived. Empty when it ships on its own. */
  holds: Hold[]
  /** Holds a standing rule waived, so the page can say so. */
  waived: Hold[]
  /** Where it stands on its way out: ready, waiting (with why), or a decision. */
  shipStatus: 'ready' | 'waiting' | 'decision' | null
  shipWhy: string | null
  /** Why nothing will read release notes right now; null when a review can be expected. */
  reviewOff: string | null
  snoozedUntil: string | null
  approvedAt: string | null
  /** Restore points taken for the change that carried it. */
  restorePoints: { service: string; path: string; createdAt: string }[]
  verdict: {
    recommendation: 'approve' | 'caution' | 'block' | null
    confidence: 'low' | 'medium' | 'high' | null
    severity: string | null
    summary: string | null
    breakingChanges: string[]
    migrationSteps: string[]
    newFeatures: string[]
    sources: string[]
    model: string | null
    createdAt: string | null
    error: string | null
    attempts: number
    nextAttemptAt: string | null
    /** How many notes the review had for its range; null for a review from before that was kept. */
    notesInRange: number | null
    /** Applying it changes stored data in a way a rollback cannot undo. */
    irreversible: boolean
    /** `screen` when only the screen has judged it; its finding is provisional until read. */
    source: 'reader' | 'screen'
    provisional: boolean
  } | null
  deploy: {
    id: number
    status: string
    trigger: string
    startedAt: string | null
    finishedAt: string | null
    recheckAt: string | null
    detail: string | null
  } | null
  actions: Verb[]
  primary: Verb | null
  transient: boolean
  /**
   * What the buttons that depend on configuration actually say, and what their
   * confirmations promise -- see updates/present.ts. Absent for a verb whose label is fixed.
   */
  presented: Partial<Record<Verb, Presentation>>
  /** What the screen (Jev) found, when it has looked. Absent while `review.screen` is off. */
  screen: ScreenView | null
  /**
   * A security incident this update was verified, from its own image's inventory, to
   * remove from the running service (src/security). Optional so older fixtures still read.
   */
  securityFix?: SecurityFix | null
}

export interface ScreenView {
  /** `shadow` means shown and not acted on. */
  mode: 'shadow' | 'on'
  decision: 'routine' | 'finding' | 'escalate' | 'no-notes' | null
  reason: string | null
  error: string | null
  model: string | null
  createdAt: string
  /** The questions answered yes, most certain first, with how certain. */
  flags: { label: string; p: number }[]
  /** The notes' own lines, verbatim: what asks for work, then what you would notice. */
  actionable: { text: string; version: string; url: string | null }[]
  notable: { text: string; version: string; url: string | null }[]
}

const FLAG_LABEL: Record<string, string> = {
  config_removed_or_renamed: 'Setting removed or renamed',
  manual_step_required: 'Manual step',
  irreversible_migration: 'One-way migration',
  dropped_support: 'Dropped support',
  default_changed: 'Default changed',
  config_change_needed: 'Config edit needed',
  affects_this_deployment: 'Touches this deployment',
  security_fix: 'Security fix',
}

/** The screen's answers, shaped for the page. Null when there is nothing to show. */
function screenView(image: string, fromTag: string, toTag: string): ScreenView | null {
  const mode = loadPolicy().policy.review.screen
  if (mode === 'off') return null
  const s = screenFor(image, fromTag, toTag)
  if (!s) return null
  const flags = Object.entries(FLAG_LABEL)
    .map(([k, label]) => {
      const a = s.answers?.[k] as { type?: string; noul?: number } | undefined
      return { label, p: a?.type === 'noul' && typeof a.noul === 'number' ? a.noul : 0 }
    })
    .filter((f) => f.p >= 0.5)
    .sort((a, b) => b.p - a.p)
  return {
    mode,
    decision: s.decision,
    reason: s.reason,
    error: s.error,
    model: s.model,
    createdAt: s.createdAt,
    flags,
    actionable: s.actionable.map((i) => s.lines[i]).filter((l) => !!l),
    notable: s.notable
      .map((i) => s.lines[i])
      .filter((l) => !!l)
      .slice(0, 5),
  }
}

export const SELECT_UPDATE = `
  SELECT u.id, u.stack, u.service, u.image, u.from_tag, u.to_tag, u.magnitude, u.tier,
         u.state, u.detail, u.detected_at, u.updated_at, u.acked_at,
         u.approved_at, u.snoozed_until, u.decision_since, u.restore_error, u.build_error
    FROM updates u`

export interface RawUpdate {
  id: number
  stack: string
  service: string
  image: string
  from_tag: string
  to_tag: string
  magnitude: string
  tier: string
  state: string
  detail: string | null
  detected_at: string
  updated_at: string
  acked_at: string | null
  approved_at: string | null
  snoozed_until: string | null
  decision_since: string | null
  restore_error: string | null
  build_error: string | null
}

/**
 * The newest change record for an update, not an open one.
 *
 * An update that has been round twice has two, and joining on open returns a duplicated
 * row while both are open and none once both are closed -- taking the merge commit with
 * it, which is what a rollback needs.
 */
function changeFor(updateId: number): UpdateView['change'] {
  const row = getDb()
    .prepare(
      `SELECT p.id, p.state, p.scope, p.branch, p.merge_commit_sha
         FROM prs p JOIN pr_updates pu ON pu.pr_id = p.id
        WHERE pu.update_id = ? ORDER BY p.id DESC LIMIT 1`,
    )
    .get(updateId) as
    | { id: number; state: string; scope: string; branch: string; merge_commit_sha: string | null }
    | undefined
  if (!row) return null
  return {
    id: row.id,
    state: row.state,
    scope: row.scope === 'proposed' ? 'proposed' : 'tag-only',
    branch: row.branch,
    mergeCommitSha: row.merge_commit_sha,
    url: changeUrl(row.id) ?? null,
  }
}

function verdictFor(u: RawUpdate): UpdateView['verdict'] {
  const v = getDb()
    .prepare(
      `SELECT recommendation, confidence, severity, summary, breaking_changes, migration_steps,
              new_features, sources, model, created_at, error, attempts, next_attempt_at, evidence,
              source, provisional, irreversible
         FROM verdicts WHERE image = ? AND from_tag = ? AND to_tag = ?`,
    )
    .get(u.image, u.from_tag, u.to_tag) as
    | {
        evidence: string | null
        recommendation: string | null
        confidence: string | null
        severity: string | null
        summary: string | null
        breaking_changes: string | null
        migration_steps: string | null
        new_features: string | null
        sources: string | null
        model: string | null
        created_at: string
        error: string | null
        attempts: number
        next_attempt_at: string | null
        source: string | null
        provisional: number | null
        irreversible: number | null
      }
    | undefined
  if (!v) return null
  const list = (s: string | null): string[] => {
    if (!s) return []
    try {
      const parsed: unknown = JSON.parse(s)
      return Array.isArray(parsed) ? parsed.map(String) : []
    } catch {
      return []
    }
  }
  return {
    recommendation: (v.recommendation as 'approve' | 'caution' | 'block' | null) ?? null,
    confidence: (v.confidence as 'low' | 'medium' | 'high' | null) ?? null,
    severity: v.severity,
    summary: v.summary,
    breakingChanges: list(v.breaking_changes),
    migrationSteps: list(v.migration_steps),
    newFeatures: list(v.new_features),
    sources: list(v.sources),
    model: v.model,
    createdAt: v.created_at,
    error: v.error,
    attempts: v.attempts ?? 0,
    nextAttemptAt: v.next_attempt_at,
    notesInRange: notesOf(v.evidence),
    irreversible: v.irreversible === 1,
    source: v.source === 'screen' ? 'screen' : 'reader',
    provisional: v.provisional === 1,
  }
}

/** Release bodies, changelog sections and linked sections the review was given for its range. */
function notesOf(evidence: string | null): number | null {
  if (!evidence) return null
  try {
    const e = JSON.parse(evidence) as { releases?: number; changelogSections?: number; linkedSections?: number }
    return (e.releases ?? 0) + (e.changelogSections ?? 0) + (e.linkedSections ?? 0)
  } catch {
    return null
  }
}

function deployFor(updateId: number): UpdateView['deploy'] {
  const d = getDb()
    .prepare(
      `SELECT d.id, d.status, d.trigger, d.started_at, d.finished_at, d.recheck_at, d.detail
         FROM deploys d JOIN deploy_updates du ON du.deploy_id = d.id
        WHERE du.update_id = ? ORDER BY d.id DESC LIMIT 1`,
    )
    .get(updateId) as
    | {
        id: number
        status: string
        trigger: string
        started_at: string | null
        finished_at: string | null
        recheck_at: string | null
        detail: string | null
      }
    | undefined
  if (!d) return null
  return {
    id: d.id,
    status: d.status,
    trigger: d.trigger,
    startedAt: d.started_at,
    finishedAt: d.finished_at,
    recheckAt: d.recheck_at,
    detail: d.detail,
  }
}

export function toView(u: RawUpdate, _repo?: string): UpdateView {
  const change = changeFor(u.id)
  const verdict = verdictFor(u)
  const deploy = deployFor(u.id)
  const image = getDb()
    .prepare(`SELECT current_tag, fork_upstream FROM images WHERE stack = ? AND service = ?`)
    .get(u.stack, u.service) as { current_tag: string | null; fork_upstream: string | null } | undefined
  const fork = !!image?.fork_upstream || u.detail === 'fork'
  const conflict = fork ? forkConflictFor(u.stack, u.service) : null
  const forkConflict = conflict && conflict.toTag === u.to_tag.split('@')[0] ? conflict.detail : null
  const hasProposal = !!getDb()
    .prepare(`SELECT 1 FROM proposals WHERE update_id = ? AND retryable = 0 AND error IS NULL LIMIT 1`)
    .get(u.id)

  // Only an update still on its way out has holds; a shipped one has nothing left to ask.
  const waiting = u.state === 'detected' && u.detail !== 'rolling'
  const held = waiting ? holdsForRow(u as unknown as HoldRow) : null
  const cls = normaliseClass(u.tier)
  const snoozed = !!u.snoozed_until && Date.parse(u.snoozed_until) > Date.now()

  const ctx: ActionContext = {
    hasReaderVerdict: !!verdict && !verdict.error && verdict.source === 'reader',
    state: u.state as UpdateState,
    detail: u.detail,
    cls,
    holds: held?.holds ?? [],
    snoozed,
    mergeCommitSha: change?.mergeCommitSha ?? null,
    deployStatus: (deploy?.status as ActionContext['deployStatus']) ?? null,
    verdictError: !!verdict?.error,
    hasVerdict: !!verdict && !verdict.error,
    hasProposal,
    ackedAt: u.acked_at,
    atFromTag: image ? image.current_tag === u.from_tag.split('@')[0] : undefined,
    fork,
  }
  const actions = actionsFor(ctx)
  const members = decisionMembersOf(u)
  const presented = present(
    actions,
    {
      stack: u.stack,
      service: u.service,
      fromTag: u.from_tag,
      toTag: u.to_tag,
      scope: change?.scope ?? null,
      members,
      restorePoint: cls === 'stateful' || !!verdict?.irreversible,
    },
    loadPolicy().policy,
  )

  return {
    id: u.id,
    stack: u.stack,
    service: u.service,
    image: u.image,
    fromTag: u.from_tag,
    toTag: u.to_tag,
    magnitude: u.magnitude as Magnitude,
    cls,
    state: u.state as UpdateState,
    detail: u.detail,
    rolling: u.detail === 'rolling',
    fork,
    forkConflict,
    securityFix: verifiedFix(u.id),
    detectedAt: u.detected_at,
    updatedAt: u.updated_at,
    ackedAt: u.acked_at,
    change,
    holds: held?.holds ?? [],
    waived: held?.waived ?? [],
    shipStatus: held ? held.status.status : null,
    shipWhy: held && held.status.status === 'waiting' ? held.status.why : null,
    reviewOff: reviewOffReason(loadPolicy().policy),
    snoozedUntil: snoozed ? u.snoozed_until : null,
    approvedAt: u.approved_at,
    restorePoints: change
      ? restorePointsFor(change.id).map((p) => ({ service: p.service, path: p.path, createdAt: p.created_at }))
      : [],
    verdict,
    deploy,
    actions,
    primary: primaryVerb(actions),
    transient: isTransient(ctx),
    presented,
    screen: screenView(u.image, u.from_tag, u.to_tag),
  }
}

/** The live updates one decision covers, with their classes: what a confirmation lists. */
function decisionMembersOf(u: RawUpdate): { stack: string; service: string; cls: ServiceClass }[] {
  const d = recentDecisions().find((x) => x.members.some((m) => m.id === u.id))
  if (d) return d.members.map((m) => ({ stack: m.stack, service: m.service, cls: normaliseClass(m.tier) }))
  const rows = getDb()
    .prepare(
      `SELECT stack, service, tier FROM updates
        WHERE state IN ('detected', 'frozen') AND image = ? AND to_tag = ? ORDER BY id`,
    )
    .all(u.image, u.to_tag) as { stack: string; service: string; tier: string }[]
  const out = rows.map((r) => ({ stack: r.stack, service: r.service, cls: normaliseClass(r.tier) }))
  return out.length > 0 ? out : [{ stack: u.stack, service: u.service, cls: normaliseClass(u.tier) }]
}

/** Decisions, computed once per render rather than once per row. */
let decisionsMemo: { at: number; value: Decision[] } | null = null

function recentDecisions(): Decision[] {
  if (!decisionsMemo || Date.now() - decisionsMemo.at > 1000)
    decisionsMemo = { at: Date.now(), value: currentDecisions() }
  return decisionsMemo.value
}

export function updateView(id: number): UpdateView | null {
  const u = getDb().prepare(`${SELECT_UPDATE} WHERE u.id = ?`).get(id) as RawUpdate | undefined
  return u ? toView(u, repoName()) : null
}

export function repoName(): string {
  return env.githubRepo
}
