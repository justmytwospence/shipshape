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
import { canRestore } from '../restore/index.ts'
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
    hasSnapshot: canRestore(row.stack, policy),
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
 * One question for you: the updates one card asks about and one tap answers.
 *
 * A decision is a stack: everything in it that needs you, shipped together as one merge
 * commit when you say ship (src/gitops/ship.ts, `eligibleGroups`). The one exception is a
 * bump fanned out across stacks -- the same image moving to the same tag in stacks that
 * have nothing else waiting (nineteen agentgateway sidecars) -- which is one card, not
 * nineteen.
 */
export interface Decision {
  /** The card key's suffix: `stack:<stack>`, or the image repository for a fan-out. */
  key: string
  /** The stack, or null for a fan-out. */
  stack: string | null
  /** The image repository for a fan-out, else null. */
  repository: string | null
  members: HoldRow[]
  /** Blocking holds per member id. */
  holdsOf: Map<number, Hold[]>
  /** Blocking holds, de-duplicated across members, in first-seen order. */
  holds: Hold[]
  since: string
}

export function currentDecisions(policy: Policy = loadPolicy().policy, now = Date.now()): Decision[] {
  const rows = getDb()
    .prepare(
      `SELECT ${HOLD_COLUMNS} FROM updates u
        WHERE u.state = 'detected' AND COALESCE(u.detail, '') != 'rolling'
        ORDER BY u.detected_at DESC, u.id DESC`,
    )
    .all() as HoldRow[]

  // The newest target per service; an older detection it overtook is not a question.
  const seen = new Set<string>()
  const byStack = new Map<string, { row: HoldRow; holds: Hold[]; repo: string }[]>()
  for (const r of rows) {
    const svc = `${r.stack}/${r.service}`
    if (seen.has(svc)) continue
    seen.add(svc)
    let repo: string
    try {
      repo = repositoryOf(r.image)
    } catch {
      continue
    }
    const h = holdsForRow(r, policy, now)
    if (h.status.status !== 'decision') continue
    const list = byStack.get(r.stack) ?? []
    list.push({ row: r, holds: h.holds, repo })
    byStack.set(r.stack, list)
  }

  // A stack whose only question is one image at one tag can share a card with every other
  // stack asking exactly that.
  const fanSig = (list: { row: HoldRow; repo: string }[]): string | null => {
    const sigs = new Set(list.map((e) => `${e.repo}|${e.row.to_tag}`))
    return sigs.size === 1 ? [...sigs][0]! : null
  }
  const fan = new Map<string, string[]>()
  for (const [stack, list] of byStack) {
    const sig = fanSig(list)
    if (sig) fan.set(sig, [...(fan.get(sig) ?? []), stack])
  }

  const build = (
    key: string,
    stack: string | null,
    repository: string | null,
    entries: { row: HoldRow; holds: Hold[] }[],
  ): Decision => {
    const sorted = [...entries].sort((a, b) => a.row.id - b.row.id)
    const holds = new Map<string, Hold>()
    for (const e of sorted) for (const h of e.holds) if (!holds.has(h.kind)) holds.set(h.kind, h)
    const members = sorted.map((e) => e.row)
    return {
      key,
      stack,
      repository,
      members,
      holdsOf: new Map(sorted.map((e) => [e.row.id, e.holds])),
      holds: [...holds.values()],
      since: members.map((m) => m.decision_since ?? m.detected_at).sort()[0]!,
    }
  }

  const out: Decision[] = []
  const fanned = new Set<string>()
  for (const [sig, stacks] of fan) {
    if (stacks.length < 2) continue
    const repo = sig.split('|')[0]!
    out.push(build(repo, null, repo, stacks.flatMap((s) => byStack.get(s)!)))
    for (const s of stacks) fanned.add(s)
  }
  for (const [stack, list] of byStack) {
    if (fanned.has(stack)) continue
    out.push(build(`stack:${stack}`, stack, null, list))
  }
  return out.sort((a, b) => a.members[0]!.id - b.members[0]!.id)
}

/**
 * Every update that one decision covers, ordered by id, so the first is the one a card and
 * its taps name. An update that is not part of a current decision (snoozed, frozen, acted
 * on from the dashboard) covers the live rows with the same image repository and target.
 */
export function decisionMembers(id: number): HoldRow[] {
  const d = currentDecisions().find((x) => x.members.some((m) => m.id === id))
  if (d) return d.members
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
