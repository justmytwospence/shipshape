import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { parseImageRef, type ImageRef } from '../images/ref.ts'
import { finalBase, parseFroms } from './dockerfile.ts'

/**
 * Reads the desired state out of the compose files themselves.
 *
 * Critically, `shipshape.*` labels are read HERE -- from the files in git -- and never
 * from running containers. Updaters that read live Docker metadata inherit a nasty
 * failure: recreating a container by cloning its running config means a label edited in
 * the compose file never takes effect, and the stale value survives every subsequent
 * update. Observed in the wild on ~80 containers for weeks. Parsing files makes that
 * entire class impossible.
 */

export type UnwatchableReason = 'build' | 'interpolated' | 'no-image' | 'excluded'

/** `traefik.http.services.<anything>.loadbalancer.server.port`, first one wins. */
function traefikPort(labels: Record<string, string>): number | null {
  for (const [k, v] of Object.entries(labels)) {
    if (/^traefik\.http\.services\..+\.loadbalancer\.server\.port$/.test(k)) {
      const n = Number(v)
      if (Number.isInteger(n) && n > 0 && n < 65536) return n
    }
  }
  return null
}

/**
 * Stacks whose compose file the root project pulls in with `include:`.
 *
 * Their services belong to the ROOT compose project, not a project of their own -- the
 * containers carry `com.docker.compose.project=<repo dir>` and their networks are
 * defined in the root file. Two consequences, both of which have to be got right or the
 * stack cannot be deployed at all: `-f <stack>/docker-compose.yaml` fails outright with
 * "refers to undefined network", and looking for their containers under a project named
 * after the stack finds nothing.
 *
 * Read from the file rather than hard-coded, so adding a fifth included stack needs no
 * change here. (The repository documents the same trap in prose for humans; this is the
 * machine-readable half.)
 */
export function includedStacks(repoDir: string): Set<string> {
  const out = new Set<string>()
  let raw: string
  try {
    raw = readFileSync(join(repoDir, 'docker-compose.yaml'), 'utf8')
  } catch {
    return out
  }
  let doc: { include?: unknown } | null = null
  try {
    doc = parseYaml(raw) as { include?: unknown }
  } catch {
    return out
  }
  for (const entry of Array.isArray(doc?.include) ? doc.include : []) {
    const path =
      typeof entry === 'string' ? entry : ((entry as { path?: unknown })?.path as string | undefined)
    if (typeof path !== 'string') continue
    const stack = path.split('/')[0]
    if (stack && stack !== '.') out.add(stack)
  }
  return out
}

export interface ScannedService {
  stack: string
  service: string
  composeFile: string
  imageRaw: string | null
  ref: ImageRef | null
  labels: Record<string, string>
  profiles: string[]
  /**
   * Carries a `disabled` or `standby` profile: intentionally not running. Still watched, so
   * its pending updates are listed and a revival is not a jump across months of releases,
   * but its tier is forced to `held` (see `tierFor`): nothing is ever opened for it
   * unasked, and a deploy leaves a stopped service stopped anyway (deploy/runstate.ts).
   */
  dormant: boolean
  hasBuild: boolean
  /** `build.context` as written, when it is a string: a fork's pinned git URL. */
  buildContext: string | null
  watched: boolean
  unwatchable: UnwatchableReason | null
  /** shipshape.* label values, already split out. */
  pattern: string | null
  tagInclude: string | null
  policyLabel: string | null
  sourceLabel: string | null
  /** `shipshape.changelog`: where the release notes are when GitHub releases do not have them. */
  changelogLabel: string | null
  /**
   * `shipshape.review: required` -- fail closed without a review. Read from the older
   * `shipshape.claude` too, because the label restricts what may merge and dropping it on
   * a rename would quietly loosen a service.
   */
  claudeLabel: string | null
  deployLabel: string | null
  /** Port this service serves HTTP on, per its own traefik loadbalancer label. */
  probePort: number | null
  /** The stack's nightly dump command, if it declares one. Suggested, never run. */
  archivePre: string | null
  /** `service:<name>` when this service shares another container's network namespace. */
  networkMode: string | null
  /**
   * `shipshape.pr: on-request`, the older spelling of `shipshape.policy: on-request`.
   * Still read -- see `claudeLabel` for why a restricting label is never dropped.
   */
  prLabel: string | null
  /** `shipshape.propose` -- how far a drafted config change may reach. See propose/paths. */
  proposeLabel: string | null
  /** `shipshape.group: <name>` -- forces services into one PR when the heuristic misses. */
  groupLabel: string | null
  /** `shipshape.*` keys nothing reads: a typo, or a label left over from a retired one. */
  unknownLabels: string[]
  /**
   * A label that was read but could not be used, in words: a `fork.waits-on` entry that is
   * not `owner/repo#N`, a `fork.upstream` that is not an image reference. Reported like
   * unknown labels, and never a reason to stop the scan.
   */
  labelProblems: string[]
  /**
   * Our own build of an upstream image, carrying a fix upstream has not released (FORKS.md).
   * `upstream` is the image the fork is based on, as it stood in `image:` before the fork;
   * `waitsOn` the upstream issues or PRs the fork exists for, each `owner/repo#N`. When
   * set, `ref` is parsed from `upstream` rather than from `image:` -- the local build name
   * has no registry to poll -- and the service is watchable despite `build:`. Its tier
   * follows the same ladder as every service: shipshape rebases the fork onto the new
   * release itself (src/forks/rebase.ts) and retires it when nothing is left to carry.
   */
  fork: ForkInfo | null
  /**
   * A `build:` service of our own, watched through the base image of its Dockerfile's
   * final stage (compose/dockerfile.ts). Set only when the service opts in with
   * `shipshape.watch` and its Dockerfile is a file in this repository. When set, `ref` is
   * parsed from the base, the other `shipshape.*` labels describe the base -- as they
   * describe the upstream for a fork -- and a bump edits the `FROM` line.
   */
  base: BaseInfo | null
}

