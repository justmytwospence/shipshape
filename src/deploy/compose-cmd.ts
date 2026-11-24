import { env } from '../env.ts'
import { isRootStack } from '../compose/topology.ts'
import { composeFileOfStack, overrideFor } from '../compose/files.ts'
import type { DeployTarget } from './types.ts'

/**
 * The `-f` arguments that point compose at a stack's files: none for the root project (no -f at
 * all, because scoping it loses the networks it defines), otherwise the stack's compose file
 * and the override Compose would have applied on its own, so the command matches a plain
 * `docker compose up` in that directory.
 */
export function fileArgs(stack: string, repoDir = env.repoDir): string[] {
  if (isRootStack(stack, repoDir)) return []
  const file = composeFileOfStack(repoDir, stack)
  const override = overrideFor(repoDir, file)
  return ['-f', file, ...(override ? ['-f', override] : [])]
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
export function composeArgs(target: DeployTarget, repoDir = env.repoDir): { cwd: string; args: string[] } {
  const cwd = repoDir
  // Deduped here rather than at the call site: this is the one function that turns a
  // target into a command, so it is the one place that can guarantee the executed and
  // the pasted command agree.
  const services = [...new Set(target.services)]
  return { cwd, args: ['compose', ...fileArgs(target.stack, repoDir), 'up', '-d', '--no-deps', ...services] }
}

/**
 * `compose pull` for the same target, so the command that runs and the command the pull
 * request suggests are built by the same function rather than resembling each other.
 */
export function pullArgs(target: DeployTarget, repoDir = env.repoDir): { cwd: string; args: string[] } {
  const up = composeArgs(target, repoDir)
  const head = up.args.slice(0, up.args.indexOf('up'))
  // A fork's `image:` is a local build name no registry has; `--ignore-buildable` keeps
  // compose from trying, while the other services of the target are still pulled.
  const flags = (target.build ?? []).length > 0 ? ['--ignore-buildable'] : []
  return { cwd: up.cwd, args: [...head, 'pull', ...flags, ...new Set(target.services)] }
}

/**
 * `compose build` for the services of the target that are built from source, before `up`.
 * Its own step rather than `up --build`, so a build that fails has recreated nothing and
 * says so, and so the command an operator pastes shows the build it needs.
 */
export function buildArgs(target: DeployTarget, repoDir = env.repoDir): { cwd: string; args: string[] } | null {
  const build = [...new Set((target.build ?? []).filter((s) => target.services.includes(s)))]
  if (build.length === 0) return null
  const up = composeArgs(target, repoDir)
  const head = up.args.slice(0, up.args.indexOf('up'))
  return { cwd: up.cwd, args: [...head, 'build', ...build] }
}

export function removeArgs(target: DeployTarget, repoDir = env.repoDir): { cwd: string; args: string[] } {
  const cwd = repoDir
  return { cwd, args: ['compose', ...fileArgs(target.stack, repoDir), 'rm', '-sf', ...new Set(target.services)] }
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
  const build = buildArgs(target)
  if (build) lines.push(`docker ${build.args.join(' ')}`)
  if (target.strategy === 'rm-first') {
    const rm = removeArgs(target)
    lines.push(`docker ${rm.args.join(' ')}`)
  }
  const up = composeArgs(target)
  lines.push(`docker ${up.args.join(' ')}`)
  return lines.join('\n')
}
