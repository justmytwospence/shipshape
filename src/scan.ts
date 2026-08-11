import { configured, env, loadPolicy, type Policy } from './config.ts'
import { getDb, logEvent } from './db.ts'
import { scanRepo, type ScannedService } from './compose/scan.ts'
import { detect, type Detection } from './detect.ts'
import { checkDigest, shortDigest, type DigestCheck } from './digests.ts'
import { tierFor } from './policy.ts'
import type { TagInfo } from './registry/index.ts'
import type { Magnitude } from './versions/patterns.ts'

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

export function isScanning(): boolean {
  return running
}

export async function runScan(trigger: 'cron' | 'manual'): Promise<ScanResult> {
  if (running) return { status: 'already-running' }
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
    const services = scanRepo(env.repoDir, policy.exclude_stacks)
    syncInventory(services)

    for (const svc of services) {
      if (!svc.watched) continue
      bump(await scanOne(svc, policy))
    }

    const durationS = Math.round((Date.now() - started) / 1000)
    recordTelemetry(counts, durationS)
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
  try {
    return await persist(svc, d, policy)
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
}

function summarise(counts: Record<string, number>, durationS: number): string {
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

// ------------------------------------------------------------------ inventory

/** Mirror the compose files into `images`, and forget services that no longer exist. */
function syncInventory(services: ScannedService[]): void {
  const db = getDb()
  const now = new Date().toISOString()
  const upsert = db.prepare(
    `INSERT INTO images (stack, service, compose_file, image_ref, registry, repository,
                         current_tag, current_digest, watched, pattern, tag_include,
                         policy_label, source_label, claude_label, deploy_label,
                         probe_port, archive_pre, unwatchable, last_seen_at)
     VALUES (@stack, @service, @compose_file, @image_ref, @registry, @repository,
             @current_tag, @current_digest, @watched, @pattern, @tag_include,
             @policy_label, @source_label, @claude_label, @deploy_label,
             @probe_port, @archive_pre, @unwatchable, @last_seen_at)
     ON CONFLICT(stack, service) DO UPDATE SET
       compose_file = excluded.compose_file, image_ref = excluded.image_ref,
       registry = excluded.registry, repository = excluded.repository,
       current_tag = excluded.current_tag, current_digest = excluded.current_digest,
       watched = excluded.watched, pattern = excluded.pattern,
       tag_include = excluded.tag_include, policy_label = excluded.policy_label,
       source_label = excluded.source_label, claude_label = excluded.claude_label,
       deploy_label = excluded.deploy_label, probe_port = excluded.probe_port,
       archive_pre = excluded.archive_pre, unwatchable = excluded.unwatchable,
       last_seen_at = excluded.last_seen_at`,
  )

  db.transaction(() => {
    for (const s of services) {
      upsert.run({
        stack: s.stack,
        service: s.service,
        compose_file: s.composeFile,
        image_ref: s.imageRaw ?? '',
        registry: s.ref?.registry ?? '',
        repository: s.ref?.repository ?? '',
        current_tag: s.ref?.tag ?? null,
        current_digest: s.ref?.digest ?? null,
        watched: s.watched ? 1 : 0,
        pattern: s.pattern,
        tag_include: s.tagInclude,
        policy_label: s.policyLabel,
        source_label: s.sourceLabel,
        claude_label: s.claudeLabel,
        deploy_label: s.deployLabel,
        probe_port: s.probePort,
        archive_pre: s.archivePre,
        unwatchable: s.unwatchable,
        last_seen_at: now,
      })
    }
    db.prepare(`DELETE FROM images WHERE last_seen_at < ?`).run(now)
  })()
}

// ------------------------------------------------------------------ persistence

const LIVE_STATES = `('detected','pr_open','held')`

interface UpdateRow {
  id: number
  from_tag: string
  to_tag: string
  state: string
  magnitude: string
  tier: string
}

function liveRows(stack: string, service: string): UpdateRow[] {
  return getDb()
    .prepare(
      `SELECT id, from_tag, to_tag, state, magnitude, tier FROM updates
       WHERE stack = ? AND service = ? AND state IN ${LIVE_STATES}`,
    )
    .all(stack, service) as UpdateRow[]
}

function supersede(id: number, detail: string): void {
  getDb()
    .prepare(`UPDATE updates SET state = 'superseded', detail = ?, updated_at = ? WHERE id = ?`)
    .run(detail, new Date().toISOString(), id)
}

function setImageStatus(
  svc: ScannedService,
  status: string | null,
  detail: string | null,
): { changed: boolean } {
  const db = getDb()
  const prev = db
    .prepare(`SELECT last_status, last_detail FROM images WHERE stack = ? AND service = ?`)
    .get(svc.stack, svc.service) as { last_status: string | null; last_detail: string | null } | undefined
  const changed = !prev || prev.last_status !== status || prev.last_detail !== detail
  db.prepare(`UPDATE images SET last_status = ?, last_detail = ? WHERE stack = ? AND service = ?`)
    .run(status, detail, svc.stack, svc.service)
  return { changed }
}

/** A newer release exists but a deliberate `tag.include` pin suppressed it. */
function setConstrained(svc: ScannedService, tag: string | null): void {
  getDb()
    .prepare(`UPDATE images SET constrained_from = ? WHERE stack = ? AND service = ?`)
    .run(tag, svc.stack, svc.service)
}

function rememberTags(svc: ScannedService, observed: TagInfo[]): void {
  if (!svc.ref || observed.length === 0) return
  const db = getDb()
  const now = new Date().toISOString()
  const stmt = db.prepare(
    `INSERT INTO tags_seen (registry, repository, tag, digest, published_at, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(registry, repository, tag) DO UPDATE SET
       digest = COALESCE(excluded.digest, tags_seen.digest),
       published_at = COALESCE(excluded.published_at, tags_seen.published_at)`,
  )
  db.transaction(() => {
    for (const t of observed) {
      stmt.run(svc.ref!.registry, svc.ref!.repository, t.tag, t.digest ?? null, t.publishedAt ?? null, now)
    }
  })()
}

function insertUpdate(opts: {
  svc: ScannedService
  fromTag: string
  toTag: string
  magnitude: Magnitude
  tier: string
  state: 'detected' | 'held'
  detail?: string
}): void {
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier,
                            state, detail, detected_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(stack, service, from_tag, to_tag) DO UPDATE SET
         state = excluded.state, tier = excluded.tier, updated_at = excluded.updated_at,
         -- Re-detection is a fresh observation, so the reason the row was last retired
         -- ('pr-closed', 'newer target X') must not survive into it and be read as the
         -- reason it is open now.
         detail = excluded.detail`,
    )
    .run(
      opts.svc.stack,
      opts.svc.service,
      opts.svc.imageRaw ?? '',
      opts.fromTag,
      opts.toTag,
      opts.magnitude,
      opts.tier,
      opts.state,
      opts.detail ?? null,
      now,
      now,
    )
}

/** Returns a short outcome key used for the scan summary counts. */
async function persist(
  svc: ScannedService,
  d: Detection,
  policy: Policy,
): Promise<string> {
  const now = new Date().toISOString()
  const db = getDb()

  switch (d.status) {
    case 'update': {
      setImageStatus(svc, null, null)
      setConstrained(svc, null)
      rememberTags(svc, d.observed)
      const currentTag = svc.ref?.tag ?? ''
      const existing = liveRows(svc.stack, svc.service)

      const tier = tierFor({
        magnitude: d.magnitude as Magnitude,
        policyLabel: svc.policyLabel,
        prLabel: svc.prLabel,
        defaults: policy.defaults,
      })

      const same = existing.find((r) => r.from_tag === currentTag && r.to_tag === d.tag)
      if (same) {
        // Already known: touch and stay silent -- this is the idempotence guarantee.
        //
        // But the tier is re-derived every scan rather than frozen at insert time.
        // Labels live in the compose files precisely so that editing one takes effect
        // without recreating anything; if the tier were only ever set on insert, adding
        // `shipshape.pr: on-request` to a service with an outstanding update would
        // silently do nothing until that update happened to be superseded.
        if (same.tier !== tier) {
          const nextState = tier === 'held' ? 'held' : same.state === 'held' ? 'detected' : same.state
          db.prepare(`UPDATE updates SET tier = ?, state = ?, updated_at = ? WHERE id = ?`)
            .run(tier, nextState, now, same.id)
          logEvent({
            level: 'info',
            kind: 'policy',
            stack: svc.stack,
            service: svc.service,
            message: `policy changed: ${same.tier} -> ${tier}`,
          })
          return 'retiered'
        }
        db.prepare(`UPDATE updates SET updated_at = ? WHERE id = ?`).run(now, same.id)
        return 'unchanged'
      }

      for (const r of existing) {
        supersede(r.id, r.to_tag === d.tag ? 'rebased on new current tag' : `newer target ${d.tag}`)
      }

      if (tier === 'skip') return 'skipped'

      insertUpdate({
        svc,
        fromTag: currentTag,
        toTag: d.tag,
        magnitude: d.magnitude as Magnitude,
        tier,
        state: tier === 'held' ? 'held' : 'detected',
      })
      logEvent({
        level: 'info',
        kind: 'scan',
        stack: svc.stack,
        service: svc.service,
        message: `update available: ${currentTag} -> ${d.tag} (${d.magnitude})`,
        detail: `tier=${tier}${d.via === 'releases' ? ', via release probing' : ''}`,
      })
      return 'update'
    }

    case 'up-to-date': {
      setImageStatus(svc, null, null)
      setConstrained(svc, d.constrainedFrom ?? null)
      rememberTags(svc, d.observed)
      const currentTag = svc.ref?.tag ?? ''
      for (const r of liveRows(svc.stack, svc.service)) {
        if (r.from_tag !== currentTag) {
          // The file moved on: WUD applied it overnight, or a human hand-bumped it.
          supersede(r.id, 'caught-up')
          logEvent({
            level: 'info',
            kind: 'scan',
            stack: svc.stack,
            service: svc.service,
            message: `applied elsewhere: now on ${currentTag}`,
          })
        } else {
          // Still on the old tag, but the target no longer wins -- typically a yanked
          // release. Worth a human's attention rather than a silent disappearance.
          supersede(r.id, 'target-vanished')
          logEvent({
            level: 'warn',
            kind: 'scan',
            stack: svc.stack,
            service: svc.service,
            message: `previous target ${r.to_tag} is no longer offered`,
          })
        }
      }
      return 'up-to-date'
    }

    case 'digest-watch':
      return persistDigest(svc, await checkDigest(svc), policy)

    default: {
      // Every named failure. No updates row; the state is surfaced on the images page.
      const { changed } = setImageStatus(svc, d.status, 'detail' in d ? d.detail : null)
      if (changed) {
        logEvent({
          level: d.status === 'error' ? 'warn' : 'info',
          kind: 'scan',
          stack: svc.stack,
          service: svc.service,
          message: `needs attention: ${d.status}`,
          detail: 'detail' in d ? d.detail : undefined,
        })
      }
      return d.status === 'error' ? 'error' : 'needs-attention'
    }
  }
}

function persistDigest(svc: ScannedService, c: DigestCheck, policy: Policy): string {
  const tag = svc.ref?.tag ?? 'latest'

  switch (c.status) {
    case 'bootstrapped':
    case 'unchanged':
    case 'pinned-to-child':
      setImageStatus(svc, null, null)
      return c.status === 'bootstrapped' ? 'bootstrapped' : 'unchanged'

    case 'moved-pinned': {
      setImageStatus(svc, null, null)
      const fromTag = `${tag}@${c.from}`
      const toTag = `${tag}@${c.to}`
      const tier = tierFor({
        magnitude: 'digest',
        policyLabel: svc.policyLabel,
        prLabel: svc.prLabel,
        defaults: policy.defaults,
      })
      const existing = liveRows(svc.stack, svc.service)
      const same = existing.find((r) => r.from_tag === fromTag && r.to_tag === toTag)
      if (same) {
        // Re-derive the tier so a label edit lands without waiting for a new digest.
        if (same.tier !== tier) {
          getDb()
            .prepare(`UPDATE updates SET tier = ?, state = ?, updated_at = ? WHERE id = ?`)
            .run(tier, tier === 'held' ? 'held' : 'detected', new Date().toISOString(), same.id)
          return 'retiered'
        }
        return 'unchanged'
      }
      for (const r of existing) supersede(r.id, 'newer digest')

      if (tier === 'skip') return 'skipped'
      insertUpdate({
        svc,
        fromTag,
        toTag,
        magnitude: 'digest',
        tier,
        state: tier === 'held' ? 'held' : 'detected',
      })
      logEvent({
        level: 'info',
        kind: 'scan',
        stack: svc.stack,
        service: svc.service,
        message: `pinned digest moved: ${shortDigest(c.from)} -> ${shortDigest(c.to)}`,
        detail: `tier=${tier}`,
      })
      return 'moved-pinned'
    }

    case 'moved-rolling': {
      setImageStatus(svc, null, null)
      const fromTag = `${tag}@${c.from}`
      const toTag = `${tag}@${c.to}`
      const existing = liveRows(svc.stack, svc.service)
      if (existing.some((r) => r.from_tag === fromTag && r.to_tag === toTag)) return 'unchanged'
      for (const r of existing) supersede(r.id, 'newer digest')

      // No PR is possible: the compose file says `latest` and will still say `latest`
      // afterwards. This row exists so the dashboard can offer a redeploy.
      insertUpdate({
        svc,
        fromTag,
        toTag,
        magnitude: 'digest',
        tier: 'manual',
        state: 'detected',
        detail: 'rolling',
      })
      logEvent({
        level: 'info',
        kind: 'scan',
        stack: svc.stack,
        service: svc.service,
        message: `rolling tag moved: ${tag} ${shortDigest(c.from)} -> ${shortDigest(c.to)}`,
        detail: 'redeploy to adopt',
      })
      return 'moved-rolling'
    }

    case 'head-failed': {
      const { changed } = setImageStatus(svc, 'head-failed', c.detail)
      if (changed) {
        logEvent({
          level: 'warn',
          kind: 'scan',
          stack: svc.stack,
          service: svc.service,
          message: 'digest check failed',
          detail: c.detail,
        })
      }
      return 'error'
    }
  }
}

function recordTelemetry(counts: Record<string, number>, durationS: number): void {
  const db = getDb()
  const now = new Date().toISOString()
  const put = db.prepare(
    `INSERT INTO budgets (key, value, window, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, window = excluded.window,
                                    updated_at = excluded.updated_at`,
  )
  put.run('scan.last_duration_s', durationS, null, now)
  put.run('scan.last_counts', Object.values(counts).reduce((a, b) => a + b, 0), JSON.stringify(counts), now)
  put.run('scan.last_at', Date.parse(now), now, now)
}
