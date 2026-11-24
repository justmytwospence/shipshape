import type { Policy } from '../policy-schema.ts'
import type { ServiceObservation, ServiceSnapshot } from './probe.ts'
import type { Verdict } from './verify.ts'
import type { LeftService, RecordedPlan } from './runstate.ts'

export interface DeployTarget {
  stack: string
  services: string[]
  /** `rm-first` when any service asked for it. */
  strategy: 'up' | 'rm-first'
  /**
   * Pull before bringing it up. Only a rolling tag needs this: `up -d` reuses the image
   * it already has, so re-deploying `latest` without a pull brings up the same bits and
   * reports success -- which for a moved rolling tag is the one thing it must not do.
   */
  pull?: boolean
  /**
   * Services built from source before `up`: the forks (the forks guide). Their `image:` is a
   * local name compose cannot pull, so the pull passes `--ignore-buildable` and an explicit
   * `compose build` runs first -- a failed build then touches no container and is reported
   * as a deploy failure. Resolved from the compose file when absent (`deployChange`); a
   * rollback passes an empty list, because the image it puts back is already on disk.
   */
  build?: string[]
}

/**
 * `phase` exists because the alert text depends on it and nothing else can recover it.
 * An `up` that fails after `rm -sf` leaves the service DOWN, and so does a plain `up` that
 * fails once compose has recreated -- which is why a failed `up` also carries what docker
 * says is there afterwards (see `downAfter`). Reporting every failed `up` as "the service
 * is running whatever it was" was false in exactly the case that needed the operator out
 * of bed.
 *
 * `inspect` comes before either: docker could not be asked what is there, so the deploy
 * stopped before its first command and nothing on the host was touched. `pull` comes after
 * the read and before any removal, so a pull that fails has removed nothing, whatever the
 * strategy -- reported as `up` it read as DOWN under rm-first, about a service still running.
 */
export type DeployPhase = 'refused' | 'inspect' | 'pull' | 'build' | 'rm' | 'up' | 'verify'

/**
 * What a deploy did.
 *
 * `ok` means shipshape did what it set out to: it may have brought nothing up, when
 * nothing was running, and then `healthy` is false and `up` is empty -- a truthful no-op,
 * not a failure. `up`, `left` and `restored` are the two halves of a group that was only
 * partly running, and `notes` are the sentences that explain the left half. `plan` is what
 * was written to `deploys.snapshot` before the first command; a failure carries it only
 * once it exists, which is after the read and the pull. A pull that fails has a plan in
 * memory but nothing recorded, so it carries `up` alone: what it meant to bring up, which
 * is all the alert may name or hand back as a command. A compose `up` that fails carries
 * `after`: each service it meant to bring up, as docker read it once compose had given up
 * (`unknown` when docker could not say).
 */
export type DeployOutcome =
  | {
      ok: true
      healthy: boolean
      detail: string
      verdict?: Verdict
      up: string[]
      left: LeftService[]
      restored: string[]
      notes: string[]
      plan: RecordedPlan
    }
  | {
      ok: false
      phase: DeployPhase
      reason: string
      stderr?: string
      plan?: RecordedPlan
      up?: string[]
      after?: { service: string; state: string }[]
      /**
       * `orphan` when docker answered and the answer was another project's container. It
       * fails in `inspect` like an unreadable docker, and nothing was touched either way,
       * but waiting does not fix it: someone has to move that container.
       */
      cause?: 'orphan'
      /** The other project's container, by name, for `cause: 'orphan'`. */
      container?: string
    }

/**
 * Everything a deploy asks of the outside world, in one seam.
 *
 * The promises that matter are about what is *not* run -- no compose at all when nothing
 * is running, the plan recorded before the first command, `--no-deps` on the running
 * subset only -- and those can only be asserted against a docker that records what it was
 * asked. `realIo` is the one that talks to the host.
 */
export interface DeployIo {
  /** Strict: throws `DockerUnreadable` rather than reading a failure as no container. */
  observe(project: string, service: string): Promise<ServiceObservation>
  /** A container of this service from another compose project, described; null when none. */
  foreign(project: string, stack: string, service: string): Promise<string | null>
  exec(args: string[], opts: { cwd: string; timeout: number }): Promise<{ exitCode?: number; stderr?: unknown }>
  verify(
    target: DeployTarget,
    project: string,
    snapshot: ServiceSnapshot[],
    policy: Policy,
    pinned: Map<string, string | null>,
  ): Promise<Verdict>
  peers(stack: string): { service: string; network_mode: string | null }[]
  /** What the compose file pins now, per service of the stack. */
  pinned(stack: string, policy: Policy): Map<string, string | null>
  /** Which of these services the compose file builds from source now (forks, base-watched builds). */
  buildable(stack: string, services: string[], policy: Policy): string[]
  /**
   * Which of these a rollback must rebuild: the builds watched through their base image,
   * whose local image name does not change with the base. Absent means none.
   */
  rebuildable?(stack: string, services: string[], policy: Policy): string[]
  now(): number
}
