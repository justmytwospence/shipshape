import { execa } from 'execa'
import { join } from 'node:path'
import { env, inBlackout, loadPolicy, type Policy } from '../config.ts'
import {
  DockerUnreadable,
  findForeign,
  httpProbe,
  inspectService,
  missing,
  projectName,
  snapshotOf,
  type ServiceObservation,
  type ServiceSnapshot,
} from './probe.ts'
import { includedStacks, scanRepo } from '../compose/scan.ts'
import { DEFAULT_VERIFY, runVerify, type Verdict } from './verify.ts'
import { getDb, logEvent } from '../db.ts'
import { notify } from '../notify/index.ts'
import {
  countsAsRunning,
  leftClause,
  observeSet,
  ownerFrom,
  planRun,
  restoredClause,
  type LeftService,
  type RecordedPlan,
  type RunPlan,
} from './runstate.ts'

/**
 * Bringing a merged change up on the host.
 *
 * A change is not done when it is committed; it is done when it is running. Everything
 * before this point only rearranged text.
 *
 * Five things make this narrower than "run compose and hope":
 *
 * 1. **It must never deploy itself.** `docker compose up -d shipshape` replaces the
 *    container running this code, killing the process mid-command -- so the deploy
 *    reports nothing, the database records nothing, and the operator learns about it
 *    from a gap in the log. Excluded unconditionally, not by policy.
 *
 * 2. **Infrastructure comes up from the repository root.** Services in the root compose
 *    file depend on networks that file defines; running their directory's own compose
 *    fails with "refers to undefined network". They are addressed by service name from
 *    the root instead.
 *
 * 3. **An image bump does not re-read image-provided environment.** `up -d` clones the
 *    running container's config, so a variable baked into the old image survives into
 *    the new one and can point at a file that no longer exists. `shipshape.deploy:
 *    rm-first` forces the remove-then-create that re-reads it.
 *
 * 4. **A deploy that starts is not a deploy that worked.** Compose exits 0 as soon as
 *    the container is created; a service that crash-loops thirty seconds later still
 *    looks like success. Health is checked afterwards, and a failure is loud.
 *
 * 5. **It never changes whether a service is running.** Every shipshape verb chooses a
 *    version; none of them means "start my service". So each service is read from docker
 *    immediately before acting: one that is running is brought up on the new version and
 *    verified, and one that is stopped, paused or has no container is left exactly as it
 *    was -- no create, no pull, no start, no rm -- and the outcome says what compose and
 *    `docker start` would each bring back. A docker that cannot be asked fails the deploy
 *    before its first command, because guessing either way changes state. The table,
 *    and the one exception for shipshape's own failed attempts, are in runstate.ts.
 */

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
export type DeployPhase = 'refused' | 'inspect' | 'pull' | 'rm' | 'up' | 'verify'

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
  now(): number
}

export const realIo: DeployIo = {
  observe: (project, service) => inspectService(project, service),
  foreign: (project, stack, service) => findForeign(project, stack, service),
  exec: (args, opts) => execa('docker', args, { cwd: opts.cwd, reject: false, timeout: opts.timeout }),
  verify: (target, project, snapshot, policy, pinned) => verifyDeploy(target, project, snapshot, policy, pinned),
  peers: (stack) => stackPeers(stack),
  pinned: (stack, policy) => pinnedRefs(stack, policy),
  now: () => Date.now(),
}

/**
 * Stacks that are part of the root compose project rather than their own.
 *
 * Either the root file itself, or one it `include:`s -- pihole, traefik, ddclient and
 * wireguard here. Both are addressed from the repository root with no `-f`, because
 * scoping to their own file loses the networks the root defines and compose refuses the
 * whole project.
 */
export function isRootStack(stack: string, repoDir = env.repoDir): boolean {
  return stack === 'root' || includedStacks(repoDir).has(stack)
}

