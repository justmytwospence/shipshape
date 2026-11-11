import { getDb } from '../db.ts'
import { verifiedFix, type SecurityFix } from '../security/act.ts'
import { forkConflictFor } from '../forks.ts'
import { loadPolicy } from '../config.ts'
import { normaliseClass, type Hold, type ServiceClass } from '../policy.ts'
import { currentDecisions, holdsForRow, type Decision, type HoldRow } from './holds.ts'
import { changeUrl } from '../gitops/change.ts'
import { restorePointsFor } from '../restore/index.ts'
import { present, type Presentation } from './present.ts'
import { screenFor } from '../analyze/screen/run.ts'
import type { Outcome } from './vocabulary.ts'
import type { Magnitude } from '../versions/patterns.ts'
import { actionsFor, isTransient, primaryVerb, type ActionContext, type Verb } from './actions.ts'
import { LIVE_STATES, sqlIn, type UpdateState } from './state.ts'
import { refLinks, registryName, type RefLinks } from '../links.ts'
import { parseImageRef } from '../images/ref.ts'
import { readRecordedPlan } from '../deploy/runstate.ts'
import { sourceForSync } from '../resolver/index.ts'

/**
 * What the pages read.
 *
 * The old dashboard asked one question -- "what is pending" -- and answered it with a
 * table of everything in three states. That is a list of rows, not a worklist: it cannot
 * distinguish an update waiting on a decision from one waiting on a machine, and it stops
 * at the merge, so everything after it (deployed, verified, rolled back) existed only as
 * free text in the log. These queries answer the questions an operator actually has:
 * what needs me, what happened, and what is the whole story of this one update.
 */

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
  /** The service runs our own build of this image, which shipshape rebases and retires (FORKS.md). */
  fork: boolean
  /** Why the fork's last replay onto this target opened nothing: the commit and file that conflicted. */
  forkConflict: string | null
  detectedAt: string
  updatedAt: string
  ackedAt: string | null
  /** What landed (or will land) on main for this update: a merge commit, or a v1 pull request. */
  change: {
    id: number
    kind: 'github' | 'local'
    /** The pull request number; 0 for a local change. */
    number: number
    state: string
    scope: 'tag-only' | 'proposed' | 'modified'
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
export function screenView(image: string, fromTag: string, toTag: string): ScreenView | null {
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
    notable: s.notable.map((i) => s.lines[i]).filter((l) => !!l).slice(0, 5),
  }
}

const SELECT_UPDATE = `
  SELECT u.id, u.stack, u.service, u.image, u.from_tag, u.to_tag, u.magnitude, u.tier,
         u.state, u.detail, u.detected_at, u.updated_at, u.acked_at,
         u.approved_at, u.snoozed_until, u.decision_since, u.restore_error
    FROM updates u`

