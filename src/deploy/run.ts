import { execa } from 'execa'
import { join } from 'node:path'
import { env, inBlackout, loadPolicy, type Policy } from '../config.ts'
import { httpProbe, inspectService, projectName, snapshotTarget, type ServiceSnapshot } from './probe.ts'
import { includedStacks, scanRepo } from '../compose/scan.ts'
import { DEFAULT_VERIFY, runVerify, type Verdict } from './verify.ts'
import { getDb, logEvent } from '../db.ts'
import { notify } from '../notify/index.ts'

/**
 * Bringing a merged change up on the host.
 *
 * A change is not done when it is committed; it is done when it is running. Everything
 * before this point only rearranged text.
 *
 * Four things make this narrower than "run compose and hope":
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
 * A plain `up` that fails leaves the old container running; the same failure after
 * `rm -sf` leaves the service DOWN. Reporting both as "the service is running whatever
 * it was" was false in exactly the case that needed the operator out of bed.
 */
export type DeployPhase = 'refused' | 'rm' | 'up' | 'verify'

export type DeployOutcome =
  | { ok: true; healthy: boolean; detail: string; verdict?: Verdict; snapshot?: ServiceSnapshot[] }
  | { ok: false; phase: DeployPhase; reason: string; stderr?: string; snapshot?: ServiceSnapshot[] }

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
    return { cwd, args: ['compose', 'up', '-d', ...services] }
  }
  return {
    cwd,
    args: ['compose', '-f', `${target.stack}/docker-compose.yaml`, 'up', '-d', ...services],
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

export async function deploy(
  target: DeployTarget,
  opts: { skipBlackout?: boolean } = {},
): Promise<DeployOutcome> {
  const { policy } = loadPolicy()
  const refusal = refuseReason(target, {
    selfStack: env.selfStack,
    excluded: policy.exclude_stacks,
    // Restoring a known-good version is remediation, not a change: the blackout exists
    // to keep upgrades out of the small hours, not to leave a service broken until 02:30.
    blackout: opts.skipBlackout ? false : inBlackout(policy),
  })
  if (refusal) return { ok: false, phase: 'refused', reason: refusal }

  const started = Date.now()
  const project = projectName(target.stack)

  // Before anything is replaced: what is running now. It cannot be recovered afterwards
  // -- the container this is about to remove is the only record of it -- and it is both
  // the rollback target and the baseline the restart counter is measured against.
  const snapshot = await snapshotTarget(project, target.services)

  if (target.strategy === 'rm-first') {
    const rm = removeArgs(target)
    const r = await execa('docker', rm.args, { cwd: rm.cwd, reject: false, timeout: 120_000 })
    if ((r.exitCode ?? 1) !== 0) {
      return { ok: false, phase: 'rm', reason: 'could not remove the old container', stderr: tail(r.stderr), snapshot }
    }
  }

  if (target.pull) {
    const pu = pullArgs(target)
    const p = await execa('docker', pu.args, { cwd: pu.cwd, reject: false, timeout: 600_000 })
    if ((p.exitCode ?? 1) !== 0) {
      return { ok: false, phase: 'up', reason: 'could not pull the new image', stderr: tail(p.stderr), snapshot }
    }
  }

  const up = composeArgs(target)
  const r = await execa('docker', up.args, { cwd: up.cwd, reject: false, timeout: 600_000 })
  if ((r.exitCode ?? 1) !== 0) {
    return { ok: false, phase: 'up', reason: 'compose failed', stderr: tail(r.stderr), snapshot }
  }

  const verdict = await verifyDeploy(target, project, snapshot, policy)
  const secs = Math.round((Date.now() - started) / 1000)
  const healthy = verdict.kind === 'passed' || verdict.kind === 'degraded'
  return {
    ok: true,
    healthy,
    verdict,
    snapshot,
    detail:
      verdict.kind === 'passed'
        ? `${target.services.join(', ')} up in ${secs}s`
        : verdict.kind === 'degraded'
          ? `${target.services.join(', ')} up in ${secs}s, with warnings — ${verdict.detail}`
          : `${target.services.join(', ')} — ${verdict.detail}`,
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

/** Wire the pure verifier to the real docker, and to this service's declared probe port. */
async function verifyDeploy(
  target: DeployTarget,
  project: string,
  snapshot: ServiceSnapshot[],
  policy: Policy,
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

  // What the compose file pins RIGHT NOW, read from disk rather than from the database.
  //
  // `images.image_ref` is a snapshot taken by the last scan, and the scan runs once a
  // day. A deploy happens seconds after a merge, so that row still holds the tag from
  // before the bump -- and comparing the (correct) running container against it made
  // every single unattended deploy fail `image-mismatch` and roll back. It never showed
  // up while `paused: true`, because nothing had ever deployed unattended.
  //
  // The file is the source of truth everywhere else in shipshape, and by this point it
  // has been fast-forwarded, so read it.
  const pinned = new Map<string, string | null>()
  try {
    // `imageRaw` is the ref exactly as written in the file, which is what `image_ref`
    // stores and what the container reports -- the three have to be the same shape or
    // the comparison is meaningless.
    for (const svc of scanRepo(env.repoDir, policy.exclude_stacks)) {
      if (svc.stack === target.stack) pinned.set(svc.service, svc.imageRaw ?? null)
    }
  } catch {
    // Unreadable compose files are the deploy's problem, not the verifier's. Falling
    // back to the database keeps the old behaviour rather than skipping the check.
  }
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
 * What a failed deploy left behind, in the operator's terms.
 *
 * Only a plain `up` is safe to describe as leaving the old container in place; every
 * other phase either removed it first or never got that far.
 */
export function failureState(outcome: Extract<DeployOutcome, { ok: false }>, strategy: DeployTarget['strategy']): string {
  if (outcome.phase === 'up' && strategy === 'rm-first') {
    return 'The old container was removed and the new one did not start — the service is DOWN.'
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
): Promise<DeployOutcome> {
  const outcome = await deploy(target)
  const now = new Date().toISOString()
  const detail = outcome.ok
    ? outcome.detail
    : `${outcome.reason}${outcome.stderr ? `\n${outcome.stderr}` : ''}`
  const status = !outcome.ok ? 'failed' : outcome.healthy ? 'deployed' : 'failed'

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
    const down = outcome.phase === 'up' && target.strategy === 'rm-first'
    await notify({
      title: down
        ? `shipshape: ${target.stack} is DOWN — deploy failed`
        : `shipshape: deploy failed — ${target.stack}`,
      body: `#${prNumber} merged but ${target.services.join(', ')} did not deploy.\n\n${outcome.reason}\n\n${failureState(outcome, target.strategy)}\n\nRetry with:\n${manualCommand(target)}`,
      priority: down ? 5 : 4,
      tags: ['rotating_light'],
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