export interface BaseInfo {
  /** The Dockerfile, relative to the repository root. */
  dockerfile: string
  /** The base image, exactly as the final stage's `FROM` names it. */
  ref: string
}

export interface ForkInfo {
  upstream: string
  waitsOn: string[]
}

/** `owner/repo#N`, as GitHub writes a cross-repository reference. */
const WAITS_ON = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/

/**
 * Split `shipshape.fork.waits-on` into normalised references, keeping the entries that do
 * not parse separate so they can be said out loud rather than dropped.
 */
export function parseWaitsOn(raw: string | null): { refs: string[]; malformed: string[] } {
  const refs: string[] = []
  const malformed: string[] = []
  for (const part of (raw ?? '').split(',')) {
    const s = part.trim()
    if (!s) continue
    const m = WAITS_ON.exec(s)
    if (m) refs.push(`${m[1]}#${m[2]}`)
    else malformed.push(s)
  }
  return { refs: [...new Set(refs)], malformed }
}

/** Every `shipshape.*` key the scanner understands. Anything else is reported, never guessed at. */
export const KNOWN_LABELS = new Set([
  'watch',
  'pattern',
  'tag.include',
  'policy',
  'source',
  'changelog',
  'review',
  'claude',
  'deploy',
  'probe',
  'pr',
  'propose',
  'group',
  'fork.upstream',
  'fork.waits-on',
])

const SKIP_DIRS = new Set(['.git', '.claude', '.agents', 'bin', 'node_modules'])

/** Every `<stack>/docker-compose.yaml` plus the root infrastructure compose. */
export function findComposeFiles(repoRoot: string): string[] {
  const out: string[] = []
  // An unset or missing repository is a configuration state, not an error: the UI
  // renders setup instructions, and every caller here should simply see no services.
  if (!repoRoot || !isReadableDir(repoRoot)) return out
  const root = join(repoRoot, 'docker-compose.yaml')
  if (exists(root)) out.push(root)
  for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
    const f = join(repoRoot, entry.name, 'docker-compose.yaml')
    if (exists(f)) out.push(f)
  }
  return out.sort()
}

function isReadableDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function exists(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** Compose accepts labels as a map or as a `key=value` list; normalise to a map. */
function normaliseLabels(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'string') continue
      const eq = item.indexOf('=')
      if (eq === -1) out[item] = ''
      else out[item.slice(0, eq)] = item.slice(eq + 1)
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out[k] = v === null || v === undefined ? '' : String(v)
    }
  }
  return out
}

function toStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string')
  if (typeof raw === 'string') return [raw]
  return []
}

