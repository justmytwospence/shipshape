/**
 * How the screen would have judged updates a reader has already judged: the calibration
 * the screen's thresholds are set from.
 *
 *   npm run jev-replay -- [--since 2026-07-01] [--limit 60]
 *
 * In the container: `node dist/bin/jev-replay.js ...`.
 *
 * For every successful reader verdict since the date, it reassembles the same notes, asks
 * Jev the same questions the screen asks, and compares. What it prints:
 *
 *   - a confusion matrix of reader recommendation against screen decision;
 *   - a sweep of the routine thresholds, re-deciding from the stored answers (no extra
 *     calls), so the loosest threshold with no miss can be read off;
 *   - every miss, with links: the screen called it routine and the reader found work --
 *     a block, or migration steps, or breaking changes.
 *
 * It writes nothing but ledger rows (purpose `replay`), so the spend is visible and
 * counted. It never touches verdicts or screens.
 */
import { getDb } from '../db.ts'
import { screenBump } from '../analyze/screen/run.ts'
import { decideScreen, flagsOf, THRESHOLDS, type Thresholds } from '../analyze/screen/decide.ts'
import type { Answer } from '../analyze/jev.ts'

const args = process.argv.slice(2)
const valueOf = (flag: string) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}
const since = valueOf('--since') ?? new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10)
const limit = Number(valueOf('--limit') ?? 60)

interface Row {
  image: string
  from_tag: string
  to_tag: string
  recommendation: string
  breaking_changes: string
  migration_steps: string
  stack: string
  service: string
  magnitude: string
  detected_at: string
  compose_file: string | null
}

const rows = getDb()
  .prepare(
    `SELECT v.image, v.from_tag, v.to_tag, v.recommendation, v.breaking_changes, v.migration_steps,
            u.stack, u.service, u.magnitude, u.detected_at, i.compose_file
       FROM verdicts v
       JOIN updates u ON u.id = (SELECT MIN(u2.id) FROM updates u2
                                  WHERE u2.image = v.image AND u2.from_tag = v.from_tag AND u2.to_tag = v.to_tag)
       LEFT JOIN images i ON i.stack = u.stack AND i.service = u.service
      WHERE v.error IS NULL AND v.recommendation IS NOT NULL
        AND COALESCE(v.source, 'reader') = 'reader'
        AND v.created_at >= ?
      ORDER BY v.created_at DESC
      LIMIT ?`,
  )
  .all(since, limit) as Row[]

const list = (s: string): string[] => {
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** The reader found work: what a routine screen must never have missed. */
const readerFoundWork = (r: Row) =>
  r.recommendation === 'block' || list(r.migration_steps).length > 0 || list(r.breaking_changes).length > 0

interface Judged {
  row: Row
  answers: Record<string, Answer> | null
  lineCount: number
  evidence: Parameters<typeof decideScreen>[0]
  decision: string
  reason: string
}

const judged: Judged[] = []
let failures = 0
let cost = 0

console.log(`replaying ${rows.length} reader verdict(s) since ${since}\n`)
for (const r of rows) {
  const res = await screenBump(
    {
      image: r.image,
      from_tag: r.from_tag,
      to_tag: r.to_tag,
      magnitude: r.magnitude,
      stack: r.stack,
      service: r.service,
      detected_at: r.detected_at,
      carriers: [{ stack: r.stack, service: r.service, composeFile: r.compose_file ?? `${r.stack}/docker-compose.yaml` }],
    },
    { purpose: 'replay' },
  )
  if (!res.ok) {
    failures++
    console.log(`  ! ${r.stack}/${r.service} ${r.from_tag} -> ${r.to_tag}: ${res.error}`)
    continue
  }
  cost += res.cost
  const ev = res.evidence
  judged.push({
    row: r,
    answers: res.answers as Record<string, Answer> | null,
    lineCount: res.lines.length,
    evidence: {
      magnitude: r.magnitude,
      notesInRange: ev.notesShown,
      incomplete: ev.incomplete,
      approximate: ev.approximate,
      missing: ev.missing.length,
      omitted: ev.omitted.length,
      sourceCertain: ev.confidence === 'high' || ev.tier === 'label',
    },
    decision: res.result.decision,
    reason: res.result.reason,
  })
  process.stdout.write('.')
}
console.log('\n')

// ---------------------------------------------------------------- confusion matrix
const decisions = ['routine', 'finding', 'escalate', 'no-notes']
const recs = ['approve', 'caution', 'block']
console.log('reader \\ screen'.padEnd(18) + decisions.map((d) => d.padStart(10)).join(''))
for (const rec of recs) {
  const cells = decisions.map((d) => judged.filter((j) => j.row.recommendation === rec && j.decision === d).length)
  console.log(rec.padEnd(18) + cells.map((c) => String(c).padStart(10)).join(''))
}

// --------------------------------------------------------------------- sweep
console.log('\nthreshold sweep (routine needs every risk question below R and affects below A):')
console.log('   R     A   routine   misses   routine share of PR-eligible')
for (const R of [0.1, 0.2, 0.3, 0.4]) {
  for (const A of [0.3, 0.5]) {
    const t: Thresholds = { ...THRESHOLDS, routineRisk: R, routineAffects: A }
    const decided = judged.map((j) => ({ j, d: decideScreen(j.evidence, j.answers, j.lineCount, t).decision }))
    const routine = decided.filter((x) => x.d === 'routine')
    const misses = routine.filter((x) => readerFoundWork(x.j.row))
    const eligible = decided.filter((x) => x.j.row.magnitude === 'patch' || x.j.row.magnitude === 'minor').length
    console.log(
      `${R.toFixed(1).padStart(4)}  ${A.toFixed(1).padStart(4)}  ${String(routine.length).padStart(8)}  ${String(misses.length).padStart(7)}   ${eligible ? Math.round((100 * routine.length) / eligible) : 0}%`,
    )
  }
}

// ---------------------------------------------------------------------- misses
const misses = judged.filter((j) => j.decision === 'routine' && readerFoundWork(j.row))
console.log(`\nmisses at the committed thresholds: ${misses.length}`)
for (const m of misses) {
  const f = m.answers ? flagsOf(m.answers) : null
  console.log(
    `  ${m.row.stack}/${m.row.service} ${m.row.from_tag} -> ${m.row.to_tag}: reader ${m.row.recommendation}; ` +
      `steps ${list(m.row.migration_steps).length}, breaking ${list(m.row.breaking_changes).length}` +
      (f ? `; max risk ${Math.max(...Object.values(f.risk)).toFixed(2)}, affects ${f.affects.toFixed(2)}, score ${f.score.toFixed(2)}` : ''),
  )
}

// The disagreements a person should read before thresholds move.
const disagree = judged.filter((j) => j.decision === 'routine' && j.row.recommendation !== 'approve')
console.log(`\nroutine where the reader said read first: ${disagree.length}`)
for (const d of disagree) console.log(`  ${d.row.stack}/${d.row.service} ${d.row.from_tag} -> ${d.row.to_tag}`)

console.log(`\n${judged.length} screened, ${failures} failed, $${cost.toFixed(4)} spent`)
