import { execa } from 'execa'
import { env, type Policy } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { dockerEnvOptions } from '../deploy/docker-env.ts'
import { projectName } from '../deploy/probe.ts'
import { scanRepo } from '../compose/scan.ts'
import type { Package } from './match.ts'

/**
 * Software inventories, from syft, per local image id.
 *
 * syft runs as its own throwaway container against the host's docker socket, reading
 * the image the daemon already has: nothing is pulled for a running service, and a
 * multi-gigabyte image costs syft's memory, not shipshape's. An inventory is keyed by
 * the image id, so it is taken once per image and survives restarts; only a new image
 * costs anything.
 */

/** What docker says a compose service is running. */
export interface Running {
  stack: string
  service: string
  imageId: string
  imageRef: string
}

/** syft's JSON, as far as it is read. */
interface SyftJson {
  artifacts?: { type?: string; name?: string; version?: string; locations?: { path?: string }[] }[]
}

/** Condense syft's output to inventory rows. Exported for the tests. */
export function packagesOf(json: SyftJson): Package[] {
  const seen = new Set<string>()
  const out: Package[] = []
  for (const a of json.artifacts ?? []) {
    if (!a.type || !a.name || !a.version) continue
    const path = a.locations?.[0]?.path ?? null
    const key = `${a.type}\u0000${a.name}\u0000${a.version}\u0000${path ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ type: a.type, name: a.name, version: a.version, path })
  }
  return out
}

export type Exec = (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<{ exitCode?: number; stdout: string; stderr: string; timedOut?: boolean }>

const run: Exec = async (cmd, args, opts) => {
  const r = await execa(cmd, args, {
    reject: false,
    timeout: opts?.timeout ?? 30_000,
    maxBuffer: 256 * 1024 * 1024,
    ...dockerEnvOptions(),
  })
  return { exitCode: r.exitCode, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), timedOut: r.timedOut }
}

/**
 * Every running compose service of the watched repository, with the image it runs.
 *
 * One `docker ps` and one `docker inspect` for all of them. Containers that belong to no
 * stack in the repository are ignored: shipshape has no update to offer for them.
 */
export async function listRunning(exec: Exec = run): Promise<Running[]> {
  const ps = await exec('docker', [
    'ps',
    '--no-trunc',
    '--filter',
    'status=running',
    '--format',
    '{{.ID}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}',
  ])
  if (ps.exitCode !== 0) throw new Error(`docker ps failed: ${ps.stderr.trim().split('\n').at(-1) ?? ''}`)

  // (project, service) -> stack, from the compose files themselves.
  const byProject = new Map<string, string>()
  for (const s of scanRepo(env.repoDir, [])) byProject.set(`${projectName(s.stack)}\u0000${s.service}`, s.stack)

  const rows = ps.stdout
    .split('\n')
    .map((l) => l.trim().split('\t'))
    .filter((p) => p.length === 3 && p[0])
    .map(([id, project, service]) => ({ id: id!, stack: byProject.get(`${project}\u0000${service}`), service: service! }))
    .filter((r): r is { id: string; stack: string; service: string } => Boolean(r.stack))
  if (rows.length === 0) return []

  const insp = await exec('docker', ['inspect', '--format', '{{.Id}}\t{{.Image}}\t{{.Config.Image}}', ...rows.map((r) => r.id)])
  if (insp.exitCode !== 0) throw new Error(`docker inspect failed: ${insp.stderr.trim().split('\n').at(-1) ?? ''}`)
  const byId = new Map(
    insp.stdout
      .split('\n')
      .map((l) => l.trim().split('\t'))
      .filter((p) => p.length === 3)
      .map(([cid, image, ref]) => [cid!, { image: image!, ref: ref! }]),
  )
  const out: Running[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    const i = byId.get(r.id)
    const key = `${r.stack}/${r.service}`
    if (!i || seen.has(key)) continue
    seen.add(key)
    out.push({ stack: r.stack, service: r.service, imageId: i.image, imageRef: i.ref })
  }
  return out
}

/** Record what is running now, replacing the previous reading. */
export function recordRunning(running: Running[]): void {
  const db = getDb()
  const now = new Date().toISOString()
  const ins = db.prepare(
    `INSERT INTO security_running (stack, service, image_id, image_ref, seen_at) VALUES (?, ?, ?, ?, ?)`,
  )
  db.transaction(() => {
    db.prepare(`DELETE FROM security_running`).run()
    for (const r of running) ins.run(r.stack, r.service, r.imageId, r.imageRef, now)
  })()
}

/** Whether an image already has an inventory (or failed often enough to stop trying). */
export function hasInventory(imageId: string): boolean {
  const r = getDb().prepare(`SELECT error, attempts FROM sbom_images WHERE image_id = ?`).get(imageId) as
    | { error: string | null; attempts: number }
    | undefined
  return Boolean(r && (r.error === null || r.attempts >= 3))
}

export function inventory(imageId: string): Package[] | null {
  const db = getDb()
  const img = db.prepare(`SELECT error FROM sbom_images WHERE image_id = ?`).get(imageId) as { error: string | null } | undefined
  if (!img || img.error !== null) return null
  return db.prepare(`SELECT type, name, version, path FROM sbom_packages WHERE image_id = ?`).all(imageId) as Package[]
}

/** Take one image's inventory with syft and store it. */
export async function scanImage(imageId: string, ref: string | null, policy: Policy, exec: Exec = run): Promise<boolean> {
  const db = getDb()
  const started = Date.now()
  const r = await exec(
    'docker',
    [
      'run',
      '--rm',
      // A 3 GB image (hermes) needs more than 3g; 8g is a ceiling, not a reservation.
      '--memory',
      '8g',
      '--cpus',
      '2',
      '--network',
      'none',
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock',
      '--label',
      'shipshape.role=sbom',
      policy.security.syft_image,
      `docker:${imageId.replace(/^sha256:/, '')}`,
      '-o',
      'syft-json',
      '-q',
    ],
    { timeout: 15 * 60_000 },
  )
  const now = new Date().toISOString()
  if (r.exitCode !== 0 || r.timedOut) {
    const error = r.timedOut
      ? 'syft timed out'
      : r.exitCode === 137
        ? 'syft ran out of memory'
        : (r.stderr.trim().split('\n').at(-1) || `syft exited ${r.exitCode}`).slice(0, 300)
    db.prepare(
      `INSERT INTO sbom_images (image_id, ref, scanned_at, error, packages, attempts) VALUES (?, ?, ?, ?, 0, 1)
       ON CONFLICT(image_id) DO UPDATE SET scanned_at = excluded.scanned_at, error = excluded.error,
         attempts = sbom_images.attempts + 1`,
    ).run(imageId, ref, now, error)
    logEvent({ level: 'warn', kind: 'scan', message: 'security: could not inventory an image', detail: `${ref ?? imageId}: ${error}` })
    return false
  }
  let pkgs: Package[]
  try {
    pkgs = packagesOf(JSON.parse(r.stdout) as SyftJson)
  } catch {
    db.prepare(
      `INSERT INTO sbom_images (image_id, ref, scanned_at, error, packages, attempts) VALUES (?, ?, ?, 'unreadable syft output', 0, 1)
       ON CONFLICT(image_id) DO UPDATE SET scanned_at = excluded.scanned_at, error = excluded.error,
         attempts = sbom_images.attempts + 1`,
    ).run(imageId, ref, now)
    return false
  }
  const ins = db.prepare(`INSERT INTO sbom_packages (image_id, type, name, version, path) VALUES (?, ?, ?, ?, ?)`)
  db.transaction(() => {
    db.prepare(`DELETE FROM sbom_packages WHERE image_id = ?`).run(imageId)
    db.prepare(
      `INSERT INTO sbom_images (image_id, ref, scanned_at, error, packages, attempts) VALUES (?, ?, ?, NULL, ?, 0)
       ON CONFLICT(image_id) DO UPDATE SET ref = excluded.ref, scanned_at = excluded.scanned_at, error = NULL,
         packages = excluded.packages, attempts = 0`,
    ).run(imageId, ref, now, pkgs.length)
    for (const p of pkgs) ins.run(imageId, p.type, p.name, p.version, p.path ?? null)
  })()
  logEvent({
    level: 'info',
    kind: 'scan',
    message: 'security: image inventoried',
    detail: `${ref ?? imageId}: ${pkgs.length} packages in ${Math.round((Date.now() - started) / 1000)}s`,
  })
  return true
}

/**
 * Pull the image an update would bring in, and return its local id.
 *
 * Only ever asked for services that are exposed, so the pull is spent on something that
 * matters -- and a merge would pull the same image anyway.
 */
export async function pullCandidate(ref: string, exec: Exec = run): Promise<{ imageId: string } | { error: string }> {
  const pull = await exec('docker', ['pull', '-q', ref], { timeout: 15 * 60_000 })
  if (pull.exitCode !== 0) return { error: (pull.stderr.trim().split('\n').at(-1) ?? 'docker pull failed').slice(0, 300) }
  const insp = await exec('docker', ['image', 'inspect', '--format', '{{.Id}}', ref])
  if (insp.exitCode !== 0) return { error: 'pulled, but docker could not inspect it' }
  return { imageId: insp.stdout.trim() }
}

/** Inventories nothing references any more: not running, not a candidate. */
export function pruneInventories(): number {
  const db = getDb()
  return db
    .prepare(
      `DELETE FROM sbom_images WHERE image_id NOT IN (SELECT image_id FROM security_running)
         AND image_id NOT IN (SELECT image_id FROM security_candidates WHERE image_id IS NOT NULL)
         AND scanned_at < ?`,
    )
    .run(new Date(Date.now() - 14 * 24 * 60 * 60_000).toISOString()).changes
}
