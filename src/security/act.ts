import { env, loadPolicy, type Policy } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { scanRepo, type ScannedService } from '../compose/scan.ts'
import { formatImageRef, parseImageRef } from '../images/ref.ts'
import { hubRemaining } from '../registry/http.ts'
import { notify, resolveIncident, type IncidentAction, type Priority } from '../notify/index.ts'
import { postIssueComment } from '../gitops/comments.ts'
import { exploited, readIncident } from './feed.ts'
import { incidentTargets } from './extract.ts'
import { checkFix, matchPackages, type Hit, type Target } from './match.ts'
import { hasInventory, inventory, pullCandidate, scanImage, type Exec, type Running } from './sbom.ts'

/**
 * From matches to consequences: exposures, verified fixes, cards and comments.
 *
 * Shadow mode computes and records all of it -- the Security page and the MCP read the
 * same tables -- and sends nothing. Only `on` posts cards and comments, and only `on`
 * with `auto_merge` lets a verified fix through the merge gate (`securityFixFor`).
 */

/** States in which an update could still be the way out of an exposure. */
const CANDIDATE_STATES = ['detected', 'held', 'pr_open']
/** Don't pull from Docker Hub below this many remaining pulls; scans need them more. */
const HUB_FLOOR = 60
/** A verified fix that has not landed after this long gets a card anyway. */
const FIX_GRACE_MS = 3 * 60 * 60_000

export interface Exposure {
  slug: string
  stack: string
  service: string
  type: string
  package: string
  installed: string
  fixed: string | null
  first_seen_at: string
}

/** Every exposure of every running service, from stored inventories. Pure over the db. */
export function computeExposures(targets: Map<string, Target[]>, running: Running[]): Map<string, { r: Running; slug: string; hits: Hit[] }> {
  const out = new Map<string, { r: Running; slug: string; hits: Hit[] }>()
  const cache = new Map<string, ReturnType<typeof inventory>>()
  for (const r of running) {
    if (!cache.has(r.imageId)) cache.set(r.imageId, inventory(r.imageId))
    const pkgs = cache.get(r.imageId)
    if (!pkgs) continue
    for (const [slug, ts] of targets) {
      const hits = matchPackages(ts, pkgs)
      if (hits.length > 0) out.set(`${slug}\u0000${r.stack}\u0000${r.service}`, { r, slug, hits })
    }
  }
  return out
}

