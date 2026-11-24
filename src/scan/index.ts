import { configured, env, loadPolicy, type Policy } from '../config.ts'
import { getDb } from '../db.ts'
import { logEvent } from '../events.ts'
import { scanRepo, type ScannedService } from '../compose/scan.ts'
import { discoverCompose } from '../compose/files.ts'
import { detect, type Detection } from '../detect.ts'
import { resolveWatched, sourceFor } from '../resolver/index.ts'
import { checkFork, reconcileForks } from '../forks.ts'
import { prune } from '../db/retention.ts'
import { persist } from './persist.ts'
import { syncInventory, refreshServiceLabels } from './inventory.ts'
import { recordComposeFiles, reportUnknownLabels, recordTelemetry, summarise } from './report.ts'

/**
 * The nightly (or on-demand) sweep: read the compose files, ask each registry what
 * exists, and fold the answers into the `updates` state machine.
 *
 * Two properties matter more than anything else here:
 *   1. **Idempotence.** Running twice in a row must produce no new rows and no new
 *      events. Events fire on the first observation of a fact, never on re-observation,
 *      or a nightly scan turns the activity log into noise.
 *   2. **Isolation.** One unreachable registry may not abort the sweep. Every detection
 *      is wrapped, so a failure costs exactly one image.
 */

export type ScanResult =
  | { status: 'completed'; counts: Record<string, number>; durationS: number }
  | { status: 'already-running' }


let running = false


let current: Promise<ScanResult> | null = null


export function isScanning(): boolean {
  return running
}


/** Resolves when no scan is running (shutdown waits on it). */
export async function scanIdle(): Promise<void> {
  await current?.catch(() => undefined)
}


export function runScan(trigger: 'cron' | 'manual'): Promise<ScanResult> {
  if (running) return Promise.resolve({ status: 'already-running' })
  const work = scanBody(trigger)
  current = work
  const done = () => {
    if (current === work) current = null
  }
  work.then(done, done)
  return work
}


async function scanBody(trigger: 'cron' | 'manual'): Promise<ScanResult> {
  const setup = configured()
  if (!setup.ok) {
    return { status: 'completed', counts: { unconfigured: setup.missing.length }, durationS: 0 }
  }
  running = true
  const started = Date.now()
  const counts: Record<string, number> = {}
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1)

  try {
    const { policy } = loadPolicy()
    const discovery = discoverCompose(env.repoDir)
    recordComposeFiles(discovery.files.length)
    for (const d of discovery.shadowed) {
      logEvent({
        level: 'warn',
        kind: 'scan',
        message: `${d.dir || 'the repository root'} has more than one compose file; using ${d.kept}`,
        detail: `Compose prefers ${d.kept} and shipshape follows it. Ignored: ${d.ignored.join(', ')}.`,
      })
    }
    if (discovery.files.length === 0) {
      // An empty or unmounted REPO_DIR must not read as "every service was removed": the
      // inventory would be wiped and every update retired.
      logEvent({
        level: 'error',
        kind: 'system',
        message: `no compose files found in ${env.repoDir}`,
        detail:
          'shipshape looks for compose.yaml, compose.yml, docker-compose.yml or docker-compose.yaml in REPO_DIR ' +
          'itself (the "root" stack) and in each directory directly under it, one directory per stack. Check that ' +
          'REPO_DIR is the repository root, that it is mounted at the same path inside the container, and that the ' +
          'files are committed. The existing inventory was left as it was.',
      })
      return { status: 'completed', counts: { 'no-compose-files': 1 }, durationS: 0 }
    }
    const services = scanRepo(env.repoDir, policy.exclude_stacks)
    syncInventory(services)
    reportUnknownLabels(services)
    // Before detection, so a service that stopped being a fork since the last scan has
    // its incident closed even if everything after this fails.
    await reconcileForks(services)

    // Where each watched image comes from, for the ones never looked up or due another look.
    // Most images used to be looked up only when an update needed release notes, so the
    // Services page called them unresolved indefinitely. Before detection, so an update found
    // below already has its upstream. Unbilled and bounded: see resolveWatched.
    try {
      const r = await resolveWatched({ allowBilled: false, limit: 60, budgetMs: 90_000 })
      if (r.looked > 0) {
        logEvent({
          level: 'info',
          kind: 'scan',
          message: 'looked up upstream repositories',
          detail: `${r.looked} of ${r.due} due, ${r.linked} linked${r.failed ? `, ${r.failed} could not be looked up` : ''}`,
        })
      }
    } catch (err) {
      logEvent({ level: 'error', kind: 'scan', message: 'upstream lookups failed', detail: (err as Error).message })
    }

    for (const svc of services) {
      if (!svc.watched) continue
      bump(await scanOne(svc, policy))
    }

    const durationS = Math.round((Date.now() - started) / 1000)
    recordTelemetry(counts, durationS)
    try {
      prune()
    } catch (err) {
      logEvent({ level: 'warn', kind: 'system', message: 'database pruning failed', detail: (err as Error).message })
    }
    logEvent({
      level: 'info',
      kind: 'scan',
      message: `scan complete (${trigger})`,
      detail: summarise(counts, durationS),
    })
    return { status: 'completed', counts, durationS }
  } finally {
    running = false
  }
}