/**
 * `compose up` for exactly the services a deploy means, and nothing they depend on.
 *
 * `--no-deps` is always there because `up -d svc` on its own reaches past `svc`: it
 * starts any `depends_on` service that is stopped, and recreates any running one whose
 * section of the file has an unrelated pending edit (compose probe 3a, 3c, 3r-e). An
 * update to one service must not start a database someone stopped, or restart a sibling
 * on a change nobody merged. So everything a deploy does mean is named explicitly
 * instead -- every member of a group, and the namespace followers `withNamespacePeers`
 * adds -- and compose still orders several named services correctly under the flag
 * (probe 4b).
 *
 * `manualCommand`, the pull request comment and the alert commands are all built from
 * this, so the command an operator pastes carries the flag too. `pullArgs` slices at
 * `up`, so a pull never sees it.
 */
export function composeArgs(
  target: DeployTarget,
  repoDir = env.repoDir,
): { cwd: string; args: string[] } {
  const cwd = repoDir
  // Deduped here rather than at the call site: this is the one function that turns a
  // target into a command, so it is the one place that can guarantee the executed and
  // the pasted command agree.
  const services = [...new Set(target.services)]
  if (isRootStack(target.stack, repoDir)) {
    // No -f: the root compose file is the project, and its networks are defined there.
    return { cwd, args: ['compose', 'up', '-d', '--no-deps', ...services] }
  }
  return {
    cwd,
    args: [
      'compose',
      '-f',
      `${target.stack}/docker-compose.yaml`,
      'up',
      '-d',
      '--no-deps',
      ...services,
    ],
  }
}

/**
 * `compose pull` for the same target, so the command that runs and the command the pull
 * request suggests are built by the same function rather than resembling each other.
 */
export function pullArgs(
  target: DeployTarget,
  repoDir = env.repoDir,
): { cwd: string; args: string[] } {
  const up = composeArgs(target, repoDir)
  const head = up.args.slice(0, up.args.indexOf('up'))
  return { cwd: up.cwd, args: [...head, 'pull', ...new Set(target.services)] }
}

function removeArgs(target: DeployTarget, repoDir = env.repoDir): { cwd: string; args: string[] } {
  const cwd = repoDir
  const base = isRootStack(target.stack, repoDir)
    ? ['compose']
    : ['compose', '-f', `${target.stack}/docker-compose.yaml`]
  return { cwd, args: [...base, 'rm', '-sf', ...new Set(target.services)] }
}

/**
 * Why this deploy must not run, or null when it may.
 *
 * Separated from the execution so the reasons are testable without a Docker daemon,
 * and so the dashboard can explain a held deploy without attempting one.
 */
export function refuseReason(
  target: DeployTarget,
  opts: { selfStack: string; excluded: string[]; blackout: boolean },
): string | null {
  if (target.stack === opts.selfStack) {
    return 'shipshape does not deploy itself — the container running the deploy would be replaced mid-command'
  }
  if (opts.excluded.includes(target.stack)) return `${target.stack} is an excluded stack`
  if (target.services.length === 0) return 'no services to deploy'
  if (opts.blackout) return 'inside the configured blackout window'
  return null
}

/**
 * Why a deploy stopped before its first command: docker could not say what is there.
 *
 * One sentence for every reader of docker on this path -- the target, its namespace
 * owners, the orphan check -- because to the operator they are the same failure.
 */
function unreadableReason(services: string[], err: Error): string {
  return `could not ask docker whether ${services.join(', ')} ${services.length === 1 ? 'is' : 'are'} running: ${err.message}`
}

type DeployFailure = Extract<DeployOutcome, { ok: false }>

/**
 * Bring up what is running, leave what is not, and verify what came up.
 *
 * The order is the promise. Read every service; plan; pull only what the plan brings up;
 * read and plan again, because a pull can take minutes and a service stopped meanwhile
 * must drop out; write the plan down; and only then remove or recreate anything. A
 * deploy that brings nothing up runs no compose command at all.
 *
 * `carried` names the services shipshape's own earlier attempt left down (see
 * `carriedFor`); `record` is called with the plan immediately before the first command
 * that changes anything, or before returning when nothing will.
 */