/** Replace the exposures table, keeping when each was first seen. */
export function recordExposures(found: ReturnType<typeof computeExposures>): number {
  const db = getDb()
  const now = new Date().toISOString()
  const first = new Map(
    (db.prepare(`SELECT slug, stack, service, type, package, installed, first_seen_at FROM exposures`).all() as Exposure[]).map((e) => [
      `${e.slug}\u0000${e.stack}\u0000${e.service}\u0000${e.type}\u0000${e.package}\u0000${e.installed}`,
      e.first_seen_at,
    ]),
  )
  const ins = db.prepare(
    `INSERT INTO exposures (slug, stack, service, type, package, installed, fixed, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  let n = 0
  db.transaction(() => {
    db.prepare(`DELETE FROM exposures`).run()
    for (const { r, slug, hits } of found.values()) {
      for (const h of hits) {
        const k = `${slug}\u0000${r.stack}\u0000${r.service}\u0000${h.type}\u0000${h.name}\u0000${h.version}`
        ins.run(slug, r.stack, r.service, h.type, h.name, h.version, h.fixed.join(', ') || null, first.get(k) ?? now, now)
        n++
      }
    }
  })()
  return n
}

interface CandidateUpdate {
  id: number
  stack: string
  service: string
  image: string
  to_tag: string
}

/** The image reference an update would bring in. */
export function candidateRef(image: string, toTag: string): string {
  const ref = parseImageRef(image)
  const [tag, digest] = toTag.split('@') as [string, string | undefined]
  return formatImageRef(ref, tag || null, digest ?? null)
}

/** Open updates of exposed services. */
function candidatesFor(exposed: Set<string>): CandidateUpdate[] {
  const rows = getDb()
    .prepare(
      `SELECT id, stack, service, image, to_tag FROM updates WHERE state IN (${CANDIDATE_STATES.map(() => '?').join(',')})
        ORDER BY id DESC`,
    )
    .all(...CANDIDATE_STATES) as CandidateUpdate[]
  return rows.filter((u) => exposed.has(`${u.stack}/${u.service}`))
}

/**
 * Pull and inventory the images updates of exposed services would bring in, within the
 * pass's budget. Returns how many inventories were taken.
 */
export async function inventoryCandidates(exposed: Set<string>, policy: Policy, budget: number, exec?: Exec): Promise<number> {
  const db = getDb()
  let used = 0
  for (const u of candidatesFor(exposed)) {
    if (used >= budget) break
    const ref = candidateRef(u.image, u.to_tag)
    const row = db.prepare(`SELECT image_id, error, attempts, checked_at FROM security_candidates WHERE update_id = ?`).get(u.id) as
      | { image_id: string | null; error: string | null; attempts: number; checked_at: string }
      | undefined
    let imageId = row?.image_id ?? null
    if (!imageId) {
      if (row && (row.attempts >= 3 || Date.now() - Date.parse(row.checked_at) < 60 * 60_000)) continue
      if (parseImageRef(ref).registry === 'docker.io') {
        const left = hubRemaining()
        if (left !== null && left < HUB_FLOOR) continue
      }
      const pulled = await pullCandidate(ref, exec)
      const now = new Date().toISOString()
      db.prepare(
        `INSERT INTO security_candidates (update_id, image_ref, image_id, error, attempts, checked_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(update_id) DO UPDATE SET image_ref = excluded.image_ref, image_id = excluded.image_id,
           error = excluded.error, attempts = security_candidates.attempts + 1, checked_at = excluded.checked_at`,
      ).run(u.id, ref, 'imageId' in pulled ? pulled.imageId : null, 'error' in pulled ? pulled.error : null, 1, now)
      if ('error' in pulled) {
        logEvent({ level: 'warn', kind: 'scan', stack: u.stack, service: u.service, message: 'security: could not pull the update to check it', detail: `${ref}: ${pulled.error}` })
        continue
      }
      imageId = pulled.imageId
    }
    if (hasInventory(imageId)) continue
    await scanImage(imageId, ref, policy, exec)
    used++
  }
  return used
}

/** Re-verify every candidate of every exposed service against its stored inventory. */
export function verifyFixes(targets: Map<string, Target[]>, found: ReturnType<typeof computeExposures>): number {
  const db = getDb()
  const exposedServices = new Set([...found.values()].map((f) => `${f.r.stack}/${f.r.service}`))
  const cands = candidatesFor(exposedServices)
  const candImage = new Map(
    (db.prepare(`SELECT update_id, image_id FROM security_candidates WHERE image_id IS NOT NULL`).all() as {
      update_id: number
      image_id: string
    }[]).map((r) => [r.update_id, r.image_id]),
  )
  const now = new Date().toISOString()
  const keep = new Set<string>()
  const upsert = db.prepare(
    `INSERT INTO security_fixes (update_id, slug, evidence, verified_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(update_id, slug) DO UPDATE SET evidence = excluded.evidence`,
  )
  let verified = 0
  for (const { r, slug, hits } of found.values()) {
    for (const u of cands) {
      if (u.stack !== r.stack || u.service !== r.service) continue
      const imageId = candImage.get(u.id)
      const pkgs = imageId ? inventory(imageId) : null
      if (!pkgs) continue
      const check = checkFix(targets.get(slug) ?? [], hits, pkgs)
      if (!check.verified) continue
      upsert.run(u.id, slug, JSON.stringify(check.evidence), now)
      keep.add(`${u.id}\u0000${slug}`)
      verified++
    }
  }
  // A fix that no longer verifies -- the exposure is gone, or the candidate changed -- is
  // withdrawn, so the gate can never act on a stale claim.
  // Except an update that already went through: its fix is history now (the comment, the
  // update page), and the gate never asks about a merged update again.
  const all = db
    .prepare(
      `SELECT f.update_id, f.slug FROM security_fixes f JOIN updates u ON u.id = f.update_id
        WHERE u.state NOT IN ('merged', 'deploying', 'deployed', 'verified', 'left-stopped')`,
    )
    .all() as { update_id: number; slug: string }[]
  const del = db.prepare(`DELETE FROM security_fixes WHERE update_id = ? AND slug = ?`)
  for (const f of all) if (!keep.has(`${f.update_id}\u0000${f.slug}`)) del.run(f.update_id, f.slug)
  return verified
}

export interface SecurityFix {
  slug: string
  title: string
  evidence: { type: string; name: string; from: string; to: string[] }[]
  /** Critical, or exploited in the wild (KEV, exploited, zero-day): skips the cooldown. */
  critical: boolean
}

/**
 * The verified fix that lets this update through the merge gate, or null.
 *
 * Null unless the policy says `mode: on` and `auto_merge: true`, so turning either off
 * is immediate: the very next merge decision no longer sees it.
 */
export function securityFixFor(updateId: number, policy: Policy = loadPolicy().policy): SecurityFix | null {
  if (policy.security.mode !== 'on' || !policy.security.auto_merge) return null
  return verifiedFix(updateId)
}

/** The verified fix for an update, whatever the policy says. For display. */
export function verifiedFix(updateId: number): SecurityFix | null {
  const row = getDb()
    .prepare(
      `SELECT f.slug, f.evidence, i.title, i.severity, i.tags FROM security_fixes f JOIN security_incidents i ON i.slug = f.slug
        WHERE f.update_id = ?`,
    )
    .all(updateId) as { slug: string; evidence: string; title: string; severity: string | null; tags: string }[]
  if (row.length === 0) return null
  // The most serious incident it fixes speaks for it.
  const views = row.map((r) => ({
    slug: r.slug,
    title: r.title,
    evidence: JSON.parse(r.evidence) as SecurityFix['evidence'],
    critical: r.severity === 'critical' || exploited(JSON.parse(r.tags) as string[]),
  }))
  return views.find((v) => v.critical) ?? views[0]!
}

/** Reachable from outside WireGuard: a Traefik router whose rule has no ClientIP gate. */
export function isPublic(s: ScannedService | undefined): boolean {
  if (!s) return false
  if (String(s.labels['traefik.enable']).toLowerCase() !== 'true') return false
  return Object.entries(s.labels).some(([k, v]) => /^traefik\.http\.routers\.[^.]+\.rule$/.test(k) && !/ClientIP\(/.test(v))
}

/** How loud an exposure card is (rule 4 of the homelab's notification model). */
export function priorityOf(severity: string | null, exploitedInWild: boolean, publicFacing: boolean): Priority {
  const critical = severity === 'critical'
  if (critical && exploitedInWild && publicFacing) return 5
  if (exploitedInWild || (critical && publicFacing)) return 4
  return 3
}

const KEY = 'shipshape:security:'

interface CardLine {
  stack: string
  service: string
  pkgs: string
  fix: { id: number; to: string; pr: number | null } | null
}

/** Bring the exposure cards in line with the exposures table. Only in `on`. */
export async function syncSecurityCards(policy: Policy): Promise<number> {
  if (policy.security.mode !== 'on') return 0
  const db = getDb()
  const services = scanRepo(env.repoDir, [])
  const svc = (stack: string, service: string) => services.find((s) => s.stack === stack && s.service === service)
  const exposures = db.prepare(`SELECT * FROM exposures ORDER BY slug, stack, service`).all() as Exposure[]
  const fixes = db
    .prepare(
      `SELECT f.update_id, f.slug, f.verified_at, u.stack, u.service, u.to_tag, p.number AS pr
         FROM security_fixes f JOIN updates u ON u.id = f.update_id
         LEFT JOIN pr_updates pu ON pu.update_id = u.id
         LEFT JOIN prs p ON p.id = pu.pr_id AND p.state = 'open'`,
    )
    .all() as { update_id: number; slug: string; verified_at: string; stack: string; service: string; to_tag: string; pr: number | null }[]

  const bySlug = new Map<string, Map<string, CardLine>>()
  for (const e of exposures) {
    const lines = bySlug.get(e.slug) ?? new Map<string, CardLine>()
    bySlug.set(e.slug, lines)
    const k = `${e.stack}/${e.service}`
    const l = lines.get(k) ?? { stack: e.stack, service: e.service, pkgs: '', fix: null }
    l.pkgs = [l.pkgs, `${e.package} ${e.installed}${e.fixed ? ` (fixed ${e.fixed})` : ''}`].filter(Boolean).join(', ')
    lines.set(k, l)
  }

  let changed = 0
  const live = new Set<string>()
  for (const [slug, lines] of bySlug) {
    const inc = readIncident(slug)
    if (!inc) continue
    // A service whose fix verified recently is left to the merge gate for a while: the
    // card is for what will not resolve itself.
    let waiting = 0
    for (const l of lines.values()) {
      const f = fixes.find((x) => x.slug === slug && x.stack === l.stack && x.service === l.service)
      if (f) {
        l.fix = { id: f.update_id, to: f.to_tag, pr: f.pr }
        if (policy.security.auto_merge && Date.now() - Date.parse(f.verified_at) < FIX_GRACE_MS) continue
      }
      waiting++
    }
    if (waiting === 0) continue
    const key = `${KEY}${slug}`
    live.add(key)
    const all = [...lines.values()]
    const pub = all.some((l) => isPublic(svc(l.stack, l.service)))
    const priority = priorityOf(inc.severity, exploited(inc.tags), pub)
    const body = all
      .map((l) => {
        const name = l.stack === l.service ? l.service : `${l.stack}/${l.service}`
        const fix = l.fix ? `fix: ${l.fix.to}${l.fix.pr ? ` (#${l.fix.pr})` : ''}` : 'no fix available yet'
        return `- ${name}${isPublic(svc(l.stack, l.service)) ? ' (public)' : ''}: ${l.pkgs} · ${fix}`
      })
      .join('\n')
    const actions: IncidentAction[] | undefined = env.mcpPort
      ? all
          .filter((l) => l.fix?.pr)
          .slice(0, 3)
          .map((l) => ({ emoji: '🚀', label: `merge ${l.service}`, do: { target: 'shipshape' as const, verb: 'merge-deploy', update: l.fix!.id } }))
      : undefined
    await notify({
      key,
      title: `${inc.title.slice(0, 120)} · ${all.length} service${all.length === 1 ? '' : 's'} exposed`,
      body: `${body}\n\n${inc.url ?? ''}`.trim(),
      click: inc.url ?? undefined,
      priority,
      actions: actions && actions.length > 0 ? actions : undefined,
    })
    changed++
  }
  const open = db.prepare(`SELECT key FROM incidents WHERE open = 1 AND key LIKE ?`).all(`${KEY}%`) as { key: string }[]
  for (const { key } of open) {
    if (live.has(key)) continue
    await resolveIncident(key)
    changed++
  }
  return changed
}

/** Say on each fixing pull request, once, what it fixes and how that was established. */
export async function commentFixes(policy: Policy): Promise<number> {
  if (policy.security.mode !== 'on' || !env.githubToken) return 0
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT f.update_id, f.slug, f.evidence, i.title, i.url, p.number
         FROM security_fixes f
         JOIN security_incidents i ON i.slug = f.slug
         JOIN pr_updates pu ON pu.update_id = f.update_id
         -- Merged too: a critical fix can merge in the same minute it is verified, before
         -- this pass runs, and the evidence belongs on its pull request either way.
         JOIN prs p ON p.id = pu.pr_id AND p.state IN ('open', 'merged')
        WHERE f.commented = 0`,
    )
    .all() as { update_id: number; slug: string; evidence: string; title: string; url: string | null; number: number }[]
  let n = 0
  for (const r of rows) {
    const ev = JSON.parse(r.evidence) as SecurityFix['evidence']
    const lines = ev.map((e) => `- \`${e.name}\` (${e.type}): ${e.from} → ${e.to.join(', ')}`)
    const body = [
      `### Security fix`,
      `This update removes an exposure to **${r.title}**${r.url ? ` ([advisory](${r.url}))` : ''}.`,
      '',
      'Read from both images\' own inventories (syft), not from the advisory:',
      ...lines,
      '',
      policy.security.auto_merge
        ? 'Security fixes may merge past the manual rung and a `caution` review; a hold, a `block` review or pause still stop it.'
        : 'Auto-merge for security fixes is off; this needs your merge as usual.',
    ].join('\n')
    const id = await postIssueComment(r.number, 'security', body)
    if (id !== null) {
      db.prepare(`UPDATE security_fixes SET commented = 1 WHERE update_id = ? AND slug = ?`).run(r.update_id, r.slug)
      n++
    }
  }
  return n
}

/** Incident targets, re-exported for the loop. */
export { incidentTargets }