interface RawUpdate {
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
      `SELECT p.id, p.kind, p.number, p.state, p.scope, p.branch, p.merge_commit_sha
         FROM prs p JOIN pr_updates pu ON pu.pr_id = p.id
        WHERE pu.update_id = ? ORDER BY p.id DESC LIMIT 1`,
    )
    .get(updateId) as
    | { id: number; kind: string; number: number; state: string; scope: string; branch: string; merge_commit_sha: string | null }
    | undefined
  if (!row) return null
  return {
    id: row.id,
    kind: row.kind === 'local' ? 'local' : 'github',
    number: row.number,
    state: row.state,
    scope: (row.scope ?? 'tag-only') as 'tag-only' | 'proposed' | 'modified',
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

function toView(u: RawUpdate, _repo?: string): UpdateView {
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
    prScope: change?.scope ?? null,
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
    snoozedUntil: snoozed ? u.snoozed_until : null,
    approvedAt: u.approved_at,
    restorePoints: change ? restorePointsFor(change.id).map((p) => ({ service: p.service, path: p.path, createdAt: p.created_at })) : [],
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
  if (!decisionsMemo || Date.now() - decisionsMemo.at > 1000) decisionsMemo = { at: Date.now(), value: currentDecisions() }
  return decisionsMemo.value
}

export function updateView(id: number): UpdateView | null {
  const u = getDb().prepare(`${SELECT_UPDATE} WHERE u.id = ?`).get(id) as RawUpdate | undefined
  return u ? toView(u, repoName()) : null
}

function repoName(): string {
  return process.env.GITHUB_REPO ?? 'you/repo'
}

// ------------------------------------------------------------------ the inbox

/** Why an update is in the inbox. The order here is the order the page shows them in. */
export const ATTENTION_KINDS = [
  'broken', // a deploy failed, rolled back, or degraded, and nothing newer has replaced it
  'decision', // an update waiting on you: the question on its card
  'ready-to-deploy', // v1: merged and waiting on the button
  'rolling-moved', // a rolling tag moved under us
] as const

export type AttentionKind = (typeof ATTENTION_KINDS)[number]

export interface AttentionItem {
  kind: AttentionKind
  update: UpdateView
}

/**
 * What is actually waiting on a person.
 *
 * Deliberately not "everything not finished": an update that will ship itself tonight is
 * not waiting on you, and putting it in the same list as a service that is down is how a
 * list stops being read.
 */
export function inboxNeedsYou(): AttentionItem[] {
  const db = getDb()
  const rows = db
    .prepare(
      `${SELECT_UPDATE}
        WHERE u.state IN ${sqlIn([...LIVE_STATES, 'merged', 'deployed', 'verified', 'failed'])}
        ORDER BY u.updated_at DESC`,
    )
    .all() as RawUpdate[]

  const items: AttentionItem[] = []
  for (const raw of rows) {
    const v = toView(raw)
    const kind = attentionKind(v)
    if (kind) items.push({ kind, update: v })
  }
  const rank = (k: AttentionKind) => ATTENTION_KINDS.indexOf(k)
  return items.sort((a, b) => rank(a.kind) - rank(b.kind) || b.update.updatedAt.localeCompare(a.update.updatedAt))
}

/** Broken rows leave the inbox on their own after this long. */
const BROKEN_EXPIRY_MS = 14 * 24 * 60 * 60_000

/**
 * A failure stops being news once something newer has replaced it: a later update of the
 * same service that merged, deployed or verified, or a fortnight of nobody caring. Without
 * this a rollback from September sat in the inbox for as long as nobody pressed Ack, long
 * after the version it was about had been overtaken.
 */
function brokenExpired(v: UpdateView): boolean {
  if (Date.now() - Date.parse(v.updatedAt) > BROKEN_EXPIRY_MS) return true
  const newer = getDb()
    .prepare(
      `SELECT 1 FROM updates WHERE stack = ? AND service = ? AND id > ?
          AND state IN ('merged', 'deployed', 'verified') LIMIT 1`,
    )
    .get(v.stack, v.service, v.id)
  return !!newer
}

function attentionKind(v: UpdateView): AttentionKind | null {
  // Merged and nothing more is owed: the service was not running, so nothing was started,
  // and that is the outcome rather than a problem. It is checked before the deploy status
  // because a group's running half can go degraded on the same row, and that half is the
  // one the inbox is about -- not the member that was left exactly as it was.
  if (v.state === 'left-stopped') return null
  const d = v.deploy?.status
  const seen = !!v.ackedAt

  const broken =
    (v.state === 'failed' && !seen) ||
    (v.state === 'merged' && (d === 'failed' || d === 'error') && !seen) ||
    (d === 'degraded' && !seen)
  if (broken) return brokenExpired(v) ? null : 'broken'
  // `ready` waits for the button (v1's attended rung). `pending` is queued and starts on the
  // next tick by itself, so it is not waiting on you.
  if (v.state === 'merged' && d === 'ready') return 'ready-to-deploy'
  if (v.state === 'detected' && v.rolling) return 'rolling-moved'
  if (v.state === 'detected' && v.shipStatus === 'decision' && !v.snoozedUntil) return 'decision'
  return null
}

/**
 * Updates that are tracked but parked: frozen services, and decisions that were snoozed.
 * Informational -- they are the answer to "why is this not in the list", which is
 * otherwise unanswerable from the interface.
 */
export function inboxParked(): UpdateView[] {
  const rows = getDb()
    .prepare(
      `${SELECT_UPDATE}
        WHERE u.state = 'frozen'
           OR (u.state = 'detected' AND u.snoozed_until > ? AND COALESCE(u.detail, '') != 'rolling')
        ORDER BY u.stack, u.service`,
    )
    .all(new Date().toISOString()) as RawUpdate[]
  return rows.map((r) => toView(r))
}

export interface RecentItem {
  at: string
  kind: Outcome
  stack: string
  service: string
  fromTag: string
  toTag: string
  updateId: number
  prNumber: number | null
  detail: string | null
}

/** What happened lately, so "did last night go fine" is one glance rather than a hunt. */
export function inboxRecent(hours = 24, limit = 20): RecentItem[] {
  const since = new Date(Date.now() - hours * 3600_000).toISOString()
  const db = getDb()

  const opened = db
    .prepare(
      `SELECT p.created_at AS at, 'opened' AS kind, u.stack, u.service, u.from_tag AS fromTag, u.to_tag AS toTag,
              u.id AS updateId, NULLIF(p.number, 0) AS prNumber, NULL AS detail
         FROM prs p JOIN pr_updates pu ON pu.pr_id = p.id JOIN updates u ON u.id = pu.update_id
        WHERE p.created_at >= ?`,
    )
    .all(since) as RecentItem[]

  const merged = db
    .prepare(
      `SELECT p.merged_at AS at, 'merged' AS kind, u.stack, u.service, u.from_tag AS fromTag, u.to_tag AS toTag,
              u.id AS updateId, NULLIF(p.number, 0) AS prNumber, NULL AS detail
         FROM prs p JOIN pr_updates pu ON pu.pr_id = p.id JOIN updates u ON u.id = pu.update_id
        WHERE p.merged_at >= ?`,
    )
    .all(since) as RecentItem[]

  // A left-stopped update is named by its own state, not by the row's status, on the newest
  // deploy that carried it: in a group the running half can verify on the same row, and
  // reading the status alone would say the member that was never started "verified". An
  // older row it was linked to keeps saying what that row did. Anything unrecognised still
  // falls to `failed`, which is why the new status has to be named here at all.
  //
  // The row's recorded plan says it too, and outlasts the state: once a later merge
  // overtakes the update it reads superseded, and without the plan arm Recently turned the
  // member that was never started into "verified". A row that rolled back or could not be
  // run keeps its own word. The CASE inside json_each keeps a malformed snapshot from
  // failing the whole list.
  const deployed = db
    .prepare(
      `SELECT d.finished_at AS at,
              CASE WHEN d.status = 'left-stopped' THEN 'left-stopped'
                   WHEN u.state = 'left-stopped'
                        AND d.id = (SELECT MAX(du2.deploy_id) FROM deploy_updates du2 WHERE du2.update_id = u.id)
                     THEN 'left-stopped'
                   WHEN d.status NOT IN ('rolled-back', 'error')
                        AND EXISTS (SELECT 1
                                      FROM json_each(CASE WHEN json_valid(d.snapshot) THEN d.snapshot ELSE '{}' END, '$.left') j
                                     WHERE json_extract(j.value, '$.service') = u.service)
                     THEN 'left-stopped'
                   WHEN d.status = 'verified' THEN 'verified' WHEN d.status = 'degraded' THEN 'degraded'
                   WHEN d.status = 'rolled-back' THEN 'rolled-back' WHEN d.status = 'deployed' THEN 'deployed'
                   ELSE 'failed' END AS kind,
              u.stack, u.service, u.from_tag AS fromTag, u.to_tag AS toTag,
              u.id AS updateId, NULLIF(d.pr_number, 0) AS prNumber, d.detail
         FROM deploys d JOIN deploy_updates du ON du.deploy_id = d.id
         JOIN updates u ON u.id = du.update_id
        WHERE d.finished_at >= ? AND d.status NOT IN ('pending','ready','running','superseded')`,
    )
    .all(since) as RecentItem[]

  const closed = db
    .prepare(
      `SELECT u.updated_at AS at,
              CASE u.state WHEN 'skipped' THEN 'skipped' ELSE 'superseded' END AS kind,
              u.stack, u.service, u.from_tag AS fromTag, u.to_tag AS toTag,
              u.id AS updateId, NULL AS prNumber, u.detail
         FROM updates u
        WHERE u.updated_at >= ? AND u.state IN ('skipped','superseded')`,
    )
    .all(since) as RecentItem[]

  return [...opened, ...merged, ...deployed, ...closed]
    .filter((r) => r.at)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit)
}

