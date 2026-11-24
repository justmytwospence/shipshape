import { type Policy } from '../policy-schema.ts'
import { env } from '../env.ts'
import { getDb } from '../db/index.ts'
import { logEvent } from '../events.ts'
import { scanRepo } from '../compose/scan.ts'
import { forkConflictFor } from '../forks.ts'
import { groupUpdates, makeLookups, type GroupMember, type UpdateGroup } from '../groups.ts'
import { holdsForRow, HOLD_COLUMNS, type HoldRow, type UpdateHolds } from '../updates/holds.ts'
import { composeFileFor, isFork } from '../images/rows.ts'

/**
 * Updates that may be considered for shipping, grouped so companions travel together.
 * Exported for the tests, which check what never reaches it rather than what does.
 *
 * Detected updates, and frozen ones the operator has approved. Never a rolling tag (there
 * is nothing to change in git).
 */
export function eligibleGroups(policy: Policy): UpdateGroup[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT u.id, u.stack, u.service, u.image, u.from_tag, u.to_tag, u.magnitude, u.tier,
              u.detail
       FROM updates u
       WHERE (u.state = 'detected' OR (u.state = 'frozen' AND u.approved_at IS NOT NULL))
         AND COALESCE(u.detail, '') != 'rolling'
         -- A ship of it was being pushed when shipshape last stopped: reconcilePushing says
         -- whether it landed, and until it has, shipping it again could land it twice.
         AND NOT EXISTS (SELECT 1 FROM pr_updates pu2 JOIN prs p2 ON p2.id = pu2.pr_id
                         WHERE pu2.update_id = u.id AND p2.state = 'pushing')
       ORDER BY u.id`,
    )
    .all() as (GroupMember & { detail: string | null })[]

  const wanted = rows.filter((r) => r.tier !== 'skip')
  if (wanted.length === 0) return []

  const services = scanRepo(env.repoDir, policy.exclude_stacks)
  // A service that is in no compose file any more (removed, or its stack renamed) has
  // nothing to bump: retire its update rather than retry it, and ask about it, forever.
  // Both sources must agree it is gone -- absent from this scan of the files *and* from the
  // images the last full scan recorded -- so a scan that read nothing retires nothing.
  const present = new Set(services.map((s) => `${s.stack}/${s.service}`))
  const isGone = (r: { stack: string; service: string }) =>
    services.length > 0 && !present.has(`${r.stack}/${r.service}`) && composeFileFor(r.stack, r.service) === null
  const gone = wanted.filter(isGone)
  if (gone.length > 0) {
    const mark = db.prepare(`UPDATE updates SET state = 'superseded', detail = 'service removed', updated_at = ? WHERE id = ?`)
    const now = new Date().toISOString()
    for (const r of gone) mark.run(now, r.id)
    logEvent({
      level: 'info',
      kind: 'ship',
      message: `retired ${gone.length} update(s) for services no longer in any compose file`,
      detail: gone.map((r) => `${r.stack}/${r.service}`).join(', ').slice(0, 300),
    })
  }
  // A fork whose last replay onto this very target conflicted, from this very pin, is
  // left alone: the replay would fail identically every poll. A changed pin or a newer
  // target is a new attempt (the forks guide, "When a rebase conflicts").
  const candidates = wanted.filter((r) => {
    if (isGone(r)) return false
    if (!isFork(r.stack, r.service)) return true
    const conflict = forkConflictFor(r.stack, r.service)
    if (!conflict) return true
    const live = services.find((s) => s.stack === r.stack && s.service === r.service)
    const pinned = /#([0-9a-f]{7,40})$/.exec(live?.buildContext ?? '')?.[1] ?? null
    return !(conflict.toTag === r.to_tag.split('@')[0] && pinned === conflict.sha)
  })
  if (candidates.length === 0) return []

  const { sourceRepoFor, groupLabelFor } = makeLookups(services)
  return mergeApproved(groupUpdates(candidates, sourceRepoFor, groupLabelFor))
}


/**
 * One tap on a stack's card approves every update in it at the same instant; those ship
 * together, as one merge commit and one deploy, rather than one per image.
 */
export function mergeApproved(groups: UpdateGroup[]): UpdateGroup[] {
  const ids = groups.flatMap((g) => g.members.map((m) => m.id))
  if (ids.length === 0) return groups
  const approvedAt = new Map(
    (getDb()
      .prepare(`SELECT id, approved_at FROM updates WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as { id: number; approved_at: string | null }[]).map((r) => [r.id, r.approved_at]),
  )
  const out: UpdateGroup[] = []
  const byTap = new Map<string, UpdateGroup[]>()
  for (const g of groups) {
    const stamps = new Set(g.members.map((m) => approvedAt.get(m.id) ?? null))
    const stamp = stamps.size === 1 ? [...stamps][0] : null
    if (!stamp) {
      out.push(g)
      continue
    }
    const k = `${g.members[0]!.stack}|${stamp}`
    byTap.set(k, [...(byTap.get(k) ?? []), g])
  }
  for (const gs of byTap.values()) {
    if (gs.length === 1) {
      out.push(gs[0]!)
      continue
    }
    const members = gs.flatMap((g) => g.members).sort((a, b) => a.id - b.id)
    const stack = members[0]!.stack
    out.push({ key: `${stack}--decision--${members[0]!.id}`, branchKey: `${stack}--decision`, members })
  }
  return out.sort((a, b) => a.members[0]!.id - b.members[0]!.id)
}


function membersRows(group: UpdateGroup): HoldRow[] {
  const db = getDb()
  const stmt = db.prepare(`SELECT ${HOLD_COLUMNS} FROM updates u WHERE u.id = ?`)
  return group.members.map((m) => stmt.get(m.id) as HoldRow)
}


/** Every member's own status; a group ships only when all are ready. */
export function statusesFor(group: UpdateGroup, policy: Policy): UpdateHolds[] {
  return membersRows(group).map((r) => holdsForRow(r, policy))
}


/** What the group as a whole is: ready, waiting, or a decision. */
export function groupStatus(statuses: UpdateHolds[]): 'ready' | 'decision' | 'waiting' {
  if (statuses.every((s) => s.status.status === 'ready')) return 'ready'
  if (statuses.some((s) => s.status.status === 'decision')) return 'decision'
  return 'waiting'
}
