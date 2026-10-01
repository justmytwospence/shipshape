import { env, loadPolicy } from '../../config.ts'
import { getDb, logEvent } from '../../db.ts'
import { parseImageRef } from '../../images/ref.ts'
import { assembleNotes, notesInRange } from '../../notes/assemble.ts'
import { sourceFor } from '../../resolver/index.ts'
import { backoffUntil } from '../../backoff.ts'
import { askJev, jevConfigured } from '../jev.ts'
import { buildState, contextHash, deploymentOf, type DeploymentEntry, type ScreenLine } from './state.ts'
import { decideScreen, questionsFor, type ScreenDecision, type ScreenResult } from './decide.ts'

/**
 * The screen pass: every update that wants a look gets one from Jev, cheaply, before
 * anything decides whether it is worth a reader.
 *
 * Under `review.screen: shadow` that is all it does -- the answers are stored and shown on
 * the update, and nothing acts on them, which is how its track record is built before it
 * matters. Under `on`, a routine answer writes an approval and a finding writes a
 * provisional caution, and the reader is paid only for what is not routine (see
 * readerWanted in analyze/run.ts). Either way a screen can only hold an update back.
 */

/** How many bumps a tick screens. Each is one Decisions call and a few cached GitHub reads. */
const PER_TICK = 10
/** A hard ceiling on screen spend in a month, separate from the shared budget it also counts against. */
export const SCREEN_MONTHLY_CEILING_USD = 1
/** Incomplete notes are screened again after this long, this many times, as with the reader. */
const INCOMPLETE_WAIT_MS = 60 * 60_000
const INCOMPLETE_RESCREENS = 3
/** A screen that failed is tried again on a backoff, and given up on after this many. */
const MAX_ERROR_ATTEMPTS = 6
/** The same window the reader's backfill uses. */
const BACKFILL_DAYS = 30

export interface PendingScreen {
  update_id: number
  image: string
  from_tag: string
  to_tag: string
  magnitude: string
  stack: string
  service: string
  has_pr: number
  detected_at: string
  carriers: { stack: string; service: string; composeFile: string }[]
}

interface ScreenRow {
  context_hash: string | null
  decision: string | null
  error: string | null
  attempts: number
  next_attempt_at: string | null
  evidence: string | null
  created_at: string
}

/** Spend on screens this month, from the ledger. */
export function screenSpendThisMonth(): number {
  const month = new Date().toISOString().slice(0, 7)
  const row = getDb()
    .prepare(`SELECT SUM(cost_usd) AS c FROM llm_calls WHERE purpose = 'screen' AND created_at LIKE ?`)
    .get(`${month}%`) as { c: number | null }
  return row.c ?? 0
}

/**
 * Which bumps want a screen: never screened, screened against a configuration that has
 * since changed, read from incomplete notes an hour or more ago, or failed and due again.
 *
 * Wider than what the reader takes: patches that applied on their own are included,
 * because a screen costs a twentieth of a cent and gives the releases feed something to
 * say about them. Digests and rolling tags are not -- there are no notes to read.
 */