// --------------------------------------------------------------- the timeline

export interface Milestone {
  at: string | null
  kind: string
  label: string
  detail?: string | null
  /** Rendered ahead of time, greyed: this step has not happened yet. */
  future?: boolean
  level?: 'info' | 'warn' | 'error'
}

/**
 * One update's whole story, in order.
 *
 * Everything here was already recorded and none of it was reachable: a verdict lived in a
 * pull request body on GitHub, a deploy's verify findings in a JSON column nothing read,
 * and "verified" or "rolled back" only ever as a sentence in the log.
 */
export function updateTimeline(id: number): Milestone[] {
  const v = updateView(id)
  if (!v) return []
  const out: Milestone[] = []

  out.push({
    at: v.detectedAt,
    kind: 'detected',
    label: `${v.magnitude} update detected`,
    detail: `${v.fromTag} → ${v.toTag}`,
  })

  if (v.change) {
    const c = getDb()
      .prepare(`SELECT created_at, merged_at, state FROM prs WHERE id = ?`)
      .get(v.change.id) as { created_at: string; merged_at: string | null; state: string } | undefined
    const proposed = v.change.scope === 'proposed'
    if (v.change.kind === 'github') {
      out.push({
        at: c?.created_at ?? null,
        kind: 'pr',
        label: `pull request #${v.change.number} opened`,
        detail: v.change.scope === 'tag-only' ? null : `carries ${proposed ? 'drafted config changes' : 'edits'}`,
      })
    } else if (proposed) {
      out.push({ at: c?.created_at ?? null, kind: 'pr', label: 'config changes drafted', detail: 'shipping it merges them too' })
    }
  }

  if (v.verdict?.error) {
    out.push({
      at: v.verdict.createdAt,
      kind: 'review',
      label: `changelog review failed (attempt ${v.verdict.attempts})`,
      detail: v.verdict.error,
      level: 'warn',
    })
  } else if (v.verdict) {
    out.push({
      at: v.verdict.createdAt,
      kind: 'review',
      label: `reviewed: ${v.verdict.recommendation} at ${v.verdict.confidence} confidence`,
      detail: v.verdict.summary,
      level: v.verdict.recommendation === 'block' ? 'warn' : 'info',
    })
  }

  if (v.holds.length > 0 && v.state === 'detected') {
    out.push({ at: null, kind: 'decision', label: 'waiting on you', detail: v.holds.map((h) => h.text).join('; '), level: 'warn' })
  }
  if (v.snoozedUntil) out.push({ at: null, kind: 'snoozed', label: `snoozed until ${v.snoozedUntil.slice(0, 10)}` })
  if (v.approvedAt) out.push({ at: v.approvedAt, kind: 'approved', label: 'you said ship' })
  for (const h of v.waived) out.push({ at: null, kind: 'waived', label: `rule ${h.waivedBy} waived a hold`, detail: h.text })

  if (v.change) {
    const c = getDb()
      .prepare(`SELECT merged_at, state FROM prs WHERE id = ?`)
      .get(v.change.id) as { merged_at: string | null; state: string } | undefined
    for (const p of v.restorePoints) out.push({ at: p.createdAt, kind: 'restore', label: `restore point: ${p.service}`, detail: p.path })
    if (c?.merged_at) {
      out.push({ at: c.merged_at, kind: 'merged', label: v.change.kind === 'local' ? 'shipped: merged into main' : 'merged into main' })
    } else if (c?.state === 'closed') {
      out.push({ at: null, kind: 'closed', label: v.change.kind === 'github' ? 'pull request closed without merging' : 'drafted change closed' })
    }
  }

  if (v.deploy) {
    const d = getDb()
      .prepare(`SELECT verdict, snapshot, diagnosis, created_at FROM deploys WHERE id = ?`)
      .get(v.deploy.id) as
      | { verdict: string | null; snapshot: string | null; diagnosis: string | null; created_at: string }
      | undefined

    if (v.deploy.status === 'ready') {
      out.push({
        at: d?.created_at ?? null,
        kind: 'ready',
        label: 'ready to deploy',
        detail: 'waiting for you — this service is deployed by hand',
      })
    }
    if (v.deploy.startedAt) {
      out.push({
        at: v.deploy.startedAt,
        kind: 'deploying',
        label: v.deploy.trigger === 'queue' ? 'deploying' : `deploying (${v.deploy.trigger})`,
      })
    }

    const finished: Record<string, { label: string; level?: Milestone['level'] }> = {
      deployed: { label: 'up and healthy — soaking' },
      verified: { label: 'verified' },
      'left-stopped': { label: 'left stopped — it was not running' },
      degraded: { label: 'degraded after the soak', level: 'warn' },
      failed: { label: 'deploy failed', level: 'error' },
      'rolled-back': { label: 'rolled back to the previous version', level: 'error' },
      error: { label: 'the deploy could not be run', level: 'error' },
    }
    // Left stopped wins over the row's status. A group deploy is one row for both halves, so
    // the row can say deployed or verified about the member that came up while this one was
    // never started -- and the soak that row is waiting on is not a step this update takes.
    //
    // Read from the row's recorded plan, not only the update's state. The state stops saying
    // left-stopped once a later merge overtakes the update and it reads superseded, and the
    // history then claimed "verified" for the member that was never started. A row that
    // rolled back, or could not be run, is named by what it did instead.
    const leftHere =
      readRecordedPlan(d?.snapshot ?? null)?.left.some((l) => l.service === v.service) ?? false
    const key =
      v.state === 'left-stopped' ||
      (leftHere && v.deploy.status !== 'rolled-back' && v.deploy.status !== 'error')
        ? 'left-stopped'
        : v.deploy.status
    const f = finished[key]
    if (f) {
      out.push({
        at: v.deploy.finishedAt ?? v.deploy.startedAt,
        kind: key,
        label: f.label,
        detail: v.deploy.detail ?? verifyDetail(d?.verdict),
        level: f.level,
      })
    }
    if (v.deploy.status === 'deployed' && v.deploy.recheckAt && key !== 'left-stopped') {
      out.push({
        at: v.deploy.recheckAt,
        kind: 'verified',
        label: 'verified, if it is still healthy',
        future: true,
      })
    }
  }

  if (v.state === 'skipped') {
    out.push({ at: v.updatedAt, kind: 'skipped', label: 'skipped', detail: v.detail })
  }
  if (v.state === 'superseded') {
    out.push({ at: v.updatedAt, kind: 'superseded', label: 'superseded', detail: v.detail })
  }

  return out
}

