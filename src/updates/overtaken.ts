import { getDb, logEvent } from '../db.ts'

/**
 * Retire merged updates that a later merge has overtaken.
 *
 * #79 moved minuspod 2.87.0 -> 2.96.15 and its deploy failed. #93 then moved it 2.96.15
 * -> 2.96.17. From that moment #79 could never be deployed on its own -- the compose
 * file names #93's tag, and a deploy brings up whatever the file says -- but it went on
 * reading `merged`, with a failed deploy and a Retry button, as if it were still
 * something to act on. It took a manual retry to clear it.
 *
 * The rule is the one `superseded` already describes: a newer target replaced it. An
 * update still `merged` is overtaken when another update for the same service has a pull
 * request that merged after its own, and that later update is itself merged or further
 * along. Two exceptions, both about not lying in the other direction:
 *
 * - An update whose own deploy is queued or running is left alone. It is about to have an
 *   outcome of its own, and that outcome is the truth.
 * - A later update that was rolled back or dismissed does not count. A rollback reverts
 *   the file to where the later update started, which is where this one finished -- so
 *   this one's target is live again, not replaced.
 *
 * Called when a pull request merges, and once at startup so updates stranded before this
 * existed are cleared too. Idempotent: an update it retires is no longer `merged`.
 */

export interface Retired {
  updateId: number
  stack: string
  service: string
  toTag: string
  /** The pull request that carried the overtaken update. */
  prNumber: number | null
  /** The pull request that overtook it. */
  byPrNumber: number
}

/** Say what was retired, once each, where the rest of the pull request story is told. */
export function logRetired(retired: Retired[]): void {
  for (const r of retired) {
    logEvent({
      level: 'info',
      kind: 'pr',
      stack: r.stack,
      service: r.service,
      message: `${r.prNumber ? `#${r.prNumber}` : `${r.stack}/${r.service} ${r.toTag}`} retired: overtaken by #${r.byPrNumber}`,
      detail: `${r.toTag} can no longer deploy on its own; #${r.byPrNumber} carries the service past it`,
    })
  }
}

/** States that mean a later update's target really is what the file now says. */
const OVERTAKING = `('merged', 'deploying', 'deployed', 'verified')`

export function retireOvertaken(now = new Date().toISOString()): Retired[] {
  const db = getDb()

  const candidates = db
    .prepare(
      `SELECT u.id, u.stack, u.service, u.to_tag,
              (SELECT p.number FROM pr_updates pu JOIN prs p ON p.id = pu.pr_id
                WHERE pu.update_id = u.id AND p.state = 'merged'
                ORDER BY p.merged_at DESC LIMIT 1) AS pr_number,
              (SELECT MAX(p.merged_at) FROM pr_updates pu JOIN prs p ON p.id = pu.pr_id
                WHERE pu.update_id = u.id AND p.state = 'merged') AS merged_at
       FROM updates u
       WHERE u.state = 'merged'
         AND NOT EXISTS (
           SELECT 1 FROM deploy_updates du JOIN deploys d ON d.id = du.deploy_id
           WHERE du.update_id = u.id AND d.status IN ('pending', 'running')
         )`,
    )
    .all() as {
    id: number
    stack: string
    service: string
    to_tag: string
    pr_number: number | null
    merged_at: string | null
  }[]

  const overtaker = db.prepare(
    `SELECT p.number FROM updates v
     JOIN pr_updates pu ON pu.update_id = v.id
     JOIN prs p ON p.id = pu.pr_id
     WHERE v.stack = ? AND v.service = ? AND v.id != ?
       AND v.state IN ${OVERTAKING}
       AND p.state = 'merged' AND p.merged_at > ?
     ORDER BY p.merged_at ASC LIMIT 1`,
  )
  const retire = db.prepare(
    `UPDATE updates SET state = 'superseded', detail = ?, updated_at = ? WHERE id = ? AND state = 'merged'`,
  )

  const out: Retired[] = []
  db.transaction(() => {
    for (const c of candidates) {
      // No merge time means no evidence of order, and order is the whole question.
      if (!c.merged_at) continue
      const by = overtaker.get(c.stack, c.service, c.id, c.merged_at) as { number: number } | undefined
      if (!by) continue
      if (retire.run(`overtaken by #${by.number}`, now, c.id).changes === 0) continue
      out.push({
        updateId: c.id,
        stack: c.stack,
        service: c.service,
        toTag: c.to_tag,
        prNumber: c.pr_number,
        byPrNumber: by.number,
      })
    }
  })()
  return out
}