export async function deploy(
  target: DeployTarget,
  opts: {
    skipBlackout?: boolean
    carried?: ReadonlySet<string>
    record?: (p: RecordedPlan) => void
    io?: DeployIo
  } = {},
): Promise<DeployOutcome> {
  const io = opts.io ?? realIo
  const { policy } = loadPolicy()
  const refusal = refuseReason(target, {
    selfStack: env.selfStack,
    excluded: policy.exclude_stacks,
    // Restoring a known-good version is remediation, not a change: the blackout exists
    // to keep upgrades out of the small hours, not to leave a service broken until 02:30.
    blackout: opts.skipBlackout ? false : inBlackout(policy),
  })
  if (refusal) return { ok: false, phase: 'refused', reason: refusal }

  const project = projectName(target.stack)
  const services = [...new Set(target.services)]
  const ownerOf = ownerFrom(io.peers(target.stack))
  const pinned = io.pinned(target.stack, policy)
  const carried = opts.carried ?? new Set<string>()
  const started = io.now()

  // What is there now, and what that means. It cannot be recovered afterwards -- the
  // container this is about to remove is the only record of it -- and it is the plan, the
  // rollback target and the baseline the restart counter is measured against.
  const look = async (): Promise<{ seen: Map<string, ServiceObservation>; plan: RunPlan } | DeployFailure> => {
    try {
      const names = observeSet(services, ownerOf)
      const obs = await Promise.all(names.map((s) => io.observe(project, s)))
      const seen = new Map(names.map((s, n) => [s, obs[n]!]))
      for (const s of services) {
        if (seen.get(s)?.found) continue
        // No container under this project is only "no container" if no other project is
        // holding one from the same directory. A running orphan would otherwise read as
        // left stopped, which is false in the one way that matters.
        const desc = await io.foreign(project, target.stack, s)
        if (desc) {
          return {
            ok: false,
            phase: 'inspect',
            reason: `${s} has a container from ${desc}, so shipshape cannot tell whether it is this service`,
          }
        }
      }
      return { seen, plan: planRun({ services, seen, ownerOf, carried }) }
    } catch (err) {
      if (!(err instanceof DockerUnreadable)) throw err
      // A docker that cannot say what is there cannot say whether it is running, and
      // either guess changes state: starting a parked service, or leaving a running one
      // on the old version while reporting it stopped. Stop before the first command.
      return { ok: false, phase: 'inspect', reason: unreadableReason(target.services, err) }
    }
  }

  let read = await look()
  if ('ok' in read) return read

  if (target.pull && read.plan.up.length > 0) {
    // Only what will come up is pulled: a dormant service costs no Docker Hub pull. Then
    // look again, because the pull is the long wait on this path -- anything that stopped
    // during it drops out, and anything that started is pulled once more before it is
    // brought up.
    const pulled = new Set<string>()
    const pull = async (names: string[], meant: string[]): Promise<DeployFailure | null> => {
      const pu = pullArgs({ ...target, services: names })
      const p = await io.exec(pu.args, { cwd: pu.cwd, timeout: 600_000 })
      if ((p.exitCode ?? 1) !== 0) {
        return { ok: false, phase: 'pull', reason: 'could not pull the new image', stderr: tail(p.stderr), up: meant }
      }
      for (const s of names) pulled.add(s)
      return null
    }
    const first = await pull(read.plan.up, read.plan.up)
    if (first) return first
    read = await look()
    if ('ok' in read) return read
    const extra = read.plan.up.filter((s) => !pulled.has(s))
    if (extra.length > 0) {
      const again = await pull(extra, read.plan.up)
      if (again) return again
    }
  }
  const { seen, plan } = read

  const recorded: RecordedPlan = {
    v: 1,
    at: new Date(io.now()).toISOString(),
    seen: services.map((s) => snapshotOf(seen.get(s) ?? missing(s))),
    ...plan,
  }
  opts.record?.(recorded)

  const notes = [
    ...plan.restored.map(restoredClause),
    ...plan.left.map((l) => leftClause(l, pinned.get(l.service) ?? null)),
  ]

  if (plan.up.length === 0) {
    return {
      ok: true,
      healthy: false,
      up: [],
      left: plan.left,
      restored: [],
      notes,
      plan: recorded,
      detail: notes.join('; '),
    }
  }

  // From here on, only the running subset exists as far as compose is concerned: named
  // explicitly, under --no-deps, so nothing left stopped is reached through the graph.
  const upTarget: DeployTarget = { ...target, services: plan.up }

  if (target.strategy === 'rm-first') {
    const rm = removeArgs(upTarget)
    const r = await io.exec(rm.args, { cwd: rm.cwd, timeout: 120_000 })
    if ((r.exitCode ?? 1) !== 0) {
      return { ok: false, phase: 'rm', reason: 'could not remove the old container', stderr: tail(r.stderr), plan: recorded }
    }
  }

  const up = composeArgs(upTarget)
  const r = await io.exec(up.args, { cwd: up.cwd, timeout: 600_000 })
  if ((r.exitCode ?? 1) !== 0) {
    // Compose may already have destroyed the old container before it failed (see
    // `downAfter`), so what is there now is read rather than assumed. A read that fails is
    // only `unknown`: this is the path to an alert, and the alert goes out regardless.
    const after = await Promise.all(
      plan.up.map(async (s) => {
        try {
          return { service: s, state: (await io.observe(project, s)).state }
        } catch {
          return { service: s, state: 'unknown' }
        }
      }),
    )
    return { ok: false, phase: 'up', reason: 'compose failed', stderr: tail(r.stderr), plan: recorded, after }
  }

  const verdict = await io.verify(
    upTarget,
    project,
    recorded.seen.filter((s) => plan.up.includes(s.service)),
    policy,
    pinned,
  )
  const secs = Math.round((io.now() - started) / 1000)
  const names = plan.up.join(', ')
  const healthy = verdict.kind === 'passed' || verdict.kind === 'degraded'
  const also = notes.length > 0 ? `; ${notes.join('; ')}` : ''
  return {
    ok: true,
    healthy,
    verdict,
    up: plan.up,
    left: plan.left,
    restored: plan.restored,
    notes,
    plan: recorded,
    detail:
      verdict.kind === 'passed'
        ? `${names} up in ${secs}s${also}`
        : verdict.kind === 'degraded'
          ? `${names} up in ${secs}s, with warnings — ${verdict.detail}${also}`
          : `${names} — ${verdict.detail}${plan.left.length ? `; left stopped: ${plan.left.map((l) => l.service).join(', ')}` : ''}`,
  }
}