function verifyDetail(json: string | null | undefined): string | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as { detail?: string; findings?: { code: string; service: string }[] }
    if (v.detail) return v.detail
    if (v.findings?.length) return v.findings.map((f) => `${f.service}: ${f.code}`).join(', ')
  } catch {
    /* a malformed verdict is not worth failing a page over */
  }
  return null
}

// -------------------------------------------------------------- lists & filters

/** The stages the Updates page filters by, and which states each covers. */
export const STAGE_FILTERS = {
  open: ['detected', 'frozen', 'pr_open', 'merged'],
  rolling: ['deploying', 'deployed'],
  // Left stopped is merged with nothing more owed by shipshape, so it is finished rather
  // than open -- in Open it would sit in the list and the nav count forever.
  done: ['verified', 'left-stopped'],
  closed: ['failed', 'skipped', 'superseded'],
} as const satisfies Record<string, readonly UpdateState[]>

/**
 * `releases` is not a state filter like the others -- it is the same rows read for a
 * different reason. The stage tabs above answer "what is in my way"; releases answers
 * "what came out", which wants recency rather than the triage order, and every release
 * rather than a slice of the pipeline. It rides on the stage parameter because it is
 * still a way of looking at the updates list, and the alternative -- a second axis in
 * the toolbar, or a seventh destination in a navigation that documents six as its
 * ceiling -- costs more than it explains.
 */