export function pendingScreens(limit: number, repoDir = env.repoDir, now = Date.now()): PendingScreen[] {
  const since = new Date(now - BACKFILL_DAYS * 86_400_000).toISOString()
  const rows = getDb()
    .prepare(
      `SELECT u.id AS update_id, u.image, u.from_tag, u.to_tag, u.magnitude, u.stack, u.service,
              u.detected_at, i.compose_file AS compose_file,
              CASE WHEN EXISTS (
                SELECT 1 FROM pr_updates pu JOIN prs p ON p.id = pu.pr_id
                WHERE pu.update_id = u.id AND p.state = 'open'
              ) THEN 1 ELSE 0 END AS has_pr
         FROM updates u
         LEFT JOIN images i ON i.stack = u.stack AND i.service = u.service
        WHERE u.magnitude IN ('patch', 'minor', 'major')
          AND u.detail IS NOT 'rolling'
          AND (
            EXISTS (SELECT 1 FROM pr_updates pu JOIN prs p ON p.id = pu.pr_id
                    WHERE pu.update_id = u.id AND p.state = 'open')
            OR (u.detected_at >= ? AND (
                  u.state IS NOT 'superseded'
                  OR u.detail = 'caught-up'
                  OR EXISTS (SELECT 1 FROM pr_updates pu JOIN prs p ON p.id = pu.pr_id
                             WHERE pu.update_id = u.id AND p.state = 'merged')))
          )
        ORDER BY has_pr DESC, u.detected_at DESC`,
    )
    .all(since) as (Omit<PendingScreen, 'carriers'> & { compose_file: string | null })[]

  const byKey = new Map<string, PendingScreen>()
  for (const r of rows) {
    const key = `${r.image}\u0000${r.from_tag}\u0000${r.to_tag}`
    const seen = byKey.get(key)
    const carrier = { stack: r.stack, service: r.service, composeFile: r.compose_file ?? `${r.stack}/docker-compose.yaml` }
    if (seen) {
      if (!seen.carriers.some((c) => c.stack === r.stack && c.service === r.service)) seen.carriers.push(carrier)
      continue
    }
    const { compose_file: _cf, ...rest } = r
    byKey.set(key, { ...rest, carriers: [carrier] })
  }

  const existing = getDb().prepare(
    `SELECT context_hash, decision, error, attempts, next_attempt_at, evidence, created_at
       FROM screens WHERE image = ? AND from_tag = ? AND to_tag = ?`,
  )
  const out: PendingScreen[] = []
  for (const p of byKey.values()) {
    const s = existing.get(p.image, p.from_tag, p.to_tag) as ScreenRow | undefined
    if (wantsScreen(s, p, repoDir, now)) out.push(p)
    if (out.length >= limit) break
  }
  return out
}

function wantsScreen(s: ScreenRow | undefined, p: PendingScreen, repoDir: string, now: number): boolean {
  if (!s) return true
  if (s.error) {
    return s.attempts < MAX_ERROR_ATTEMPTS && !!s.next_attempt_at && Date.parse(s.next_attempt_at) <= now
  }
  let ev: { incomplete?: boolean; attempt?: number } = {}
  try {
    ev = s.evidence ? JSON.parse(s.evidence) : {}
  } catch {
    ev = {}
  }
  if (ev.incomplete && (ev.attempt ?? 1) <= INCOMPLETE_RESCREENS && now - Date.parse(s.created_at) >= INCOMPLETE_WAIT_MS) {
    return true
  }
  // A configuration change is only worth paying for where a decision is waiting on it.
  if (p.has_pr && s.context_hash !== null) {
    return s.context_hash !== deploymentHash(p, repoDir).hash
  }
  return false
}

function deploymentHash(p: PendingScreen, repoDir: string): { deployment: DeploymentEntry[]; hash: string } {
  const deployment = p.carriers
    .map((c) => deploymentOf(repoDir, c.composeFile, c.service))
    .filter((d): d is DeploymentEntry => d !== null)
  return { deployment, hash: contextHash(deployment) }
}

export interface ScreenRun {
  screened: number
  failed: number
  skipped?: 'off' | 'unconfigured' | 'ceiling'
  /** Bumps whose verdict the screen wrote this pass, for the caller to splice into pull requests. */
  applied: { image: string; from_tag: string; to_tag: string }[]
}

/** Screen up to PER_TICK bumps. Never throws: a failure is recorded on its row. */
export async function runScreenPass(limit = PER_TICK): Promise<ScreenRun> {
  const out: ScreenRun = { screened: 0, failed: 0, applied: [] }
  const { policy } = loadPolicy()
  if (policy.review.screen === 'off') return { ...out, skipped: 'off' }
  if (!jevConfigured()) return { ...out, skipped: 'unconfigured' }
  if (screenSpendThisMonth() >= SCREEN_MONTHLY_CEILING_USD) return { ...out, skipped: 'ceiling' }

  for (const p of pendingScreens(limit)) {
    try {
      const r = await screenOne(p)
      if (r.ok) out.screened++
      else out.failed++
      if (r.applied) out.applied.push({ image: p.image, from_tag: p.from_tag, to_tag: p.to_tag })
    } catch (err) {
      recordScreenError(p, (err as Error).message)
      out.failed++
    }
  }
  return out
}