/**
 * Which ref the verifier should expect a freshly-deployed container to be running.
 *
 * The file wins, and that ordering is the entire fix. `images.image_ref` is a snapshot
 * the scan takes once a day; a deploy happens seconds after a merge, so that row still
 * holds the pre-bump tag. Comparing a correctly-updated container against it reported
 * `image-mismatch` -- a hard failure -- on every unattended deploy, which then rolled
 * back a change that had worked. The database is kept only as a fallback for a service
 * the scan can see and the file read could not.
 */
export function expectedRef(
  service: string,
  fromFile: Map<string, string | null>,
  fromDb: Map<string, string | null>,
): string | null {
  return fromFile.get(service) ?? fromDb.get(service) ?? null
}

/**
 * What the compose file pins RIGHT NOW for each service of a stack, read from disk rather
 * than from the database.
 *
 * `images.image_ref` is a snapshot taken by the last scan, and the scan runs once a day. A
 * deploy happens seconds after a merge, so that row still holds the tag from before the
 * bump -- and comparing the (correct) running container against it made every single
 * unattended deploy fail `image-mismatch` and roll back. It never showed up while
 * `paused: true`, because nothing had ever deployed unattended.
 *
 * The file is the source of truth everywhere else in shipshape, and by this point it has
 * been fast-forwarded (or reverted, for a rollback), so read it. Read once per deploy,
 * before anything runs, because two readers need it: the verifier's image check, and the
 * sentence that tells an operator which version compose would bring a left service up on.
 */
