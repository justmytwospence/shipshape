import { execa } from 'execa'
import { basename } from 'node:path'
import { env } from '../config.ts'
import { includedStacks } from '../compose/scan.ts'

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
  // An included stack's containers carry the root project's name, so looking for them
  // under their own would find nothing and the verifier would report "no container"
  // for a service that is running perfectly well.
  const root = stack === 'root' || includedStacks(repoDir).has(stack)
  const raw = root ? basename(repoDir) : stack
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

/**
 * Docker could not be asked -- as opposed to Docker answering that there is nothing there.
 *
 * The two used to be one value. A `docker ps` that failed -- no permission on the
 * socket, a daemon restarting underneath it, a call that never came back -- produced an
 * empty list, and an empty list read as `absent`. The verifier treats a persistent
 * absence as a hard failure, so a verifier that could not see anything reported "no
 * container" ten seconds in, failed a deploy that had worked, and reverted main. The
 * soak made the same mistake more quietly and alerted "degraded" on a socket error.
 *
 * So not being able to ask is its own answer, thrown rather than returned, and every
 * caller has to decide what blindness means for it instead of inheriting a guess.
 */
export class DockerUnreadable extends Error {
  override name = 'DockerUnreadable'
}

/** The parts of a finished docker invocation this module reads. Shaped like execa's result. */
export interface ExecResult {
  exitCode?: number
  stdout?: unknown
  stderr?: unknown
  timedOut?: boolean
}

/** One docker invocation. Injected, so every reading below is testable with no daemon. */
export type DockerExec = (args: string[]) => Promise<ExecResult>

export const dockerExec: DockerExec = (args) =>
  execa('docker', args, { reject: false, timeout: 20_000 })