export type StageFilter = keyof typeof STAGE_FILTERS | 'all' | 'releases'

export function listUpdates(opts: { stage?: StageFilter; q?: string; magnitude?: string; limit?: number } = {}): UpdateView[] {
  const stage = opts.stage ?? 'open'
  const where: string[] = []
  const args: unknown[] = []

  if (stage !== 'all' && stage !== 'releases') {
    where.push(`u.state IN ${sqlIn(STAGE_FILTERS[stage])}`)
  }
  if (opts.magnitude && opts.magnitude !== 'all') {
    where.push(`u.magnitude = ?`)
    args.push(opts.magnitude)
  }
  if (opts.q) {
    where.push(`(u.stack LIKE ? OR u.service LIKE ? OR u.image LIKE ?)`)
    const like = `%${opts.q}%`
    args.push(like, like, like)
  }

  const rows = getDb()
    .prepare(
      `${SELECT_UPDATE}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY CASE u.magnitude WHEN 'major' THEN 0 WHEN 'minor' THEN 1 WHEN 'patch' THEN 2 ELSE 3 END,
                u.updated_at DESC
       LIMIT ?`,
    )
    .all(...args, opts.limit ?? 200) as RawUpdate[]
  const repo = repoName()
  return rows.map((r) => toView(r, repo))
}

