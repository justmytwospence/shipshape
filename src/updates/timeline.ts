import { getDb } from '../db.ts'
import { gitBranch } from '../env.ts'
import { VERDICT_LABEL } from './vocabulary.ts'
import { readRecordedPlan } from '../deploy/runstate.ts'
import { updateView } from './view.ts'

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
    if (v.change.scope === 'proposed') {
      out.push({ at: c?.created_at ?? null, kind: 'drafted', label: 'config changes drafted', detail: 'they ship with the update' })
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
      label: `reviewed: ${VERDICT_LABEL[v.verdict.recommendation as keyof typeof VERDICT_LABEL] ?? 'reviewed'}, ${v.verdict.confidence} confidence`,
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
      out.push({ at: c.merged_at, kind: 'merged', label: `shipped: a merge commit on ${gitBranch()}` })
    } else if (c?.state === 'closed') {
      out.push({ at: null, kind: 'closed', label: 'drafted change closed' })
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