/**
 * Detect and persist one service. Shared by the nightly sweep and the per-service
 * "Check now" button, so both paths behave identically -- including the isolation: a
 * failure here is recorded against that service and never propagates.
 */
export async function scanOne(svc: ScannedService, policy: Policy): Promise<string> {
  let d: Detection
  try {
    d = await detect(svc)
  } catch (err) {
    // detect() is meant to be total, but a bug there must not cost the whole sweep.
    d = { status: 'error', detail: (err as Error).message }
  }
  let outcome: string
  try {
    outcome = await persist(svc, d, policy)
  } catch (err) {
    logEvent({
      level: 'error',
      kind: 'scan',
      stack: svc.stack,
      service: svc.service,
      message: 'failed to record scan result',
      detail: (err as Error).message,
    })
    return 'persist-error'
  }
  // After detection, so the newest upstream release it may have just recorded is what
  // the fix is looked for in. Isolated the same way: a GitHub failure costs this
  // service's fork status and nothing else.
  if (svc.fork) {
    try {
      await checkFork(svc)
    } catch (err) {
      logEvent({
        level: 'warn',
        kind: 'scan',
        stack: svc.stack,
        service: svc.service,
        message: 'could not check the fork upstream',
        detail: (err as Error).message,
      })
    }
  }
  return outcome
}



/**
 * Re-check one service now, rather than waiting for a sweep: its labels from git, its
 * upstream when nothing has looked it up yet, and its registry. False when the compose
 * files no longer have it.
 */
export async function checkService(stack: string, service: string): Promise<boolean> {
  const { policy } = loadPolicy()
  const svc = scanRepo(env.repoDir, policy.exclude_stacks).find(
    (s) => s.stack === stack && s.service === service,
  )
  if (!svc) return false
  // Labels first: a review reads them from the images table, which only a scan refreshed,
  // so a label committed after the last scan was invisible to "check" and to every review
  // it led to (tika's shipshape.changelog, 2026-10-22).
  refreshServiceLabels(stack, service)
  if (svc.ref) {
    // Its upstream as well, when nothing has looked it up yet or the answer is due. Unbilled,
    // like the sweep: "Look again" is the button that spends pulls.
    await sourceFor(
      { registry: svc.ref.registry, repository: svc.ref.repository },
      { service: { stack, service }, ownLabel: svc.sourceLabel, allowBilled: false },
    ).catch((err: unknown) =>
      logEvent({
        level: 'warn',
        kind: 'scan',
        stack,
        service,
        message: 'looking up the upstream failed',
        detail: `${stack}/${service}: ${(err as Error).message.slice(0, 300)}`,
      }),
    )
  }
  if (svc.watched) await scanOne(svc, policy)
  return true
}



export interface ScanInfo {
  lastAt: string | null
  durationS: number | null
  counts: Record<string, number> | null
  running: boolean
  /** How many compose files the last scan found; 0 means REPO_DIR holds none. */
  composeFiles: number | null
}



export function scanInfo(): ScanInfo {
  const rows = getDb()
    .prepare(`SELECT key, value, window FROM budgets WHERE key LIKE 'scan.%'`)
    .all() as { key: string; value: number; window: string | null }[]
  const by = new Map(rows.map((r) => [r.key, r]))
  const lastAt = by.get('scan.last_at')?.window ?? null
  const durationS = by.get('scan.last_duration_s')?.value ?? null
  let counts: Record<string, number> | null = null
  const raw = by.get('scan.last_counts')?.window
  if (raw) {
    try {
      counts = JSON.parse(raw) as Record<string, number>
    } catch {
      counts = null
    }
  }
  return { lastAt, durationS, counts, running: isScanning(), composeFiles: by.get('scan.compose_files')?.value ?? null }
}
