import { execa } from 'execa'
import { join } from 'node:path'
import { env, inBlackout, loadPolicy } from '../config.ts'
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
}

/**
 * `phase` exists because the alert text depends on it and nothing else can recover it.
 * A plain `up` that fails leaves the old container running; the same failure after
 * `rm -sf` leaves the service DOWN. Reporting both as "the service is running whatever
 * it was" was false in exactly the case that needed the operator out of bed.
 */
export type DeployPhase = 'refused' | 'rm' | 'up' | 'verify'

export type DeployOutcome =
  | { ok: true; healthy: boolean; detail: string }
  | { ok: false; phase: DeployPhase; reason: string; stderr?: string }

/** Services in the root compose file are addressed from the repository root. */
function isRootStack(stack: string): boolean {
  return stack === 'root'
}

export function composeArgs(target: DeployTarget): { cwd: string; args: string[] } {
  const cwd = env.repoDir
  // Deduped here rather than at the call site: this is the one function that turns a
  // target into a command, so it is the one place that can guarantee the executed and
  // the pasted command agree.
  const services = [...new Set(target.services)]
  if (isRootStack(target.stack)) {
    // No -f: the root compose file is the project, and its networks are defined there.
    return { cwd, args: ['compose', 'up', '-d', ...services] }
  }
  return {
    cwd,
    args: ['compose', '-f', `${target.stack}/docker-compose.yaml`, 'up', '-d', ...services],
  }
}

function removeArgs(target: DeployTarget): { cwd: string; args: string[] } {
  const cwd = env.repoDir
  const base = isRootStack(target.stack)
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

export async function deploy(target: DeployTarget): Promise<DeployOutcome> {
  const { policy } = loadPolicy()
  const refusal = refuseReason(target, {
    selfStack: env.selfStack,
    excluded: policy.exclude_stacks,
    blackout: inBlackout(policy),
  })
  if (refusal) return { ok: false, phase: 'refused', reason: refusal }

  const started = Date.now()

  if (target.strategy === 'rm-first') {
    const rm = removeArgs(target)
    const r = await execa('docker', rm.args, { cwd: rm.cwd, reject: false, timeout: 120_000 })
    if ((r.exitCode ?? 1) !== 0) {
      return { ok: false, phase: 'rm', reason: 'could not remove the old container', stderr: tail(r.stderr) }
    }
  }

  const up = composeArgs(target)
  const r = await execa('docker', up.args, { cwd: up.cwd, reject: false, timeout: 600_000 })
  if ((r.exitCode ?? 1) !== 0) {
    return { ok: false, phase: 'up', reason: 'compose failed', stderr: tail(r.stderr) }
  }

  const health = await settle(target, policy.deploy.verify_window_s)
  const secs = Math.round((Date.now() - started) / 1000)
  return {
    ok: true,
    healthy: health.healthy,
    detail: health.healthy
      ? `${target.services.join(', ')} up in ${secs}s`
      : `${target.services.join(', ')} started but ${health.detail}`,
  }
}

/**
 * Wait for the containers to settle, and report what they settled into.
 *
 * Returns as soon as every container is running (and healthy, where a healthcheck
 * exists) rather than sleeping the full window, so a good deploy is fast and only a bad
 * one costs the wait.
 */
async function settle(
  target: DeployTarget,
  windowSeconds: number,
): Promise<{ healthy: boolean; detail: string }> {
  const deadline = Date.now() + windowSeconds * 1000
  let last = 'no container found'
  while (Date.now() < deadline) {
    const states = await Promise.all(target.services.map((s) => stateOf(target.stack, s)))
    const bad = states.filter((s) => s.state !== 'ok')
    if (bad.length === 0) return { healthy: true, detail: 'all healthy' }
    last = bad.map((b) => `${b.name}: ${b.detail}`).join('; ')
    // A container that has already given up will not recover by being watched.
    if (bad.some((b) => b.state === 'dead')) return { healthy: false, detail: last }
    await new Promise((r) => setTimeout(r, 3000))
  }
  return { healthy: false, detail: `did not become healthy within ${windowSeconds}s — ${last}` }
}

async function stateOf(
  stack: string,
  service: string,
): Promise<{ name: string; state: 'ok' | 'waiting' | 'dead'; detail: string }> {
  const r = await execa(
    'docker',
    [
      'ps',
      '--all',
      '--filter',
      `label=com.docker.compose.service=${service}`,
      '--format',
      '{{.Names}}\t{{.State}}\t{{.Status}}',
    ],
    { reject: false, timeout: 20_000 },
  )
  const line = String(r.stdout ?? '')
    .split('\n')
    .find((l) => l.trim())
  if (!line) return { name: service, state: 'waiting', detail: 'no container yet' }
  const [name, state, status] = line.split('\t')
  if (state === 'running') {
    if (/unhealthy/i.test(status ?? '')) return { name: name!, state: 'dead', detail: 'unhealthy' }
    if (/health: starting/i.test(status ?? ''))
      return { name: name!, state: 'waiting', detail: 'health starting' }
    return { name: name!, state: 'ok', detail: status ?? 'running' }
  }
  if (state === 'restarting') return { name: name!, state: 'dead', detail: 'restart loop' }
  if (state === 'exited') return { name: name!, state: 'dead', detail: status ?? 'exited' }
  return { name: name!, state: 'waiting', detail: status ?? String(state) }
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
): Promise<DeployOutcome> {
  const outcome = await deploy(target)
  const now = new Date().toISOString()

  getDb()
    .prepare(
      `INSERT INTO deploys (pr_number, stack, services, strategy, ok, healthy, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      prNumber,
      target.stack,
      target.services.join(' '),
      target.strategy,
      outcome.ok ? 1 : 0,
      outcome.ok && outcome.healthy ? 1 : 0,
      outcome.ok ? outcome.detail : `${outcome.reason}${outcome.stderr ? `\n${outcome.stderr}` : ''}`,
      now,
    )

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
