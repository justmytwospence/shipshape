import { getDb } from '../db/index.ts'
import { logEvent } from '../events.ts'

export function summarise(counts: Record<string, number>, durationS: number): string {
  const parts: string[] = []
  const say = (k: string, label: string) => {
    if (counts[k]) parts.push(`${counts[k]} ${label}`)
  }
  say('update', 'update(s)')
  say('bootstrapped', 'digest baseline(s) initialised')
  say('moved-rolling', 'rolling image(s) moved')
  say('moved-pinned', 'pinned digest(s) moved')
  say('retiered', 'policy change(s)')
  say('needs-attention', 'needing attention')
  say('error', 'error(s)')
  if (parts.length === 0) parts.push('no changes')
  return `${parts.join(', ')} in ${durationS}s`
}

export function recordComposeFiles(n: number): void {
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO budgets (key, value, window, updated_at) VALUES ('scan.compose_files', ?, NULL, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(n, now)
}

export function recordTelemetry(counts: Record<string, number>, durationS: number): void {
  const db = getDb()
  const now = new Date().toISOString()
  const put = db.prepare(
    `INSERT INTO budgets (key, value, window, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, window = excluded.window,
                                    updated_at = excluded.updated_at`,
  )
  put.run('scan.last_duration_s', durationS, null, now)
  put.run(
    'scan.last_counts',
    Object.values(counts).reduce((a, b) => a + b, 0),
    JSON.stringify(counts),
    now,
  )
  put.run('scan.last_at', Date.parse(now), now, now)
}

/**
 * Say so, once per scan, when a service carries a `shipshape.*` key nothing reads.
 *
 * A typo in a label used to be indistinguishable from a label that worked: `shipshape.polcy:
 * manual` parsed, stored and changed nothing, and the service carried on merging on the
 * defaults. One line per service in the activity log is the whole fix, and the log folds
 * repeats into a count, so a label left in place is one row rather than one a night.
 */
export function reportUnknownLabels(
  services: {
    stack: string
    service: string
    unknownLabels: string[]
    legacyLabels: string[]
    labelProblems: string[]
  }[],
): void {
  for (const s of services) {
    const n = s.legacyLabels.length
    if (n > 0) {
      logEvent({
        level: 'warn',
        kind: 'scan',
        stack: s.stack,
        service: s.service,
        message: `${s.stack}/${s.service} carries ${n === 1 ? 'a v1 label' : 'v1 labels'} shipshape no longer reads`,
        detail: `${s.legacyLabels.join(', ')}: held to class ask (or narrower) until rewritten. Run npm run convert-v1 -- --write (in the container: node dist/bin/convert-v1.js --write).`,
      })
    }
    if (s.unknownLabels.length > 0) {
      logEvent({
        level: 'warn',
        kind: 'scan',
        stack: s.stack,
        service: s.service,
        message: `${s.stack}/${s.service} carries ${s.unknownLabels.length === 1 ? 'a label' : 'labels'} shipshape does not read`,
        detail: s.unknownLabels.map((k) => `shipshape.${k}`).join(', '),
      })
    }
    // A label that was read and could not be used is the same kind of news: the
    // operator wrote something, and it is silently doing less than they meant.
    if (s.labelProblems.length > 0) {
      logEvent({
        level: 'warn',
        kind: 'scan',
        stack: s.stack,
        service: s.service,
        message: `${s.stack}/${s.service} carries ${s.labelProblems.length === 1 ? 'a label' : 'labels'} shipshape could not use`,
        detail: s.labelProblems.join('; '),
      })
    }
  }
}
