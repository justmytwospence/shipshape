import { type Policy } from '../policy-schema.ts'
import { env } from '../env.ts'
import { includedStacks, scanRepo } from './scan.ts'
import { getDb } from '../db/index.ts'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { composeFileOfStack } from './files.ts'

/**
 * Stacks that are part of the root compose project rather than their own.
 *
 * Either the root file itself, or one it `include:`s -- a DNS server, a reverse proxy and
 * a VPN, for example. Both are addressed from the repository root with no `-f`, because
 * scoping to their own file loses the networks the root defines and compose refuses the
 * whole project.
 */
export function isRootStack(stack: string, repoDir = env.repoDir): boolean {
  return stack === 'root' || includedStacks(repoDir).has(stack)
}


/**
 * The services of a stack that the compose file builds from source now: the forks
 * (the forks guide), whose `image:` is a local name, and our own builds watched through their base
 * image (compose/dockerfile.ts), whose merged change is a `FROM` line only a build reads. A
 * plain unwatched `build:` service is never deployed by shipshape, so there is nothing to
 * build for one; a fork just retired has no `build:` block any more and drops out here,
 * which is what lets the deploy that follows the retire pull the upstream image instead.
 */
export function buildableServices(
  stack: string,
  services: string[],
  policy: Policy,
  repoDir = env.repoDir,
  kinds: { forks?: boolean; bases?: boolean } = {},
): string[] {
  const forks = kinds.forks ?? true
  const bases = kinds.bases ?? true
  try {
    const scanned = scanRepo(repoDir, policy.exclude_stacks)
    return services.filter((s) =>
      scanned.some(
        (x) => x.stack === stack && x.service === s && x.hasBuild && ((forks && !!x.fork) || (bases && !!x.base)),
      ),
    )
  } catch {
    return []
  }
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
  const raw = root ? basename(repoDir) : (declaredName(join(repoDir, composeFileOfStack(repoDir, stack))) ?? stack)
  return raw.toLowerCase().replace(/[^a-z0-9_-]/g, '')
}


/**
 * A compose file's own top-level `name:`, which overrides the directory as the project
 * name (`media/` can run as project `jellyfin`). Null when absent, unreadable, or built
 * from a variable this process cannot resolve the way compose would.
 */
function declaredName(file: string): string | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const m = /^name:[ \t]*["']?([^"'\s#]+)["']?[ \t]*(?:#.*)?$/m.exec(text)
  if (!m || m[1]!.includes('$')) return null
  return m[1]!
}
