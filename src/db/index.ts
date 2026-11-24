import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { paths } from '../env.ts'
import { MIGRATIONS } from './legacy.ts'
import { BASELINE_SQL, BASELINE_THROUGH } from './schema.ts'

/**
 * Runtime state only. Policy is tracked YAML in the watched repository; per-service config is
 * `shipshape.*` labels in the compose files. Everything here except verdict/cost history
 * is reconstructible from the registries, git, and those two sources.
 */

export type Db = Database.Database

let db: Db | null = null

let closed = false

export function getDb(): Db {
  if (db) return db
  // After shutdown closed it, a straggling request must not open the file again.
  if (closed) throw new Error('the database is closed (shutting down)')
  mkdirSync(dirname(paths.db), { recursive: true })
  const fresh = !existsSync(paths.db)
  db = new Database(paths.db)
  // Only takes effect on an empty file, before the first table exists; an older database
  // is converted once by compactOnce (src/db/retention.ts).
  if (fresh) db.pragma('auto_vacuum = INCREMENTAL')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

/** Close the database for good: the last step of shutdown. */
export function closeDb(): void {
  closed = true
  if (db) {
    db.close()
    db = null
  }
}

/**
 * Bring a database up to date. A new one (no migration recorded, no table yet) is built
 * from the generated baseline and every chain entry it covers is recorded as applied; then
 * whatever the chain has that the database has not recorded runs, in order.
 */
function migrate(d: Db): void {
  d.exec(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`)
  const recorded = () =>
    new Set(
      d
        .prepare(`SELECT id FROM _migrations`)
        .all()
        .map((r) => (r as { id: string }).id),
    )
  if (recorded().size === 0) {
    const tables = d
      .prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT IN ('_migrations') AND name NOT LIKE 'sqlite_%'`,
      )
      .get() as { n: number }
    if (tables.n > 0) {
      throw new Error('the database has tables but no migration record; refusing to build a new schema over it')
    }
    d.transaction(() => {
      d.exec(BASELINE_SQL)
      const now = new Date().toISOString()
      const mark = d.prepare(`INSERT INTO _migrations (id, applied_at) VALUES (?, ?)`)
      for (const m of MIGRATIONS) {
        mark.run(m.id, now)
        if (m.id === BASELINE_THROUGH) break
      }
    })()
  }
  const applied = recorded()
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue
    d.transaction(() => {
      d.exec(m.sql)
      d.prepare(`INSERT INTO _migrations (id, applied_at) VALUES (?, ?)`).run(m.id, new Date().toISOString())
    })()
  }
}
