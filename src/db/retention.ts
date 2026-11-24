import { existsSync, statSync } from 'node:fs'
import { paths } from '../config.ts'
import { getDb } from '../db.ts'
import { logEvent } from '../events.ts'

/**
 * What nothing reads any more, removed after every scan.
 *
 * The database only grew: cached registry pages that could never be revalidated, tags of
 * images no service runs, years of info-level Activity. Sign-in sessions are pruned by
 * their own code (src/web/auth/session.ts), which also knows the password fingerprint.
 */
export interface PruneResult {
  cache: number
  tags: number
  events: number
  restorePoints: number
}

const DAY = 864e5

export function prune(now = Date.now()): PruneResult {
  const db = getDb()
  const d30 = new Date(now - 30 * DAY).toISOString()
  const d90 = new Date(now - 90 * DAY).toISOString()
  const result = db.transaction((): PruneResult => {
    // Not confirmed for 30 days (a 304 touches the row), and registry pages with no ETag,
    // which can never be revalidated and so are never read. Fetched links keep their own
    // refetch clock.
    const cache = db
      .prepare(
        `DELETE FROM http_cache
          WHERE (fetched_at < ? AND url NOT LIKE 'external:%')
             OR (etag IS NULL AND url LIKE 'https://%')`,
      )
      .run(d30).changes
    const tags = db
      .prepare(
        `DELETE FROM tags_seen WHERE NOT EXISTS (
           SELECT 1 FROM images i
            WHERE i.registry = tags_seen.registry AND i.repository = tags_seen.repository)`,
      )
      .run().changes
    const events = db
      .prepare(`DELETE FROM events WHERE level = 'info' AND COALESCE(last_at, at) < ?`)
      .run(d90).changes
    let restorePoints = 0
    const gone = db.prepare(`DELETE FROM restore_points WHERE id = ?`)
    const rows = db
      .prepare(`SELECT id, path FROM restore_points WHERE path NOT LIKE 'offsite:%'`)
      .all() as { id: number; path: string }[]
    for (const r of rows) {
      if (!existsSync(r.path)) restorePoints += gone.run(r.id).changes
    }
    return { cache, tags, events, restorePoints }
  })()
  db.pragma('incremental_vacuum')
  if (result.cache + result.tags + result.events + result.restorePoints > 0) {
    logEvent({
      level: 'info',
      kind: 'system',
      message: 'database pruned',
      detail: `${result.cache} cached responses, ${result.tags} remembered tags, ${result.events} old events, ${result.restorePoints} missing restore points`,
    })
  }
  return result
}

/**
 * A database made before incremental auto-vacuum never gives space back. Convert it once:
 * prune, switch the mode, VACUUM. A new database starts in the mode (getDb), so this is a
 * no-op everywhere but the first start after upgrading.
 */
export function compactOnce(): { compacted: boolean; beforeBytes: number; afterBytes: number } {
  const db = getDb()
  const size = () => (existsSync(paths.db) ? statSync(paths.db).size : 0)
  const beforeBytes = size()
  if (db.pragma('auto_vacuum', { simple: true }) === 2) {
    return { compacted: false, beforeBytes, afterBytes: beforeBytes }
  }
  logEvent({
    level: 'info',
    kind: 'system',
    message: 'compacting the database once; this can take a minute on a large file',
  })
  prune()
  db.pragma('auto_vacuum = INCREMENTAL')
  db.exec('VACUUM')
  db.pragma('wal_checkpoint(TRUNCATE)')
  const afterBytes = size()
  const mb = (b: number) => (b / 1e6).toFixed(1)
  logEvent({
    level: 'info',
    kind: 'system',
    message: 'database compacted',
    detail: `${mb(beforeBytes)} MB -> ${mb(afterBytes)} MB`,
  })
  return { compacted: true, beforeBytes, afterBytes }
}
