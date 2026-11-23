import { existsSync } from 'node:fs'
import { paths } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import type { UpdateGroup } from '../groups.ts'
import { git, withGitLock } from './repo.ts'

/**
 * Drafted config changes: a local branch the drafter wrote that waits for a person.
 *
 * A drafted change holds its update (the `draft` hold, src/updates/holds.ts) until someone
 * presses Ship after it was drafted. When the reader later reads the update again and no
 * longer lists any work, the draft is closed rather than merged: it was written for work
 * that is no longer asked for. Kept apart from ship.ts, which imports this module.
 */

/** A drafted config change left an open local branch for these updates, if one did. */
export function draftFor(group: UpdateGroup): { id: number; branch: string } | null {
  const ids = group.members.map((m) => m.id)
  const row = getDb()
    .prepare(
      `SELECT p.id, p.branch FROM prs p JOIN pr_updates pu ON pu.pr_id = p.id
        WHERE p.state = 'open' AND p.scope = 'proposed' AND pu.update_id IN (${ids.map(() => '?').join(',')})
        ORDER BY p.id DESC LIMIT 1`,
    )
    .get(...ids) as { id: number; branch: string } | undefined
  return row ?? null
}

/** Close a local change record that will never merge, deleting its branch in the work clone. */
export function closeLocalChange(prId: number, why: string): void {
  const db = getDb()
  const now = new Date().toISOString()
  db.transaction(() => {
    db.prepare(`UPDATE prs SET state = 'closed' WHERE id = ?`).run(prId)
    db.prepare(`DELETE FROM proposals WHERE pr_id = ?`).run(prId)
  })()
  logEvent({ level: 'info', kind: 'ship', message: 'a drafted change was closed', detail: `${why} (${now.slice(0, 10)})` })
}

const parseList = (raw: string | null): unknown[] => {
  try {
    const v = JSON.parse(raw ?? '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/**
 * Close every open drafted change whose reason is gone: the reader has read the update again
 * since the draft was written and now lists neither steps nor breaking changes. Closed rather
 * than merged -- the draft was written for work that is no longer asked for.
 * Returns how many were closed.
 */
export async function closeStaleDrafts(): Promise<number> {
  const db = getDb()
  const drafts = db
    .prepare(`SELECT id, branch FROM prs WHERE state = 'open' AND scope = 'proposed'`)
    .all() as { id: number; branch: string }[]
  const stale: { id: number; branch: string; why: string }[] = []
  for (const d of drafts) {
    const proposal = db
      .prepare(
        `SELECT update_id, created_at FROM proposals WHERE pr_id = ? AND error IS NULL AND retryable = 0
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(d.id) as { update_id: number; created_at: string } | undefined
    if (!proposal) continue
    const u = db
      .prepare(`SELECT stack, service, image, from_tag, to_tag FROM updates WHERE id = ?`)
      .get(proposal.update_id) as { stack: string; service: string; image: string; from_tag: string; to_tag: string } | undefined
    if (!u) continue
    const v = db
      .prepare(
        `SELECT source, error, created_at, migration_steps, breaking_changes FROM verdicts
          WHERE image = ? AND from_tag = ? AND to_tag = ?`,
      )
      .get(u.image, u.from_tag, u.to_tag) as
      | { source: string | null; error: string | null; created_at: string; migration_steps: string | null; breaking_changes: string | null }
      | undefined
    if (!v) continue
    if (
      v.source === 'reader' &&
      v.error === null &&
      v.created_at > proposal.created_at &&
      parseList(v.migration_steps).length === 0 &&
      parseList(v.breaking_changes).length === 0
    ) {
      stale.push({ ...d, why: `the review of ${u.stack}/${u.service} was read again and no longer lists work` })
    }
  }
  if (stale.length === 0) return 0
  await withGitLock('close-stale-drafts', async () => {
    if (existsSync(paths.workRepo)) {
      for (const s of stale) {
        await git(paths.workRepo, ['checkout', '-q', '--detach'], { allowFail: true })
        await git(paths.workRepo, ['branch', '-D', s.branch], { allowFail: true })
      }
    }
    for (const s of stale) closeLocalChange(s.id, s.why)
  })
  return stale.length
}