function pinnedRefs(stack: string, policy: Policy): Map<string, string | null> {
  const pinned = new Map<string, string | null>()
  try {
    // `imageRaw` is the ref exactly as written in the file, which is what `image_ref`
    // stores and what the container reports -- the three have to be the same shape or
    // the comparison is meaningless.
    for (const svc of scanRepo(env.repoDir, policy.exclude_stacks)) {
      if (svc.stack === stack) pinned.set(svc.service, svc.imageRaw ?? null)
    }
  } catch {
    // Unreadable compose files are the deploy's problem, not the verifier's. Falling
    // back to the database keeps the old behaviour rather than skipping the check, and
    // a left clause without a version says "the version in the compose file".
  }
  return pinned
}

/** Wire the pure verifier to the real docker, and to this service's declared probe port. */
async function verifyDeploy(
  target: DeployTarget,
  project: string,
  snapshot: ServiceSnapshot[],
  policy: Policy,
  pinned: Map<string, string | null>,
): Promise<Verdict> {
  const db = getDb()
  const meta = new Map(
    target.services.map((service) => {
      const row = db
        .prepare(`SELECT probe_port, image_ref FROM images WHERE stack = ? AND service = ?`)
        .get(target.stack, service) as { probe_port: number | null; image_ref: string | null } | undefined
      return [service, row ?? { probe_port: null, image_ref: null }]
    }),
  )

  const expectedImageRef = (service: string): string | null =>
    expectedRef(service, pinned, new Map([...meta].map(([k, v]) => [k, v.image_ref ?? null])))

  return runVerify(
    target.services,
    snapshot,
    { ...DEFAULT_VERIFY, windowS: policy.deploy.verify_window_s },
    {
      observe: (service) => inspectService(project, service),
      probe: async (obs) => {
        if (policy.deploy.probe !== 'auto') return undefined
        const port = meta.get(obs.service)?.probe_port
        if (!port) return undefined
        // The traefik network is where every routed service is reachable; fall back to
        // whatever address it has if this one is not on it.
        const ip = obs.ips['traefik'] ?? Object.values(obs.ips)[0]
        if (!ip) return undefined
        return httpProbe(ip, port)
      },
      expectedImageRef,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    },
  )
}

function tail(s: unknown): string {
  return String(s ?? '')
    .split('\n')
    .filter(Boolean)
    .slice(-6)
    .join('\n')
    .slice(0, 600)
}

/**
 * Services that must be recreated alongside these ones.
 *
 * `network_mode: service:x` is not a reference to a service, it is a pin to a container
 * *id*: the daemon writes `container:<id>` into the dependent's host config when it
 * starts. Recreating x gives it a new id, and the dependent is left attached to a
 * namespace that no longer exists -- still running, still listed as up, and with no
 * network at all. It is a uniquely quiet way to break a service, because every liveness
 * check still passes.
 *
 * So a deploy that touches such a container has to bring its followers with it. Pure and
 * driven off the scanned compose files, so the expansion is testable and does not depend
 * on asking a daemon what is currently pinned to what.
 */
export function withNamespacePeers(
  stack: string,
  services: string[],
  peersOf: (stack: string) => { service: string; network_mode: string | null }[],
): string[] {
  const all = peersOf(stack)
  const out = [...services]
  // One pass is enough in practice and terminates by construction: a chain of shared
  // namespaces resolves to a single owner, and compose refuses cycles.
  for (const target of services) {
    for (const row of all) {
      if (row.network_mode === `service:${target}` && !out.includes(row.service)) {
        out.push(row.service)
      }
    }
  }
  return out
}

/** The scanned peers of a stack, for the expansion above. */
export function stackPeers(stack: string): { service: string; network_mode: string | null }[] {
  return getDb()
    .prepare(`SELECT service, network_mode FROM images WHERE stack = ?`)
    .all(stack) as { service: string; network_mode: string | null }[]
}

/**
 * The command an operator runs by hand, built from the same function the automatic path
 * executes.
 *
 * It was assembled by string concatenation at the call site, which produced
 * `-f root/docker-compose.yaml` for root-stack services -- the exact invocation
 * composeArgs exists to avoid, since it fails with "refers to undefined network" -- and
 * repeated a service name when a group listed it twice. Deriving it here means the
 * pasted command and the executed one cannot drift.
 */
