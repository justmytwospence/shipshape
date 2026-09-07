import { dirname, relative, resolve, sep } from 'node:path'

/**
 * How far a drafted proposal may reach, expressed as a boundary in the repository.
 *
 * The boundary is derived from where the service's compose file sits, which is the
 * whole idea: a stack is a directory, so "this stack's files" is `dirname(composeFile)`
 * and needs no configuration beyond naming the rung.
 *
 * | scope          | boundary                                  |
 * |----------------|-------------------------------------------|
 * | `none`         | nothing                                   |
 * | `service`      | this service's block in its compose file  |
 * | `compose-file` | any service in that compose file          |
 * | `compose-dir`  | any file in the compose file's directory  |
 * | `repo`         | any file in the repository                |
 *
 * `service` is the default. The first two rungs are about which *service* may change;
 * the last two are about which *file* may change, and both limits apply at once — at
 * `compose-dir` a proposal may edit a sibling config file, and may still only touch the
 * services its service-level scope permits inside a compose file.
 *
 * ## Three limits that no scope lifts
 *
 * **Never binary.** There is nothing to anchor to in a PNG. Structured files (YAML,
 * JSON) take the path operations; everything else — `.conf`, `.sh`, a Dockerfile —
 * takes anchored text replacement, where the anchor must match exactly once.
 *
 * **Never its own guardrails, never anything executable.** A proposal can only add a
 * commit a human reviews — but a diff review is exactly where "one line in policy.yaml"
 * slips past, and shipshape's policy file is where its own limits live. Workflows,
 * `bin/` and `scripts/` are executable on merge or on next run. Excluded at every scope
 * including `repo`, for the same reason shipshape never deploys itself: a rule that can
 * be configured away is not a limit.
 *
 * **Never what the operator has ruled out.** `propose.never` names paths that are off
 * limits whatever the scope. It exists for configuration that is *hot-reloaded* — a
 * file-provider directory, say — where a merged edit goes live on the next sync with no
 * `compose up`, no verify window and no rollback, so every safeguard shipshape has is
 * blind to it.
 */

export type ProposeScope = 'none' | 'service' | 'compose-file' | 'compose-dir' | 'repo'

export const SCOPES: ProposeScope[] = ['none', 'service', 'compose-file', 'compose-dir', 'repo']

/**
 * Read `shipshape.propose`. Unset means `service`.
 *
 * `off` is the original spelling of `none`. An unrecognised value narrows to `service`
 * rather than widening — a typo must never grant reach.
 */
export function scopeFor(label: string | null | undefined): ProposeScope {
  if (!label) return 'service'
  const v = label.trim().toLowerCase()
  if (v === 'off' || v === 'none') return 'none'
  if (v === 'compose-file' || v === 'file') return 'compose-file'
  if (v === 'compose-dir' || v === 'compose-directory' || v === 'directory' || v === 'dir') {
    return 'compose-dir'
  }
  if (v === 'repo' || v === 'repository' || v === 'any') return 'repo'
  return 'service'
}

/**
 * Directory names that are never writable, at any depth.
 *
 * Depth is the point. This used to test only the first path segment, which read as
 * "bin/ and scripts/ are excluded" and actually meant "bin/ and scripts/ are excluded
 * at the repository root". Every executable hook in a real compose repository is one
 * segment further down — `code-server/custom-cont-init.d/01-fix-prompt.sh`, which the
 * base image runs as root at container start, or `mcpjungle/bin/download.sh` — so the
 * stated intent and the enforced rule disagreed about every one of them.
 */
const FORBIDDEN_DIRS = new Set([
  '.git',
  '.github', // executes on merge
  'bin',
  'scripts', // executes on next run
  'credentials',
  'secrets', // secret-bearing, and tracked in some stacks
  'custom-cont-init.d', // base images run these as root at container start
])

