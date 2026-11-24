import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Which file is a stack's compose file, the way Compose itself decides.
 *
 * Verified against Compose v5.7: with several present it prefers compose.yaml, then
 * compose.yml, then docker-compose.yml, then docker-compose.yaml; and with no `-f` it
 * applies the first override file that exists beside it, whatever the base is called.
 */

/** Compose's own preference order. */
const COMPOSE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'] as const

/** The override files Compose applies when no -f is given: the first that exists, only one. */
const OVERRIDE_NAMES = [
  'compose.override.yml',
  'compose.override.yaml',
  'docker-compose.override.yml',
  'docker-compose.override.yaml',
] as const

/** Directories never scanned as stacks. */
const SKIP_DIRS = new Set(['.git', '.claude', '.agents', 'bin', 'node_modules'])

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function isReadableDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** The compose file of one directory, and the lower-preference candidates it shadows. */
export function composeFileIn(dir: string): { name: string; shadowed: string[] } | null {
  const present = COMPOSE_NAMES.filter((n) => isFile(join(dir, n)))
  return present.length === 0 ? null : { name: present[0]!, shadowed: present.slice(1) }
}

export interface ComposeDiscovery {
  /** Absolute paths, sorted. */
  files: string[]
  /** Directories where several candidates exist. `dir` is '' for the repository root. */
  shadowed: { dir: string; kept: string; ignored: string[] }[]
}

/** The repository root's own file (stack `root`) plus one per directory directly under it. */
export function discoverCompose(repoRoot: string): ComposeDiscovery {
  const out: ComposeDiscovery = { files: [], shadowed: [] }
  // An unset or missing repository is a configuration state, not an error.
  if (!repoRoot || !isReadableDir(repoRoot)) return out
  const consider = (dir: string, name: string) => {
    const found = composeFileIn(dir)
    if (!found) return
    out.files.push(join(dir, found.name))
    if (found.shadowed.length > 0) out.shadowed.push({ dir: name, kept: found.name, ignored: found.shadowed })
  }
  consider(repoRoot, '')
  for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
    consider(join(repoRoot, entry.name), entry.name)
  }
  out.files.sort()
  return out
}

/**
 * The repo-relative compose file of a stack: `<name>` for `root`, `<stack>/<name>` otherwise.
 * Falls back to `docker-compose.yaml` when `repoDir` is '' or nothing is on disk, so callers
 * without a checkout (tests, a stack that was just deleted) keep a sensible name.
 */
export function composeFileOfStack(repoDir: string, stack: string): string {
  const found = repoDir ? composeFileIn(stack === 'root' ? repoDir : join(repoDir, stack)) : null
  const name = found?.name ?? 'docker-compose.yaml'
  return stack === 'root' ? name : `${stack}/${name}`
}

/** The override Compose would apply to the file at `rel`, repo-relative, or null. */
export function overrideFor(repoDir: string, rel: string): string | null {
  if (!repoDir) return null
  const slash = rel.lastIndexOf('/')
  const dir = slash === -1 ? '' : rel.slice(0, slash + 1)
  for (const n of OVERRIDE_NAMES) if (isFile(join(repoDir, dir + n))) return dir + n
  return null
}