/** The line of stderr that says what went wrong; docker puts it last. */
function lastLine(s: unknown): string {
  const lines = String(s ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return (lines.at(-1) ?? '').slice(0, 200)
}

/**
 * The container ids `docker ps` listed, or a throw when it could not list them.
 *
 * An empty list is only an answer when the exit code says docker gave one.
 */
export function readPs(r: ExecResult): string[] {
  if (r.timedOut) throw new DockerUnreadable(lastLine(r.stderr) || 'docker ps did not answer')
  if ((r.exitCode ?? 1) !== 0) throw new DockerUnreadable(lastLine(r.stderr) || 'docker ps failed')
  return String(r.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

/**
 * What `docker inspect` said about these containers: their observations, `'gone'` when
 * docker says they no longer exist, or a throw when docker could not be read.
 *
 * The exit code is read before stdout, and that order is the point. `docker inspect`
 * prints `[]` on stdout even when it cannot connect to the daemon at all, so stdout is
 * never trusted without the exit code -- an empty array on its own is evidence of
 * nothing. "No such object" is the one failure that is an answer: the container was
 * removed between `ps` and `inspect`.
 */
export function readInspect(service: string, r: ExecResult): ServiceObservation[] | 'gone' {
  if (r.timedOut) throw new DockerUnreadable(lastLine(r.stderr) || 'docker inspect did not answer')
  if ((r.exitCode ?? 1) !== 0) {
    if (/No such object/i.test(String(r.stderr ?? ''))) return 'gone'
    throw new DockerUnreadable(lastLine(r.stderr) || 'docker inspect failed')
  }

  let raw: unknown
  try {
    raw = JSON.parse(String(r.stdout ?? ''))
  } catch {
    throw new DockerUnreadable('docker inspect returned something unreadable')
  }
  if (!Array.isArray(raw) || raw.some((c) => typeof c !== 'object' || c === null)) {
    throw new DockerUnreadable('docker inspect returned something unreadable')
  }
  if (raw.length === 0) return 'gone'

  const obs = raw.map((c) => parseInspect(service, c))
  // A container with no State.Status has told us nothing about whether it is running,
  // and every reader downstream would have to guess. Guessing is what this replaces.
  if (obs.some((o) => o.state === 'unknown')) {
    throw new DockerUnreadable(`docker inspect gave no state for ${service}`)
  }
  return obs
}

/** Docker's states, most alive first. Anything unlisted ranks below all of them. */
const ALIVE = ['running', 'restarting', 'paused', 'created', 'exited', 'dead', 'removing']

/**
 * The one container that speaks for a service when several carry its labels.
 *
 * Compose can leave more than one: a scaled service, or a recreate interrupted between
 * creating the new container and removing the old. Reading only the first id `ps` listed
 * let whichever happened to come first answer for all of them, so a leftover corpse
 * could report a running service as exited. The most alive one wins; among equals, the
 * first listed.
 */
export function primary(obs: ServiceObservation[]): ServiceObservation {
  const rank = (state: string): number => {
    const i = ALIVE.indexOf(state)
    return i === -1 ? ALIVE.length : i
  }
  let best = obs[0]
  if (!best) throw new Error('primary() needs at least one observation')
  for (const o of obs) if (rank(o.state) < rank(best.state)) best = o
  return best
}

/**
 * Look one service up, scoped to its compose project so no other stack can answer.
 *
 * Strict about "docker says there is no container" versus "docker could not be asked",
 * because the two lead to opposite actions. This used to return `missing` for both -- a
 * failed `ps`, a failed `inspect`, output it could not parse -- and `absent` is a hard
 * failure to the verifier: a verifier blinded by a socket permission or a restarting
 * daemon failed deploys that had worked, and the rollback that followed reverted main.
 * Now only docker's own answer is `absent`; anything else throws `DockerUnreadable`, and
 * the caller decides what to do knowing it could not see.
 */
export async function inspectService(
  project: string,
  service: string,
  exec: DockerExec = dockerExec,
): Promise<ServiceObservation> {
  const ps = async (): Promise<string[]> =>
    readPs(
      await exec([
        'ps',
        '--all',
        '--filter',
        `label=com.docker.compose.project=${project}`,
        '--filter',
        `label=com.docker.compose.service=${service}`,
        '--format',
        '{{.ID}}',
      ]),
    )

  let ids = await ps()
  if (ids.length === 0) return missing(service)

  let found = readInspect(service, await exec(['inspect', ...ids]))
  if (found === 'gone') {
    // Removed between the two calls -- compose recreating it, or an `rm -sf` mid-deploy.
    // Ask once more, so a container caught mid-replacement is read as its replacement
    // rather than as nothing. Gone twice running is an answer.
    ids = await ps()
    if (ids.length === 0) return missing(service)
    found = readInspect(service, await exec(['inspect', ...ids]))
    if (found === 'gone') return missing(service)
  }
  return primary(found)
}

export interface ServiceSnapshot {
  service: string
  imageRef: string | null
  imageId: string | null
  restartCount: number
  hadHealthcheck: boolean
  /** Running or restarting: either way the restart policy is still trying to run it. */
  running: boolean
  /** The docker state it was read in; `absent` when docker listed no container. */
  state: string
  restartPolicy: string
}

/** The part of an observation worth keeping once the container it describes may be gone. */
export function snapshotOf(o: ServiceObservation): ServiceSnapshot {
  return {
    service: o.service,
    imageRef: o.imageRef,
    imageId: o.imageId,
    restartCount: o.restartCount,
    hadHealthcheck: o.health !== 'none',
    running: o.state === 'running' || o.state === 'restarting',
    state: o.state,
    restartPolicy: o.restartPolicy,
  }
}

/**
 * What was running before the deploy.
 *
 * Recorded rather than recomputed because by the time a deploy has failed, the thing it
 * replaced is already gone -- this is the previous-good state every rollback design in
 * the survey keeps somewhere, and the baseline the restart counter is measured against.
 *
 * Throws `DockerUnreadable` rather than recording a guess: a baseline that says "absent"
 * because docker could not be asked is false, and the deploy built on it would be too.
 */
export async function snapshotTarget(
  project: string,
  services: string[],
): Promise<ServiceSnapshot[]> {
  const obs = await Promise.all(services.map((s) => inspectService(project, s)))
  return obs.map(snapshotOf)
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