export function manualCommand(target: DeployTarget): string {
  const lines: string[] = []
  if (target.pull) {
    const pu = pullArgs(target)
    lines.push(`docker ${pu.args.join(' ')}`)
  }
  if (target.strategy === 'rm-first') {
    const rm = removeArgs(target)
    lines.push(`docker ${rm.args.join(' ')}`)
  }
  const up = composeArgs(target)
  lines.push(`docker ${up.args.join(' ')}`)
  return lines.join('\n')
}

/**
 * Whether a failed `up` left a service it meant to bring up not running.
 *
 * Docker's answer, read after the failure, and not the strategy's. Compose v2 recreates by
 * creating the new container, stopping and removing the old one, and only then starting the
 * new -- so a plain `up` that fails at start (a missing binary, a port already allocated, a
 * bind source that is not there) has already destroyed what was running. Probed on this
 * host, docker 26.1.4 and compose 2.27.1: "Recreated", then "OCI runtime create failed",
 * exit 1, and the one container left was `created`. The alert said "running whatever it
 * was" at priority 4.
 *
 * rm-first is DOWN unless docker says every service is running, because its removal
 * certainly ran; for a plain `up`, a read that could not be made proves nothing either way.
 */
export function downAfter(outcome: Extract<DeployOutcome, { ok: false }>, strategy: DeployTarget['strategy']): boolean {
  if (outcome.phase !== 'up') return false
  const after = outcome.after ?? []
  if (after.some((a) => a.state !== 'unknown' && !countsAsRunning(a.state))) return true
  return strategy === 'rm-first' && !(after.length > 0 && after.every((a) => countsAsRunning(a.state)))
}

/**
 * What a failed deploy left behind, in the operator's terms.
 *
 * A failed `up` is described from `downAfter`: DOWN when docker says so, a warning when it
 * could not say, and "running whatever it was" only when every service still is -- compose
 * failed before recreating anything. `inspect` never got as far as anything, whatever the
 * strategy -- the read comes before the removal -- and `pull` stopped before the removal too.
 */
export function failureState(outcome: Extract<DeployOutcome, { ok: false }>, strategy: DeployTarget['strategy']): string {
  if (outcome.phase === 'inspect') return 'Nothing was touched: shipshape does not guess whether a service is running.'
  if (outcome.phase === 'pull') return 'Nothing was removed or recreated; the service is running whatever it was.'
  if (outcome.phase === 'up') {
    if (downAfter(outcome, strategy)) {
      return strategy === 'rm-first'
        ? 'The old container was removed and the new one did not start — the service is DOWN.'
        : 'The old container was replaced and the new one did not start — the service is DOWN.'
    }
    if (outcome.after?.some((a) => a.state === 'unknown')) {
      return 'Compose may have replaced the old container before it failed — check whether the service is running.'
    }
  }
  if (outcome.phase === 'rm') {
    return 'The old container may be partly stopped; nothing was recreated.'
  }
  if (outcome.phase === 'refused') return 'Nothing was attempted.'
  return 'The change is in the checkout; the service is running whatever it was.'
}

