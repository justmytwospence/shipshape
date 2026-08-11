import { execa } from 'execa'
import { basename } from 'node:path'
import { env } from '../config.ts'

/**
 * Reading what Docker actually thinks, rather than what its output columns say.
 *
 * The old check ran `docker ps` and string-matched the human-readable Status column for
 * the words `unhealthy` and `health: starting`. That worked, mostly, and hid three
 * problems. It could not see a restart count, so a container looping every two seconds
 * looked identical to one that had been up all along. It could not see the image, so a
 * deploy that silently failed to recreate anything still read as success -- which is how
 * a stale image sat in this lab long enough for its next restart to break it. And it
 * filtered on the service name alone, without the compose project, so two stacks with a
 * service called `db` would have verified each other's containers. No collision exists
 * today across 149 services; the filter should not depend on that staying true.
 *
 * `docker inspect` answers all three, as structured fields, for the same one call.
 */

export interface ServiceObservation {
  service: string
  found: boolean
  id: string | null
  /** created | running | restarting | exited | paused | dead | removing */
  state: string
  exitCode: number | null
  restartCount: number
  restartPolicy: string
  /** none when the image declares no healthcheck -- unknown, never "unhealthy". */
  health: 'none' | 'starting' | 'healthy' | 'unhealthy'
  /** The last few healthcheck outputs. Free diagnosis nobody was reading. */
  healthLog: string[]
  /** What the container was created from, e.g. `nginx:1.2.3`. */
  imageRef: string | null
  /** The resolved digest, which is what makes a rollback target unambiguous. */
  imageId: string | null
  startedAt: string | null
  /** Container IP per network, for probing the service directly. */
  ips: Record<string, string>
}

/**
 * The compose project a stack's containers carry.
 *
 * Compose derives it from the directory holding the file, so a stack directory is its
 * own project -- except the root compose file, whose project is the repository directory
 * itself. Both are normalised the way compose normalises them.
 */
export function projectName(stack: string, repoDir = env.repoDir): string {
  const raw = stack === 'root' ? basename(repoDir) : stack
  return raw.toLowerCase().replace(/[^a-z0-9_-]/g, '')
}

/** Pull the fields that matter out of one `docker inspect` object. */
export function parseInspect(service: string, raw: unknown): ServiceObservation {
  const c = raw as {
    Id?: string
    State?: {
      Status?: string
      ExitCode?: number
      Restarting?: boolean
      StartedAt?: string
      Health?: { Status?: string; Log?: { ExitCode?: number; Output?: string }[] }
    }
    Config?: { Image?: string }
    Image?: string
    HostConfig?: { RestartPolicy?: { Name?: string } }
    NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> }
    RestartCount?: number
  }

  const hs = c.State?.Health?.Status
  const health: ServiceObservation['health'] =
    hs === 'healthy' ? 'healthy' : hs === 'unhealthy' ? 'unhealthy' : hs === 'starting' ? 'starting' : 'none'

  const ips: Record<string, string> = {}
  for (const [net, cfg] of Object.entries(c.NetworkSettings?.Networks ?? {})) {
    if (cfg?.IPAddress) ips[net] = cfg.IPAddress
  }

  return {
    service,
    found: true,
    id: c.Id ?? null,
    state: c.State?.Status ?? 'unknown',
    exitCode: c.State?.ExitCode ?? null,
    restartCount: c.RestartCount ?? 0,
    restartPolicy: c.HostConfig?.RestartPolicy?.Name ?? '',
    health,
    healthLog: (c.State?.Health?.Log ?? [])
      .map((l) => (l.Output ?? '').trim())
      .filter(Boolean)
      .slice(-3),
    imageRef: c.Config?.Image ?? null,
    imageId: c.Image ?? null,
    startedAt: c.State?.StartedAt ?? null,
    ips,
  }
}

/** The observation for a container that is not there at all. */
export function missing(service: string): ServiceObservation {
  return {
    service,
    found: false,
    id: null,
    state: 'absent',
    exitCode: null,
    restartCount: 0,
    restartPolicy: '',
    health: 'none',
    healthLog: [],
    imageRef: null,
    imageId: null,
    startedAt: null,
    ips: {},
  }
}

/** Look one service up, scoped to its compose project so no other stack can answer. */
export async function inspectService(
  project: string,
  service: string,
): Promise<ServiceObservation> {
  const ps = await execa(
    'docker',
    [
      'ps',
      '--all',
      '--filter',
      `label=com.docker.compose.project=${project}`,
      '--filter',
      `label=com.docker.compose.service=${service}`,
      '--format',
      '{{.ID}}',
    ],
    { reject: false, timeout: 20_000 },
  )
  const id = String(ps.stdout ?? '').split('\n').find((l) => l.trim())
  if (!id) return missing(service)

  const ins = await execa('docker', ['inspect', id], { reject: false, timeout: 20_000 })
  if ((ins.exitCode ?? 1) !== 0) return missing(service)
  try {
    const arr = JSON.parse(String(ins.stdout)) as unknown[]
    if (!arr[0]) return missing(service)
    return parseInspect(service, arr[0])
  } catch {
    return missing(service)
  }
}

export interface ServiceSnapshot {
  service: string
  imageRef: string | null
  imageId: string | null
  restartCount: number
  hadHealthcheck: boolean
  running: boolean
}

/**
 * What was running before the deploy.
 *
 * Recorded rather than recomputed because by the time a deploy has failed, the thing it
 * replaced is already gone -- this is the previous-good state every rollback design in
 * the survey keeps somewhere, and the baseline the restart counter is measured against.
 */
export async function snapshotTarget(
  project: string,
  services: string[],
): Promise<ServiceSnapshot[]> {
  const obs = await Promise.all(services.map((s) => inspectService(project, s)))
  return obs.map((o) => ({
    service: o.service,
    imageRef: o.imageRef,
    imageId: o.imageId,
    restartCount: o.restartCount,
    hadHealthcheck: o.health !== 'none',
    running: o.state === 'running',
  }))
}

/** Container logs since the deploy began, bounded — the diagnosis nobody was collecting. */
export async function captureLogs(id: string, sinceISO: string, tail = 80): Promise<string> {
  const r = await execa('docker', ['logs', '--since', sinceISO, '--tail', String(tail), id], {
    reject: false,
    timeout: 20_000,
    all: true,
  })
  return String(r.all ?? r.stdout ?? '').slice(-4000)
}

export type ProbeResult = { status: number } | { error: string }

/**
 * Ask the service directly, on the port it already told traefik about.
 *
 * Directly, not through traefik: the forward-auth in front of nearly every router would
 * answer 302 for a service that is on fire, and a probe loop through the public entry
 * point eventually earns a rate-limit ban. The container's own address on the shared
 * network has neither problem.
 */
export async function httpProbe(ip: string, port: number, path = '/', timeoutMs = 5000): Promise<ProbeResult> {
  const ctl = AbortSignal.timeout(timeoutMs)
  try {
    const res = await fetch(`http://${ip}:${port}${path}`, { redirect: 'manual', signal: ctl })
    return { status: res.status }
  } catch (err) {
    return { error: (err as Error).message.slice(0, 120) }
  }
}
