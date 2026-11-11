import { createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { execa } from 'execa'
import { env, loadPolicy, type Policy } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { dockerEnvOptions } from '../deploy/docker-env.ts'
import { isRootStack } from '../deploy/run.ts'
import { runOffsite, type Fetch } from './offsite.ts'

/**
 * Restore points: a dump taken before a stateful service is updated.
 *
 * What gets dumped is the service's own `shipshape.snapshot` label -- a command that
 * prints a dump to stdout, run inside its container (`pg_dump -U app app`). Shipshape
 * gzips the output to `DATA_DIR/restore-points/<stack>/` and keeps the newest few. An
 * offsite copy can be requested too (./offsite.ts); it never blocks.
 *
 * Restoring stays manual on purpose: putting data back blindly loses whatever was written
 * after the dump. A card that mentions a restore point names the file, and the person
 * decides.
 */

export interface RestoreIo {
  /** The running container for a service, or null when it is not running. */
  containerId(stack: string, service: string): Promise<string | null>
  /** Run `command` in the container and write its gzipped stdout to `path`. */
  dump(container: string, command: string, path: string): Promise<{ ok: true; bytes: number } | { ok: false; reason: string }>
  now(): Date
  fetch?: Fetch
}

const DUMP_TIMEOUT_MS = 15 * 60_000

export const realRestoreIo: RestoreIo = {
  async containerId(stack, service) {
    const args = isRootStack(stack)
      ? ['compose', 'ps', '-q', service]
      : ['compose', '-f', `${stack}/docker-compose.yaml`, 'ps', '-q', service]
    const r = await execa('docker', args, { cwd: env.repoDir, reject: false, timeout: 30_000, ...dockerEnvOptions() })
    const id = String(r.stdout ?? '').trim().split('\n')[0]
    return r.exitCode === 0 && id ? id : null
  },

  async dump(container, command, path) {
    mkdirSync(dirname(path), { recursive: true })
    let bytes = 0
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        bytes += chunk.length
        cb(null, chunk)
      },
    })
    const sub = execa('docker', ['exec', container, '/bin/sh', '-c', command], {
      buffer: { stdout: false, stderr: true },
      reject: false,
      timeout: DUMP_TIMEOUT_MS,
      ...dockerEnvOptions(),
    })
    try {
      await pipeline(sub.stdout!, counter, createGzip(), createWriteStream(path))
    } catch (err) {
      sub.kill()
      rmSync(path, { force: true })
      return { ok: false, reason: (err as Error).message.slice(0, 200) }
    }
    const r = await sub
    if (r.exitCode !== 0 || bytes === 0) {
      rmSync(path, { force: true })
      const why = r.exitCode !== 0 ? `exit ${r.exitCode}: ${String(r.stderr ?? '').trim().slice(-160)}` : 'the dump was empty'
      return { ok: false, reason: why }
    }
    return { ok: true, bytes: statSync(path).size }
  },

  now: () => new Date(),
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

export type RestoreResult =
  | { ok: true; points: { service: string; path: string; bytes: number }[] }
  | { ok: false; reason: string }

/** Whether anything in this stack can be dumped. */
export function stackHasSnapshot(stack: string): boolean {
  return !!getDb().prepare(`SELECT 1 FROM images WHERE stack = ? AND snapshot_label IS NOT NULL LIMIT 1`).get(stack)
}

/** The newest restore points for a change, for a card to name. */
export function restorePointsFor(prId: number): { service: string; path: string; created_at: string }[] {
  return getDb()
    .prepare(`SELECT service, path, created_at FROM restore_points WHERE pr_id = ? ORDER BY id`)
    .all(prId) as { service: string; path: string; created_at: string }[]
}

export async function takeRestorePoint(
  stack: string,
  prId?: number,
  io: RestoreIo = realRestoreIo,
  policy: Policy = loadPolicy().policy,
): Promise<RestoreResult> {
  const db = getDb()
  const services = db
    .prepare(`SELECT service, snapshot_label, backup_job_label FROM images WHERE stack = ? AND snapshot_label IS NOT NULL ORDER BY service`)
    .all(stack) as { service: string; snapshot_label: string; backup_job_label: string | null }[]

  const points: { service: string; path: string; bytes: number; id: number }[] = []
  for (const s of services) {
    const container = await io.containerId(stack, s.service)
    // Not running: nothing to dump, and a deploy leaves a stopped service stopped anyway.
    if (!container) continue
    const path = join(env.dataDir, 'restore-points', stack, `${s.service}-${stamp(io.now())}.gz`)
    const r = await io.dump(container, s.snapshot_label, path)
    if (!r.ok) {
      for (const p of points) rmSync(p.path, { force: true })
      for (const p of points) db.prepare(`DELETE FROM restore_points WHERE id = ?`).run(p.id)
      logEvent({
        level: 'warn',
        kind: 'deploy',
        stack,
        service: s.service,
        message: 'restore point failed',
        detail: r.reason,
      })
      return { ok: false, reason: `the restore point for ${s.service} failed: ${r.reason}` }
    }
    const info = db
      .prepare(`INSERT INTO restore_points (stack, service, path, bytes, pr_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(stack, s.service, path, r.bytes, prId ?? null, io.now().toISOString())
    points.push({ service: s.service, path, bytes: r.bytes, id: Number(info.lastInsertRowid) })
    prune(stack, s.service, policy.restore_points.keep)
  }

  const cfg = policy.restore_points.offsite
  if (cfg && points.length > 0) {
    const label = services.find((s) => s.backup_job_label)?.backup_job_label ?? null
    const res = await runOffsite(stack, label, cfg, io.fetch)
    for (const p of points) {
      db.prepare(`UPDATE restore_points SET offsite_status = ?, offsite_detail = ? WHERE id = ?`).run(res.status, res.detail, p.id)
    }
    if (res.status === 'error') {
      logEvent({ level: 'warn', kind: 'deploy', stack, message: 'offsite backup not taken', detail: res.detail })
    }
  }

  logEvent({
    level: 'info',
    kind: 'deploy',
    stack,
    message: `restore point taken for ${points.map((p) => p.service).join(', ') || 'nothing running'}`,
  })
  return { ok: true, points: points.map(({ service, path, bytes }) => ({ service, path, bytes })) }
}

/** Keep the newest `keep` restore points per service; delete the rest, files and rows. */
function prune(stack: string, service: string, keep: number): void {
  const db = getDb()
  const old = db
    .prepare(`SELECT id, path FROM restore_points WHERE stack = ? AND service = ? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?`)
    .all(stack, service, keep) as { id: number; path: string }[]
  for (const o of old) {
    rmSync(o.path, { force: true })
    db.prepare(`DELETE FROM restore_points WHERE id = ?`).run(o.id)
  }
}