/** Run a deploy for a merged pull request and record what happened. */
export async function deployForPr(
  prNumber: number,
  target: DeployTarget,
  deployId?: number,
  opts: { carried?: ReadonlySet<string>; io?: DeployIo } = {},
): Promise<DeployOutcome> {
  const outcome = await deploy(target, {
    carried: opts.carried,
    io: opts.io,
    // Written before the first command rather than with the result, because the reader
    // that needs it most is the one that runs after this process did not finish: a
    // reclaimed attempt, or the next deploy of a service this one left down.
    record:
      deployId !== undefined
        ? (p) => {
            getDb().prepare(`UPDATE deploys SET snapshot = ? WHERE id = ?`).run(JSON.stringify(p), deployId)
          }
        : undefined,
  })
  const now = new Date().toISOString()
  const detail = outcome.ok
    ? outcome.detail
    : `${outcome.reason}${outcome.stderr ? `\n${outcome.stderr}` : ''}`
  // Nothing brought up is its own status, not `deployed`: nothing is soaking, and nothing
  // is verified. `healthy` stays 0 for it, which is what keeps it from ever being carried.
  const status = !outcome.ok
    ? 'failed'
    : outcome.up.length === 0
      ? 'left-stopped'
      : outcome.healthy
        ? 'deployed'
        : 'failed'

  if (deployId === undefined) {
    // No queue row: a deploy asked for directly rather than by a merge. Record it as
    // finished history rather than inventing a job nobody will drain.
    getDb()
      .prepare(
        `INSERT INTO deploys (pr_number, stack, services, strategy, ok, healthy, detail,
                              status, started_at, finished_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        prNumber,
        target.stack,
        [...new Set(target.services)].join(' '),
        target.strategy,
        outcome.ok ? 1 : 0,
        outcome.ok && outcome.healthy ? 1 : 0,
        detail,
        status,
        now,
        now,
        now,
      )
  } else {
    getDb()
      .prepare(
        `UPDATE deploys SET ok = ?, healthy = ?, detail = ?, status = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(
        outcome.ok ? 1 : 0,
        outcome.ok && outcome.healthy ? 1 : 0,
        detail,
        status,
        now,
        deployId,
      )
  }

  if (!outcome.ok) {
    logEvent({
      level: 'error',
      kind: 'deploy',
      stack: target.stack,
      message: `deploy of ${target.stack} failed after #${prNumber} merged`,
      detail: `${outcome.reason}${outcome.stderr ? `\n${outcome.stderr}` : ''}`,
    })
    const down = downAfter(outcome, target.strategy)
    // Once there is a plan, the failure is about the services it meant to bring up: the
    // ones it left were never touched, and a pasted command that named them would start
    // exactly what the deploy declined to. A failed pull has that plan in memory only.
    const meant = outcome.plan?.up ?? outcome.up ?? target.services
    const named = meant.length ? meant : target.services
    // No command to paste when docker could not be asked: compose was never the problem,
    // and running it by hand while docker cannot say what is there is the very guess the
    // deploy declined to make. What fixes it is docker answering.
    const next =
      outcome.phase === 'inspect'
        ? 'Press Try again on the update once docker answers.'
        : `Retry with:\n${manualCommand({ ...target, services: meant })}`
    await notify({
      title: down
        ? `shipshape: ${target.stack} is DOWN — deploy failed`
        : `shipshape: deploy failed — ${target.stack}`,
      body: `#${prNumber} merged but ${named.join(', ')} did not deploy.\n\n${outcome.reason}\n\n${failureState(outcome, target.strategy)}\n\n${next}`,
      priority: down ? 5 : 4,
      tags: ['rotating_light'],
    })
    return outcome
  }

  if (outcome.up.length === 0) {
    // Nothing was running, so nothing was started, and nothing went wrong: an Activity
    // line, not an alert. The update reads Left stopped and the detail says what compose
    // and `docker start` would each bring back.
    logEvent({
      level: 'info',
      kind: 'deploy',
      stack: target.stack,
      message: `${target.stack} left stopped`,
      detail: outcome.detail,
    })
    return outcome
  }

  if (!outcome.healthy) {
    // Started but unhealthy is the dangerous outcome: it looks deployed and is not.
    logEvent({
      level: 'error',
      kind: 'deploy',
      stack: target.stack,
      message: `${target.stack} deployed but is not healthy`,
      detail: outcome.detail,
    })
    await notify({
      title: `shipshape: ${target.stack} unhealthy after deploy`,
      body: `#${prNumber}: ${outcome.detail}\n\nThe new image is running and failing. Roll back with git revert and redeploy if it does not recover.`,
      priority: 5,
      tags: ['rotating_light'],
    })
    return outcome
  }

  logEvent({
    level: 'info',
    kind: 'deploy',
    stack: target.stack,
    message: `${target.stack} deployed`,
    detail: outcome.detail,
  })
  return outcome
}