/**
 * One release, as something to read rather than something to action.
 *
 * Same rows as the updates list, ordered by when they turned up rather than by how big
 * they are, and carrying the outbound links. The links matter most here: they are derived
 * from the image reference and the resolved source repository, so a release has somewhere
 * to send you even when no changelog review ever ran for it -- which is the common case,
 * because reviews are written for pull requests and most updates apply without one.
 */
export interface ReleaseView extends UpdateView {
  links: RefLinks
  /** What to call the registry, for the link that exists when no changelog does. */
  registry: string
}

export function listReleases(
  opts: { q?: string; magnitude?: string; limit?: number } = {},
): ReleaseView[] {
  const where: string[] = []
  const args: unknown[] = []

  if (opts.magnitude && opts.magnitude !== 'all') {
    where.push(`u.magnitude = ?`)
    args.push(opts.magnitude)
  }
  if (opts.q) {
    where.push(`(u.stack LIKE ? OR u.service LIKE ? OR u.image LIKE ?)`)
    const like = `%${opts.q}%`
    args.push(like, like, like)
  }

  // The source comes from the one accessor, with the service's label applied, rather than
  // from a join on the resolution cache -- which is how a labelled service showed a registry
  // link here instead of its release notes. It is keyed by the update's own image reference,
  // so a release whose service has since left the compose file keeps its links. Without a
  // source, refLinks falls back to what the image reference alone can produce, which is the
  // registry rather than the changelog.
  const rows = getDb()
    .prepare(
      `SELECT u.id, u.stack, u.service, u.image, u.from_tag, u.to_tag, u.magnitude, u.tier,
              u.state, u.detail, u.detected_at, u.updated_at, u.acked_at
         FROM updates u
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY u.detected_at DESC, u.id DESC
       LIMIT ?`,
    )
    .all(...args, opts.limit ?? 200) as RawUpdate[]

  const repo = repoName()
  // Most of a feed is the same few services over and over; ask once for each.
  const sources = new Map<string, string | null>()
  return rows.map((r) => {
    const ref = parseImageRef(r.image)
    const key = `${ref.registry}/${ref.repository}|${r.stack}/${r.service}`
    if (!sources.has(key)) {
      const s = sourceForSync(
        { registry: ref.registry, repository: ref.repository },
        { service: { stack: r.stack, service: r.service } },
      )
      sources.set(key, s.repo)
    }
    return {
      ...toView(r, repo),
      links: refLinks(ref, r.to_tag, sources.get(key) ?? null),
      registry: registryName(ref.registry),
    }
  })
}

/** Every update ever recorded for one service, newest first. */
export function updatesForService(stack: string, service: string): UpdateView[] {
  const rows = getDb()
    .prepare(`${SELECT_UPDATE} WHERE u.stack = ? AND u.service = ? ORDER BY u.detected_at DESC`)
    .all(stack, service) as RawUpdate[]
  const repo = repoName()
  return rows.map((r) => toView(r, repo))
}