export interface ScreenOutcome {
  ok: boolean
  result?: ScreenResult
  lines?: ScreenLine[]
  model?: string
}

/** Assemble, ask, decide, store. Exported for the replay, which calls it without storing. */
export async function screenBump(
  p: Pick<PendingScreen, 'image' | 'from_tag' | 'to_tag' | 'magnitude' | 'stack' | 'service' | 'detected_at' | 'carriers'>,
  o: { purpose: 'screen' | 'replay'; repoDir?: string },
): Promise<
  | {
      ok: true
      result: ScreenResult
      lines: ScreenLine[]
      model: string | null
      contextHash: string
      evidence: ScreenStoredEvidence
      cost: number
      answers: Record<string, unknown> | null
    }
  | { ok: false; error: string; retryable: boolean }
> {
  const repoDir = o.repoDir ?? env.repoDir
  const ref = parseImageRef(p.image)
  const source = await sourceFor(
    { registry: ref.registry, repository: ref.repository },
    { service: { stack: p.stack, service: p.service }, tag: ref.tag ?? p.from_tag },
  )
  const bundle = await assembleNotes({
    image: p.image,
    fromTag: p.from_tag,
    toTag: p.to_tag,
    source,
    observedAt: p.detected_at,
  })
  const deployment = p.carriers
    .map((c) => deploymentOf(repoDir, c.composeFile, c.service))
    .filter((d): d is DeploymentEntry => d !== null)
  const built = buildState(bundle, { image: p.image, from: p.from_tag, to: p.to_tag, magnitude: p.magnitude }, deployment)
  const evidence: ScreenStoredEvidence = {
    repo: bundle.source.repo,
    tier: bundle.source.tier,
    confidence: bundle.source.confidence,
    notesInRange: notesInRange(bundle),
    notesShown: built.notes.length,
    lines: built.lines.length,
    missing: built.missing,
    omitted: built.omitted,
    incomplete: bundle.incomplete,
    approximate: bundle.range.approximate,
    sources: [...new Set(built.notes.map((n) => n.url).filter((u): u is string => !!u))],
  }
  const screenEvidence = {
    magnitude: p.magnitude,
    notesInRange: built.notes.length,
    incomplete: bundle.incomplete,
    approximate: bundle.range.approximate,
    missing: built.missing.length,
    omitted: built.omitted.length,
    sourceCertain: bundle.source.confidence === 'high' || bundle.source.tier === 'label',
  }

  // Nothing to judge: no call is made, and the reader -- which can search -- takes it.
  if (built.notes.length === 0) {
    return {
      ok: true,
      result: decideScreen(screenEvidence, null, 0),
      lines: [],
      model: null,
      contextHash: built.contextHash,
      evidence,
      cost: 0,
      answers: null,
    }
  }

  const answer = await askJev(built.state, questionsFor(built.lines.length), {
    purpose: o.purpose,
    meta: { image: p.image, fromTag: p.from_tag, toTag: p.to_tag },
  })
  if (!answer.ok) return { ok: false, error: answer.error, retryable: answer.retryable }
  return {
    ok: true,
    result: decideScreen(screenEvidence, answer.answers, built.lines.length),
    lines: built.lines,
    model: answer.model,
    contextHash: built.contextHash,
    evidence,
    cost: answer.cost,
    answers: answer.answers,
  }
}

export interface ScreenStoredEvidence {
  repo: string | null
  tier: string
  confidence: string | null
  notesInRange: number
  notesShown: number
  lines: number
  missing: string[]
  omitted: string[]
  incomplete: boolean
  approximate: boolean
  sources: string[]
}