/** Paths no proposal may write, whatever its scope. Repo-relative, POSIX separators. */
export function isForbidden(relPath: string, selfStack: string, never: string[] = []): boolean {
  const p = relPath.split(sep).join('/').replace(/^\.\//, '')
  const segments = p.split('/')
  if (segments[0] === selfStack) return true // its own configuration, including its policy
  if (segments.some((s) => FORBIDDEN_DIRS.has(s))) return true
  if (/(^|\/)\.env/.test(p)) return true // secrets, and gitignored anyway
  for (const entry of never) {
    const n = entry.split(sep).join('/').replace(/^\.\//, '').replace(/\/+$/, '')
    if (n && (p === n || p.startsWith(`${n}/`))) return true
  }
  return false
}

/**
 * A repo-relative path with `..` collapsed, or null when it leaves the repository.
 *
 * Resolving *before* the forbidden test is the whole point, and not doing so was a hole
 * straight through every rule above. `canWrite` used to resolve only to answer "does
 * this escape the repository?", throw the resolved form away, and hand the raw string to
 * `isForbidden` — which reads path segments. So `traefik/../shipshape/config/policy.yaml`
 * passed the escape test (it lands inside the repo), passed the forbidden test (its first
 * segment is `traefik`), passed the boundary test (it starts with `traefik/`), and was
 * then written by `writeFileSync(join(repoDir, file))`, which collapses the `..`. Every
 * "never writable" path was reachable by naming it the long way round.
 */
export function resolveInRepo(relPath: string): string | null {
  const raw = relPath.split(sep).join('/')
  if (raw.startsWith('/')) return null
  const rel = relative('/repo', resolve('/repo', raw)).split(sep).join('/')
  if (rel === '' || rel === '..' || rel.startsWith('../')) return null
  return rel
}

/**
 * Binary files are the only type that cannot be edited.
 *
 * An earlier version of this restricted edits to YAML, reasoning that the deep-compare
 * needed a parse. That was backwards: the deep-compare never proved the edit was
 * *right*, only that the applier did exactly what the operations named and nothing
 * else — and an anchor matching exactly once gives the same guarantee with no parse at
 * all. Structured files (YAML, JSON) get the path operations; everything else gets
 * anchored replacement.
 */
export function isEditableType(relPath: string, content?: string): boolean {
  if (content !== undefined && content.includes('\0')) return false
  return !/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|db|sqlite3?|woff2?|ttf|so|bin)$/i.test(relPath)
}

/** Structured formats the path operations can address. Everything else is text. */
export function isStructured(relPath: string): boolean {
  return /\.(ya?ml|json)$/i.test(relPath)
}

/**
 * Configuration, as opposed to anything that runs.
 *
 * An allowlist, so a file type nobody thought about defaults to refused. That is the
 * opposite of `isEditableType`, which names what cannot be edited and therefore lets
 * through every `.sh`, `.py`, `Dockerfile`, `.service` and fail2ban `.local` in a
 * repository — all of which execute, several as root.
 *
 * Which of the two applies is the boundary's `types`, not a global rule, because the
 * two callers stand on genuinely different ground. A proposal is shipshape's own idea,
 * drafted from a changelog at a rung the operator opted into per service, and anchored
 * replacement on a startup script is a considered part of that design. A revision comes
 * from a sentence someone typed, at a rung that is the default, and the same edit there
 * has no such warrant.
 */
export function isConfigType(relPath: string): boolean {
  return /\.(ya?ml|json|xml|toml|ini|conf)$/i.test(relPath)
}

/**
 * Which services a proposal may change.
 *
 * Separate from the file boundary because the two limits are independent and both
 * apply: a wide file scope still only reaches the services its rung permits inside a
 * compose file.
 */
export function allowedServices(
  scope: ProposeScope,
  primary: string,
  siblings: string[],
): string[] {
  if (scope === 'none') return []
  if (scope === 'service') return [primary]
  // Every wider rung permits the whole compose file.
  return siblings.includes(primary) ? siblings : [primary, ...siblings]
}

export interface Boundary {
  scope: ProposeScope
  /** Repo-relative directory the proposal may write within, or null for the whole repo. */
  root: string | null
  composeFile: string
  /**
   * What may be written *outside* the compose file itself.
   *
   * `any` is the proposal path's rule: anything that is not binary. `config` is the
   * revision path's: structured configuration only. See `isConfigType`.
   */
  types: 'any' | 'config'
}

/** The boundary for a service, derived from where its compose file lives. */
export function boundaryFor(
  scope: ProposeScope,
  composeFile: string,
  types: 'any' | 'config' = 'any',
): Boundary {
  if (scope === 'compose-dir') {
    const dir = dirname(composeFile).split(sep).join('/')
    return { scope, root: dir === '.' ? '' : dir, composeFile, types }
  }
  if (scope === 'repo') return { scope, root: null, composeFile, types }
  // The narrow rungs reach exactly one file.
  return { scope, root: composeFile, composeFile, types }
}

export type FileVerdict = { ok: true } | { ok: false; reason: string }

/** May this proposal write this file? */
export function canWrite(
  relPath: string,
  boundary: Boundary,
  selfStack: string,
  /** File contents, when already read — catches a binary with an innocent extension. */
  content?: string,
  /** Paths the operator has ruled out at every scope. */
  never: string[] = [],
): FileVerdict {
  if (boundary.scope === 'none') return { ok: false, reason: 'this proposal may not change anything' }

  // Resolved once, and every test below reads the resolved form. See `resolveInRepo`.
  const p = resolveInRepo(relPath)
  if (p === null) return { ok: false, reason: `"${relPath}" is outside the repository` }
  if (isForbidden(p, selfStack, never)) {
    return { ok: false, reason: `"${p}" is never writable by a proposal` }
  }
  if (!isEditableType(p, content)) {
    return { ok: false, reason: `"${p}" is a binary file — describe the change as a note instead` }
  }

  const composeFile = resolveInRepo(boundary.composeFile) ?? boundary.composeFile

  if (boundary.scope === 'service' || boundary.scope === 'compose-file') {
    return p === composeFile
      ? { ok: true }
      : { ok: false, reason: `this proposal may only change ${boundary.composeFile}` }
  }

  if (boundary.types === 'config' && p !== composeFile && !isConfigType(p)) {
    return {
      ok: false,
      reason: `"${p}" is not a configuration file — describe the change as a note instead`,
    }
  }

  if (boundary.scope === 'compose-dir') {
    const root = boundary.root ?? ''
    const inside = root === '' ? !p.includes('/') : p === root || p.startsWith(`${root}/`)
    return inside
      ? { ok: true }
      : { ok: false, reason: `this proposal may only change files under ${root}/` }
  }

  return { ok: true } // repo, past the exclusions above
}

/** What the model is told it may touch. Kept in step with what canWrite enforces. */
export function describeBoundary(
  boundary: Boundary,
  primary: string,
  allowedServices: string[],
): string {
  const services =
    allowedServices.length > 1
      ? `Within ${boundary.composeFile} you may change these services: ${allowedServices.join(', ')}. Name the service on each operation; operations without one apply to ${primary}.`
      : `Within ${boundary.composeFile} you may change only the "${primary}" service.`

  const others =
    boundary.types === 'config'
      ? 'Other files must be configuration — YAML, JSON, XML, TOML, INI or .conf. Scripts, Dockerfiles and unit files are notes, not operations.'
      : 'Use the path operations for YAML and JSON, and replace_text for anything else.'

  switch (boundary.scope) {
    case 'none':
      return 'You may not change anything. Describe everything as notes.'
    case 'service':
    case 'compose-file':
      return `${services}\nYou may not change any other file.`
    case 'compose-dir':
      return [
        services,
        `You may also change other files under ${boundary.root}/ — a configuration file`,
        'this service reads, for instance.',
        others,
        'Files outside that directory are notes.',
      ].join('\n')
    case 'repo':
      return [
        services,
        'You may also change files elsewhere in the repository.',
        others,
        "shipshape's own configuration, CI workflows, scripts, credentials and .env files",
        'are never writable.',
        'Prefer the narrowest change that works: reaching outside this stack needs a',
        'reason from the upstream documentation.',
      ].join('\n')
  }
}
