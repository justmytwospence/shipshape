import { DockerUnreadable, missing, type ServiceObservation } from '../../src/deploy/probe.ts'
import type { DeployIo } from '../../src/deploy/run.ts'

/**
 * A docker that records what it was asked, for tests of what a deploy runs.
 *
 * The promises worth asserting are about commands that must *not* happen -- no compose at
 * all when nothing is running, nothing before the plan is recorded -- and only a fake that
 * writes every call down can show an absence. Nothing here reaches a daemon.
 *
 * Import it dynamically, after the test has set its environment: probe.ts loads config.ts,
 * which reads the environment once, at import.
 */

/**
 * How a service reads: a docker state (`absent` is no container, `unreadable` throws
 * `DockerUnreadable`), or an observation's fields. A list is one entry per look, the last
 * repeating, for a service that changes while a deploy is waiting on a pull.
 */
export type Seen = string | Partial<ServiceObservation>

export const obs = (service: string, over: Partial<ServiceObservation> = {}): ServiceObservation => ({
  service,
  found: true,
  id: `${service}-1`,
  state: 'running',
  exitCode: null,
  restartCount: 0,
  restartPolicy: 'unless-stopped',
  health: 'none',
  healthLog: [],
  imageRef: null,
  imageId: null,
  startedAt: null,
  ips: {},
  ...over,
})

export interface FakeIo extends DeployIo {
  /** Every call, in order: `observe <svc>`, `foreign <svc>`, the docker args joined, `verify <svcs>`. */
  calls: string[]
}

export function fakeIo(
  states: Record<string, Seen | Seen[]>,
  over: Partial<Omit<DeployIo, 'exec'>> & {
    /** Exit code for a docker command, by its joined text. 0 unless it says otherwise. */
    exitCode?: (command: string) => number
  } = {},
): FakeIo {
  const calls: string[] = []
  const looks = new Map<string, number>()
  const { exitCode, ...rest } = over
  return {
    calls,
    observe: async (_project, service) => {
      calls.push(`observe ${service}`)
      const n = looks.get(service) ?? 0
      looks.set(service, n + 1)
      const entry = states[service]
      const s = Array.isArray(entry) ? entry[Math.min(n, entry.length - 1)] : entry
      if (s === undefined || s === 'absent') return missing(service)
      if (s === 'unreadable') {
        throw new DockerUnreadable(
          'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock',
        )
      }
      return typeof s === 'string' ? obs(service, { state: s }) : obs(service, s)
    },
    foreign: async (_project, _stack, service) => {
      calls.push(`foreign ${service}`)
      return null
    },
    exec: async (args) => {
      const command = args.join(' ')
      calls.push(command)
      const code = exitCode?.(command) ?? 0
      return { exitCode: code, stderr: code === 0 ? '' : 'Error response from daemon: it did not work' }
    },
    verify: async (target) => {
      calls.push(`verify ${target.services.join(' ')}`)
      return { kind: 'passed', detail: `${target.services.join(', ')} settled` }
    },
    peers: () => [],
    pinned: () => new Map(),
    now: () => Date.parse('2026-09-14T09:02:00.000Z'),
    ...rest,
  }
}

/** Just the docker commands, which is what a test of "nothing was touched" reads. */
export const composeCalls = (calls: string[]): string[] => calls.filter((c) => c.startsWith('compose'))