async function screenOne(p: PendingScreen): Promise<{ ok: boolean; applied?: boolean }> {
  const r = await screenBump(p, { purpose: 'screen' })
  if (!r.ok) {
    recordScreenError(p, r.error)
    return { ok: false }
  }
  const db = getDb()
  const prior = db
    .prepare(`SELECT evidence FROM screens WHERE image = ? AND from_tag = ? AND to_tag = ?`)
    .get(p.image, p.from_tag, p.to_tag) as { evidence: string | null } | undefined
  let priorAttempt = 0
  try {
    const e = prior?.evidence ? (JSON.parse(prior.evidence) as { incomplete?: boolean; attempt?: number }) : null
    if (e?.incomplete) priorAttempt = e.attempt ?? 1
  } catch {
    priorAttempt = 0
  }
  const evidence = { ...r.evidence, attempt: r.evidence.incomplete ? priorAttempt + 1 : 0 }
  const answers = r.answers
  db.prepare(
    `INSERT INTO screens (image, from_tag, to_tag, context_hash, model, decision, reason, answers, lines,
                          actionable, notable, evidence, cost_usd, error, attempts, next_attempt_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?)
     ON CONFLICT(image, from_tag, to_tag) DO UPDATE SET
       context_hash = excluded.context_hash, model = excluded.model, decision = excluded.decision,
       reason = excluded.reason, answers = excluded.answers, lines = excluded.lines,
       actionable = excluded.actionable, notable = excluded.notable, evidence = excluded.evidence,
       cost_usd = excluded.cost_usd, error = NULL, attempts = 0, next_attempt_at = NULL,
       created_at = excluded.created_at`,
  ).run(
    p.image,
    p.from_tag,
    p.to_tag,
    r.contextHash,
    r.model,
    r.result.decision,
    r.result.reason,
    answers ? JSON.stringify(answers) : null,
    JSON.stringify(r.lines),
    JSON.stringify(r.result.actionable),
    JSON.stringify(r.result.notable),
    JSON.stringify(evidence),
    r.cost,
    new Date().toISOString(),
  )

  const { policy } = loadPolicy()
  if (policy.review.screen === 'on') {
    return { ok: true, applied: applyScreen(p, r.result, r.lines, r.model, evidence.sources) }
  }
  if (r.result.decision !== 'routine') {
    // Shadow: worth a line in the log only when it would have held something.
    logEvent({
      level: 'info',
      kind: 'analysis',
      stack: p.stack,
      service: p.service,
      message: `screen (shadow): ${p.stack}/${p.service} ${p.from_tag} -> ${p.to_tag} would be ${r.result.decision}`,
      detail: r.result.reason,
    })
  }
  return { ok: true }
}

/**
 * Under `on`, what the screen's answer means for the verdict the gate reads.
 *
 * Never over a reader's verdict: the reader read the changelog, and the screen's job is
 * deciding whether that is worth paying for, not second-guessing it.
 *
 * - routine: an approval, at the confidence the Score earned. The reader may still come
 *   by (a sampled audit, a major, a button) and replace it.
 * - finding: a provisional caution, which holds the merge until a reader has looked and
 *   stands if none can. Without it, a finding during an outage would be an unread merge.
 * - escalate / no-notes: nothing. No row means the gate waits for the reader.
 */
