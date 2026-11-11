import { loadPolicy, type Policy } from '../config.ts'
import { getDb } from '../db.ts'
import {
  applyRules,
  blocking,
  holdsFor,
  normaliseClass,
  repositoryOf,
  shipStatus,
  type Hold,
  type HoldInput,
  type HoldVerdict,
  type RuleTarget,
  type ServiceClass,
  type ShipStatus,
} from '../policy.ts'
import { cooldownFor, memberVerdict, reviewExpected } from '../gitops/policy-inputs.ts'
import { securityFixFor } from '../security/act.ts'
import type { Magnitude } from '../versions/patterns.ts'

/**
 * Where one update stands, read from the database: its class, every hold, which of them a
 * rule waives, and whether it ships, waits or needs a decision.
 *
 * The one place that assembles `HoldInput`, so the ship pass, the inbox, the verbs and the
 * cards cannot disagree about whether something is waiting on you.
 */

export interface HoldRow {
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
  approved_at: string | null
  snoozed_until: string | null
  restore_error: string | null
  decision_since: string | null
}

export const HOLD_COLUMNS = `u.id, u.stack, u.service, u.image, u.from_tag, u.to_tag, u.magnitude, u.tier, u.state,
  u.detail, u.detected_at, u.approved_at, u.snoozed_until, u.restore_error, u.decision_since`

export interface UpdateHolds {
  row: HoldRow
  cls: ServiceClass
  /** Holds that still ask for a person. */
  holds: Hold[]
  /** Holds a standing rule waives. */
  waived: Hold[]
  status: ShipStatus
}

interface VerdictRow {
  verdict_row: string | null
  verdict_error: string | null
  recommendation: string | null
  confidence: string | null
  breaking_changes: string | null
  migration_steps: string | null
  irreversible: number | null
  provisional: number | null
  evidence: string | null
}

function list(s: string | null): string[] {
  try {
    const p = JSON.parse(s ?? '[]')
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function notesOf(evidence: string | null): number | null {
  if (!evidence) return null
  try {
    const e = JSON.parse(evidence) as { releases?: number; changelogSections?: number; linkedSections?: number }
    return (e.releases ?? 0) + (e.changelogSections ?? 0) + (e.linkedSections ?? 0)
  } catch {
    return null
  }
}

function verdictFor(row: HoldRow): VerdictRow {
  return (
    (getDb()
      .prepare(
        `SELECT image AS verdict_row, error AS verdict_error, recommendation, confidence,
                breaking_changes, migration_steps, irreversible, provisional, evidence
           FROM verdicts WHERE image = ? AND from_tag = ? AND to_tag = ?`,
      )
      .get(row.image, row.from_tag, row.to_tag) as VerdictRow | undefined) ?? {
      verdict_row: null,
      verdict_error: null,
      recommendation: null,
      confidence: null,
      breaking_changes: null,
      migration_steps: null,
      irreversible: null,
      provisional: null,
      evidence: null,
    }
  )
}

/** Compute everything for one row. `now` is injectable for the tests. */
export function holdsForRow(row: HoldRow, policy: Policy = loadPolicy().policy, now = Date.now()): UpdateHolds {
  const db = getDb()
  const v = verdictFor(row)
  const state = memberVerdict({ ...v, detected_at: row.detected_at }, reviewExpected(policy), now)
  const img = db
    .prepare(`SELECT claude_label, base_dockerfile FROM images WHERE stack = ? AND service = ?`)
    .get(row.stack, row.service) as { claude_label: string | null; base_dockerfile: string | null } | undefined
  const snap = db
    .prepare(`SELECT 1 FROM images WHERE stack = ? AND snapshot_label IS NOT NULL LIMIT 1`)
    .get(row.stack)
  const fix = securityFixFor(row.id, policy)

  const verdict: HoldVerdict | null =
    state === 'present' && v.recommendation
      ? {
          recommendation: v.recommendation as HoldVerdict['recommendation'],
          confidence: (v.confidence ?? 'low') as HoldVerdict['confidence'],
          breaking: list(v.breaking_changes),
          steps: list(v.migration_steps),
          irreversible: v.irreversible === 1,
          notesInRange: notesOf(v.evidence),
        }
      : null

  const cls = normaliseClass(row.tier)
  const input: HoldInput = {
    cls,
    magnitude: row.magnitude as Magnitude,
    verdict,
    verdictState: state,
    required: img?.claude_label?.trim().toLowerCase() === 'required',
    hasSnapshot: !!snap,
    restoreError: row.restore_error,
    securityFix: fix !== null,
  }
  const target: RuleTarget = {
    image: row.image,
    stack: row.stack,
    service: row.service,
    baseBuild: !!img?.base_dockerfile,
  }
  const status = shipStatus({
    ...input,
    target,
    rules: policy.rules,
    approved: row.approved_at !== null,
    paused: policy.paused,
    snoozedUntil: row.snoozed_until,
    cooldown: cooldownFor(row, fix, policy, now),
    now,
  })
  const all = applyRules(holdsFor(input), policy.rules, target)
  return { row, cls, holds: blocking(all), waived: all.filter((h) => h.waivedBy), status }
}

export function holdsForUpdate(id: number, policy?: Policy): UpdateHolds | null {
  const row = getDb().prepare(`SELECT ${HOLD_COLUMNS} FROM updates u WHERE u.id = ?`).get(id) as HoldRow | undefined
  return row ? holdsForRow(row, policy) : null
}

/**
 * Every update that one decision covers: the live rows with the same image repository and
 * target tag, across stacks, plus whatever shares a group with them. Ordered by id, so
 * the first is the one a card and its taps name.
 */
export function decisionMembers(id: number): HoldRow[] {
  const db = getDb()
  const base = db.prepare(`SELECT ${HOLD_COLUMNS} FROM updates u WHERE u.id = ?`).get(id) as HoldRow | undefined
  if (!base) return []
  const repo = repositoryOf(base.image)
  const rows = db
    .prepare(
      `SELECT ${HOLD_COLUMNS} FROM updates u
        WHERE u.state IN ('detected', 'frozen') AND u.to_tag = ?
        ORDER BY u.id`,
    )
    .all(base.to_tag) as HoldRow[]
  const same = rows.filter((r) => {
    try {
      return repositoryOf(r.image) === repo
    } catch {
      return false
    }
  })
  return same.some((r) => r.id === base.id) ? same : [base, ...same].sort((a, b) => a.id - b.id)
}