export function scanComposeFile(repoRoot: string, file: string, excludeStacks: string[] = []): ScannedService[] {
  const rel = relative(repoRoot, file)
  // `<stack>/docker-compose.yaml` -> `<stack>`; the root file is the infrastructure
  // project, whose services must be brought up from the repo root (AGENTS.md gotcha 1).
  const stack = rel.includes('/') ? rel.split('/')[0]! : 'root'

  let doc: unknown
  try {
    doc = parseYaml(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  if (!doc || typeof doc !== 'object') return []
  const services = (doc as { services?: Record<string, unknown> }).services
  if (!services || typeof services !== 'object') return []

  const out: ScannedService[] = []
  for (const [name, rawSvc] of Object.entries(services)) {
    if (!rawSvc || typeof rawSvc !== 'object') continue
    const svc = rawSvc as Record<string, unknown>

    const imageRaw = typeof svc.image === 'string' ? svc.image : null
    const labels = normaliseLabels(svc.labels)
    const profiles = toStringArray(svc.profiles)
    const hasBuild = svc.build !== undefined
    const buildContext =
      typeof svc.build === 'string'
        ? svc.build
        : svc.build && typeof svc.build === 'object' && typeof (svc.build as { context?: unknown }).context === 'string'
          ? ((svc.build as { context: string }).context)
          : null

    // `dockhand.*` was read as a fallback while the rename swept 140 services. None
    // carries it any more, so only the one prefix is read.
    const label = (k: string): string | null => labels[`shipshape.${k}`] ?? null
    const unknownLabels = Object.keys(labels)
      .filter((k) => k.startsWith('shipshape.'))
      .map((k) => k.slice('shipshape.'.length))
      .filter((k) => !KNOWN_LABELS.has(k))

    const pattern = label('pattern')
    const tagInclude = label('tag.include')
    const policyLabel = label('policy')
    const sourceLabel = label('source')
    const changelogLabel = label('changelog')
    const claudeLabel = label('review') ?? label('claude')
    const deployLabel = label('deploy')
    // Traefik already knows which port each service answers on -- 76 of them declare it.
    // Reusing that beats inventing a shipshape-specific one nobody would fill in, and it
    // is the only per-service HTTP fact this repo states in a machine-readable way.
    // `shipshape.probe: off` opts out; `shipshape.probe: <port>` overrides.
    const probeLabel = label('probe')
    const probePort =
      probeLabel === 'off'
        ? null
        : /^\d+$/.test(probeLabel ?? '')
          ? Number(probeLabel)
          : traefikPort(labels)
    const archivePre = labels['docker-volume-backup.archive-pre'] ?? null
    const networkMode = typeof svc.network_mode === 'string' ? svc.network_mode : null
    const prLabel = label('pr')
    const proposeLabel = label('propose')
    const groupLabel = label('group')
    const watchLabel = label('watch')
    const labelProblems: string[] = []

    // A fork names the upstream image it stands in for, and that is what gets polled. The
    // local build name in `image:` is kept as `imageRaw` -- the deploy still compares the
    // running container against it -- but `ref` comes from the label.
    let fork: ForkInfo | null = null
    const forkUpstream = label('fork.upstream')?.trim() || null
    if (forkUpstream !== null) {
      if (forkUpstream.includes('${') || !/^[^\s]+$/.test(forkUpstream)) {
        labelProblems.push(`shipshape.fork.upstream "${forkUpstream}" is not an image reference`)
      } else {
        const waits = parseWaitsOn(label('fork.waits-on'))
        for (const bad of waits.malformed) {
          labelProblems.push(`shipshape.fork.waits-on entry "${bad}" is not owner/repo#N`)
        }
        fork = { upstream: forkUpstream, waitsOn: waits.refs }
      }
    } else if (label('fork.waits-on') !== null) {
      labelProblems.push('shipshape.fork.waits-on without shipshape.fork.upstream does nothing')
    }

    // Our own build, opted in: watched through its base image. Only looked for when the
    // service asks to be watched, so an unwatched build never reports a Dockerfile problem.
    let base: BaseInfo | null = null
    // A service that names a fork upstream meant to be a fork, even when the label is
    // unusable: that is said above, and it is not quietly watched some other way instead.
    if (hasBuild && forkUpstream === null && watchLabel === 'true' && !excludeStacks.includes(stack)) {
      const found = baseFor(repoRoot, file, svc.build, pattern)
      if (found.ok) base = found.base
      else labelProblems.push(`shipshape.watch on a build: ${found.reason}`)
    }

    let unwatchable: UnwatchableReason | null = null
    if (excludeStacks.includes(stack)) unwatchable = 'excluded'
    // A fork is a `build:` service with a registry to poll after all: the upstream's.
    else if (fork) unwatchable = null
    // And so is our own build, through the image it is built on.
    else if (base) unwatchable = null
    else if (!imageRaw) unwatchable = 'no-image'
    // A locally-built image has no registry to poll. `build:` wins even when `image:`
    // is also set -- that combination just names the local build output.
    else if (hasBuild) unwatchable = 'build'
    // `image: ${FOO}` cannot be compared against registry tags, and rewriting it would
    // corrupt the indirection.
    else if (imageRaw.includes('${')) unwatchable = 'interpolated'

    const watched = watchLabel === 'true' && unwatchable === null
    const polled = fork ? fork.upstream : base ? base.ref : imageRaw

    out.push({
      stack,
      service: name,
      composeFile: rel,
      imageRaw,
      ref: polled && !polled.includes('${') ? parseImageRef(polled) : null,
      labels,
      profiles,
      dormant: profiles.includes('disabled') || profiles.includes('standby'),
      hasBuild,
      buildContext,
      watched,
      unwatchable,
      pattern,
      tagInclude,
      policyLabel,
      sourceLabel,
      changelogLabel,
      claudeLabel,
      deployLabel,
      probePort,
      archivePre,
      networkMode,
      prLabel,
      proposeLabel,
      groupLabel,
      unknownLabels,
      labelProblems,
      fork,
      base,
    })
  }
  return out
}

/** A remote build context: a git URL or an archive, which this repository cannot edit. */
function isRemoteContext(ctx: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(ctx) || ctx.startsWith('git@') || /^github\.com\//.test(ctx)
}

/**
 * Where a `build:` service's Dockerfile is and which published image its final stage is
 * built on. Refused in words when the Dockerfile is not a file of this repository, or its
 * base cannot be followed to a published reference that can be moved by editing it.
 */
export function baseFor(
  repoRoot: string,
  composeFile: string,
  build: unknown,
  pattern: string | null,
): { ok: true; base: BaseInfo } | { ok: false; reason: string } {
  let context = '.'
  let dockerfile = 'Dockerfile'
  if (typeof build === 'string') context = build
  else if (build && typeof build === 'object') {
    const b = build as { context?: unknown; dockerfile?: unknown; dockerfile_inline?: unknown }
    if (b.dockerfile_inline !== undefined) return { ok: false, reason: 'the Dockerfile is inline (dockerfile_inline)' }
    if (typeof b.context === 'string') context = b.context
    if (typeof b.dockerfile === 'string') dockerfile = b.dockerfile
  } else return { ok: false, reason: 'cannot read the build: block' }
  if (context.includes('${') || dockerfile.includes('${')) {
    return { ok: false, reason: 'the build context is interpolated' }
  }
  if (isRemoteContext(context)) return { ok: false, reason: `the build context is remote (${context})` }

  const root = resolve(repoRoot)
  const abs = isAbsolute(dockerfile) ? dockerfile : resolve(dirname(composeFile), context, dockerfile)
  const rel = relative(root, abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, reason: `the Dockerfile ${dockerfile} is outside this repository` }
  }
  let text: string
  try {
    text = readFileSync(abs, 'utf8')
  } catch {
    return { ok: false, reason: `cannot read ${rel}` }
  }
  const parsed = parseFroms(text)
  if (!parsed.ok) return { ok: false, reason: `${rel}: ${parsed.reason}` }
  const found = finalBase(parsed.froms)
  if (!found.ok) return { ok: false, reason: `${rel}: ${found.reason}` }

  // A floating base cannot be moved by an edit: the file would say the same thing after.
  // Rebuilding it is exactly the silent drift this exists to end, so ask for a pin.
  const ref = parseImageRef(found.from.image)
  if (!ref.digest && (!ref.tag || ref.tag === 'latest' || pattern === 'latest' || pattern === 'digest')) {
    return {
      ok: false,
      reason: `${rel}: the base ${found.from.image} floats; pin it by digest (FROM ${found.from.image}@sha256:...) so a move is a pull request`,
    }
  }
  return { ok: true, base: { dockerfile: rel, ref: found.from.image } }
}

export function scanRepo(repoRoot: string, excludeStacks: string[] = []): ScannedService[] {
  return findComposeFiles(repoRoot).flatMap((f) => scanComposeFile(repoRoot, f, excludeStacks))
}