export function applyScreen(
  p: Pick<PendingScreen, 'image' | 'from_tag' | 'to_tag'>,
  result: ScreenResult,
  lines: ScreenLine[],
  model: string | null,
  sources: string[],
): boolean {
  if (result.decision !== 'routine' && result.decision !== 'finding') return false
  const db = getDb()
  const existing = db
    .prepare(`SELECT source, error FROM verdicts WHERE image = ? AND from_tag = ? AND to_tag = ?`)
    .get(p.image, p.from_tag, p.to_tag) as { source: string | null; error: string | null } | undefined
  if (existing && (existing.source ?? 'reader') === 'reader' && !existing.error) return false

  const routine = result.decision === 'routine'
  const actionable = result.actionable.map((i) => lines[i]?.text).filter((t): t is string => !!t)
  db.prepare(
    `INSERT INTO verdicts (image, from_tag, to_tag, summary, severity, breaking_changes, migration_steps,
                           new_features, recommendation, confidence, sources, model, error, created_at,
                           source, provisional)
     VALUES (?, ?, ?, ?, ?, '[]', '[]', '[]', ?, ?, ?, ?, NULL, ?, 'screen', ?)
     ON CONFLICT(image, from_tag, to_tag) DO UPDATE SET
       summary = excluded.summary, severity = excluded.severity, breaking_changes = '[]',
       migration_steps = '[]', new_features = '[]', recommendation = excluded.recommendation,
       confidence = excluded.confidence, sources = excluded.sources, model = excluded.model,
       error = NULL, next_attempt_at = NULL, created_at = excluded.created_at,
       source = 'screen', provisional = excluded.provisional`,
  ).run(
    p.image,
    p.from_tag,
    p.to_tag,
    routine
      ? 'Screened: no required changes identified in the fetched release notes.'
      : `Screened: ${result.reason}.${actionable.length ? ` Flagged: ${actionable.slice(0, 3).join(' / ')}` : ''} A full reading is queued.`,
    routine ? 'none' : 'medium',
    routine ? 'approve' : 'caution',
    routine ? (result.confidence ?? 'medium') : 'medium',
    JSON.stringify(sources),
    model,
    new Date().toISOString(),
    routine ? 0 : 1,
  )
  return true
}

function recordScreenError(p: Pick<PendingScreen, 'image' | 'from_tag' | 'to_tag' | 'stack' | 'service'>, error: string): void {
  const db = getDb()
  const prior = db
    .prepare(`SELECT attempts, error, decision FROM screens WHERE image = ? AND from_tag = ? AND to_tag = ?`)
    .get(p.image, p.from_tag, p.to_tag) as { attempts: number; error: string | null; decision: string | null } | undefined
  // A re-screen that failed leaves the last good screen in place.
  if (prior && !prior.error && prior.decision) return
  const attempts = (prior?.attempts ?? 0) + 1
  db.prepare(
    `INSERT INTO screens (image, from_tag, to_tag, error, attempts, next_attempt_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(image, from_tag, to_tag) DO UPDATE SET
       error = excluded.error, attempts = excluded.attempts, next_attempt_at = excluded.next_attempt_at,
       created_at = excluded.created_at`,
  ).run(
    p.image,
    p.from_tag,
    p.to_tag,
    error.slice(0, 400),
    attempts,
    backoffUntil(attempts, { baseMs: 15 * 60_000, capMs: 24 * 60 * 60_000 }),
    new Date().toISOString(),
  )
  // One line per distinct failure; the log folds repeats into a count.
  logEvent({ level: 'warn', kind: 'analysis', message: 'the screen could not look at an update', detail: error.slice(0, 200) })
}

/** What the screen concluded about one bump, for the gate, the reader and the page. */
export function screenFor(image: string, fromTag: string, toTag: string): {
  decision: ScreenDecision | null
  reason: string | null
  error: string | null
  model: string | null
  lines: ScreenLine[]
  actionable: number[]
  notable: number[]
  answers: Record<string, unknown> | null
  createdAt: string
} | null {
  const row = getDb()
    .prepare(
      `SELECT decision, reason, error, model, lines, actionable, notable, answers, created_at
         FROM screens WHERE image = ? AND from_tag = ? AND to_tag = ?`,
    )
    .get(image, fromTag, toTag) as
    | {
        decision: string | null
        reason: string | null
        error: string | null
        model: string | null
        lines: string | null
        actionable: string | null
        notable: string | null
        answers: string | null
        created_at: string
      }
    | undefined
  if (!row) return null
  const parse = <T,>(s: string | null, d: T): T => {
    try {
      return s ? (JSON.parse(s) as T) : d
    } catch {
      return d
    }
  }
  return {
    decision: row.decision as ScreenDecision | null,
    reason: row.reason,
    error: row.error,
    model: row.model,
    lines: parse(row.lines, [] as ScreenLine[]),
    actionable: parse(row.actionable, [] as number[]),
    notable: parse(row.notable, [] as number[]),
    answers: parse(row.answers, null as Record<string, unknown> | null),
    createdAt: row.created_at,
  }
}
