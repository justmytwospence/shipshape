import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import Database from 'better-sqlite3'

/**
 * A new database is built from one generated baseline, an existing one by the chain. The
 * two must be the same database, and the committed baseline must be what the chain makes.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-db-baseline-'))
process.env.DATA_DIR = dir
delete process.env.REPO_DIR

const { MIGRATIONS } = await import('../src/db/legacy.ts')
const { BASELINE_SQL, BASELINE_THROUGH } = await import('../src/db/schema.ts')
const { chainDb, generateBaseline, renderSchemaModule } = await import('../src/db/baseline.ts')
const { getDb } = await import('../src/db/index.ts')

after(() => rmSync(dir, { recursive: true, force: true }))

type Db = InstanceType<typeof Database>

/** Every table's shape, keys, indexes, rows and stored SQL, ordered by name; _migrations aside. */
function describe(d: Db) {
  const tables = (
    d
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations' ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((t) => t.name)
  return tables.map((t) => ({
    table: t,
    columns: d.prepare(`PRAGMA table_xinfo("${t}")`).all(),
    foreignKeys: d.prepare(`PRAGMA foreign_key_list("${t}")`).all(),
    indexes: (d.prepare(`PRAGMA index_list("${t}")`).all() as { name: string }[]).map((i) => ({
      ...i,
      columns: d.prepare(`PRAGMA index_xinfo("${i.name}")`).all(),
    })),
    rows: d.prepare(`SELECT * FROM "${t}"`).all(),
    sql: (
      d.prepare(`SELECT sql FROM sqlite_master WHERE tbl_name = ? ORDER BY name`).all(t) as { sql: string | null }[]
    ).map((r) => r.sql),
  }))
}

test('the committed baseline is what the chain generates', () => {
  const committed = readFileSync(new URL('../src/db/schema.ts', import.meta.url), 'utf8')
  assert.equal(
    renderSchemaModule(generateBaseline(MIGRATIONS, BASELINE_THROUGH), BASELINE_THROUGH),
    committed,
    'src/db/schema.ts is stale: run npm run db:baseline',
  )
  assert.doesNotMatch(BASELINE_SQL, /INSERT INTO/, 'a seeded row must be deterministic: review it before allowing one')
})

test('a database built from the baseline is the database the chain builds', () => {
  const fromBaseline = new Database(':memory:')
  fromBaseline.pragma('foreign_keys = ON')
  fromBaseline.exec(BASELINE_SQL)
  assert.deepEqual(describe(fromBaseline), describe(chainDb(MIGRATIONS, BASELINE_THROUGH)))
})

test('a new database is the baseline plus whatever came after it, and records every id', () => {
  const d = getDb()
  const ids = (d.prepare(`SELECT id FROM _migrations`).all() as { id: string }[]).map((r) => r.id)
  assert.deepEqual(new Set(ids), new Set(MIGRATIONS.map((m) => m.id)))
  assert.deepEqual(describe(d), describe(chainDb(MIGRATIONS, MIGRATIONS.at(-1)!.id)))
})

test('a database with tables but no record is refused', () => {
  const other = join(dir, 'other')
  mkdirSync(other)
  const file = new Database(join(other, 'shipshape.db'))
  file.exec(`CREATE TABLE x (a)`)
  file.close()
  // Its own process: this one already holds a database open, and paths are read once.
  const run = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', "const { getDb } = await import('./src/db/index.ts'); getDb()"],
    { cwd: join(import.meta.dirname, '..'), env: { ...process.env, DATA_DIR: other }, encoding: 'utf8' },
  )
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /the database has tables but no migration record; refusing to build a new schema over it/)
})
