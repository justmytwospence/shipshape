import { parseDocument, isMap, isScalar, isSeq } from 'yaml'
import type { Pair, Scalar, YAMLMap } from 'yaml'
import { setLabel } from './edit.ts'

/**
 * Moving a fork (FORKS.md) onto a new upstream release in compose-file text, and provably
 * nothing else.
 *
 * Same discipline as gitops/editor.ts and compose/edit.ts: these files are heavily
 * commented, so no YAML emitter. Every value is located through the document tree, its
 * byte range spliced, and the result re-parsed and compared against the original with the
 * intended changes normalised away. Pure -- no fs, no git -- so every layout is testable
 * as string in, string out.
 *
 * A fork is pinned in four places, and a bump moves exactly those:
 *
 *   build.context:  https://github.com/<owner>/<repo>.git#<sha>   -> the rebased sha
 *   image:          <name>:<base>-<short sha>                      -> <name>:<target>-<short sha>
 *   shipshape.fork.upstream: <upstream>:<base>[@digest]           -> the upstream at <target>
 *   build.args.*:   any value carrying the base tag, the sha or its short form follows
 *
 * A retire puts the plain upstream service back: `image:` becomes the upstream reference,
 * the `build:` block and both `shipshape.fork.*` labels go. The comment block that
 * explains the fork is prose and is left for a person.
 */

export type ForkEditResult =
  | { ok: true; text: string }
  /** `alreadyApplied`: the file already carries this change -- done, not broken. */
  | { ok: false; reason: string; alreadyApplied?: boolean }

const refuse = (reason: string): ForkEditResult => ({ ok: false, reason })

/** What the compose file says a fork is built from. */
export interface ForkPin {
  /** The fork repository, as `build.context` names it without the `#<sha>`. */
  contextUrl: string
  /** The pinned commit, in full. */
  sha: string
  /** The sha as `image:` abbreviates it (whatever length the file chose). */
  shortSha: string
  /** `image:` as written. */
  image: string
  /** `image:` without its tag: the local build name. */
  imageName: string
  /** The upstream version the fork is based on, as `image:` spells it. */
  baseTag: string
  /** `shipshape.fork.upstream` as written. */
  upstream: string
  /** `build.args` as `key -> value`, for the values a bump has to follow. */
  args: Record<string, string>
}

/** `<url>#<sha>`: a pinned git build context. */
const CONTEXT = /^(\S+?)#([0-9a-f]{7,40})$/

/**
 * Read the fork's pin out of the file. Refuses on any shape the editor could not bump, so a
 * fork that is written unusually is reported before anything is rebased for it.
 */
export function readForkPin(text: string, service: string): { ok: true; pin: ForkPin } | { ok: false; reason: string } {
  const doc = parseDocument(text, { keepSourceTokens: true })
  if (doc.errors.length > 0) return { ok: false, reason: `the file is not valid YAML: ${doc.errors[0]!.message}` }
  const svc = doc.getIn(['services', service], true)
  if (!isMap(svc)) return { ok: false, reason: `no service "${service}" in this file` }

  const context = doc.getIn(['services', service, 'build', 'context'], true)
  if (!isScalar(context) || typeof context.value !== 'string') {
    return { ok: false, reason: `${service} has no build.context to move: a fork is built from a pinned git URL` }
  }
  const m = CONTEXT.exec(context.value)
  if (!m) {
    return { ok: false, reason: `build.context "${context.value}" is not pinned to a commit (expected <url>#<sha>)` }
  }
  const [, contextUrl, sha] = m as unknown as [string, string, string]

  const image = doc.getIn(['services', service, 'image'], true)
  if (!isScalar(image) || typeof image.value !== 'string') {
    return { ok: false, reason: `${service} has no image: naming its local build` }
  }
  const colon = image.value.lastIndexOf(':')
  const slash = image.value.lastIndexOf('/')
  if (colon === -1 || colon < slash) {
    return { ok: false, reason: `image "${image.value}" has no tag; a fork's tag is <upstream version>-<short sha>` }
  }
  const imageName = image.value.slice(0, colon)
  const tag = image.value.slice(colon + 1)
  const dash = tag.lastIndexOf('-')
  const shortSha = dash === -1 ? '' : tag.slice(dash + 1)
  if (!shortSha || !/^[0-9a-f]{7,40}$/.test(shortSha) || !sha.startsWith(shortSha)) {
    return {
      ok: false,
      reason: `image tag "${tag}" does not end with the pinned commit ${sha.slice(0, 7)} (expected <upstream version>-<short sha>)`,
    }
  }
  const baseTag = tag.slice(0, dash)
  if (!baseTag) return { ok: false, reason: `image tag "${tag}" carries no upstream version before the sha` }

  const upstream = doc.getIn(['services', service, 'labels', 'shipshape.fork.upstream'], true)
  if (!isScalar(upstream) || typeof upstream.value !== 'string' || !upstream.value.trim()) {
    return { ok: false, reason: `${service} has no shipshape.fork.upstream label` }
  }

  const args: Record<string, string> = {}
  const argsNode = doc.getIn(['services', service, 'build', 'args'], true)
  if (isMap(argsNode)) {
    for (const p of argsNode.items) {
      if (isScalar(p.key) && isScalar(p.value)) args[String(p.key.value)] = String(p.value.value ?? '')
    }
  } else if (isSeq(argsNode)) {
    for (const item of argsNode.items) {
      if (!isScalar(item) || typeof item.value !== 'string') continue
      const eq = item.value.indexOf('=')
      if (eq !== -1) args[item.value.slice(0, eq)] = item.value.slice(eq + 1)
    }
  }

  return {
    ok: true,
    pin: { contextUrl, sha, shortSha, image: image.value, imageName, baseTag, upstream: upstream.value, args },
  }
}

export interface BumpForkInput {
  /** The pinned commit the file is expected to carry now. */
  expectedSha: string
  /** The rebased commit. */
  newSha: string
  /** The upstream version the fork now sits on, as `image:` should spell it. */
  newTag: string
  /** The full `shipshape.fork.upstream` value at the new version (tag, with its digest when the old one had one). */
  newUpstream: string
}

interface Splice {
  start: number
  end: number
  text: string
}

/**
 * Move the fork's four pins to the new release. The splices are collected, applied from
 * the end of the file backwards so earlier offsets stay valid, and the whole result is
 * verified against the original.
 */
export function bumpFork(text: string, service: string, input: BumpForkInput): ForkEditResult {
  const read = readForkPin(text, service)
  if (!read.ok) return refuse(read.reason)
  const pin = read.pin

  const newShort = input.newSha.slice(0, pin.shortSha.length)
  const newImage = `${pin.imageName}:${input.newTag}-${newShort}`
  const newContext = `${pin.contextUrl}#${input.newSha}`

  if (pin.sha !== input.expectedSha) {
    const applied = pin.sha === input.newSha && pin.image === newImage && pin.upstream === input.newUpstream
    return {
      ok: false,
      alreadyApplied: applied,
      reason: applied
        ? `${service} already builds from ${input.newSha.slice(0, 7)} at ${input.newTag}`
        : `${service} now builds from ${pin.sha.slice(0, 7)}, expected ${input.expectedSha.slice(0, 7)}`,
    }
  }

  const doc = parseDocument(text, { keepSourceTokens: true })
  const scalarAt = (path: (string | number)[]): Scalar | null => {
    const n = doc.getIn(path, true)
    return isScalar(n) && n.range ? n : null
  }
  const splices: Splice[] = []
  const splice = (node: Scalar, value: string) => {
    // A quoted scalar's range covers the quotes; the replacement keeps the quoting.
    const q = node.type === 'QUOTE_DOUBLE' ? '"' : node.type === 'QUOTE_SINGLE' ? "'" : ''
    splices.push({ start: node.range![0], end: node.range![1], text: `${q}${value}${q}` })
  }

  const context = scalarAt(['services', service, 'build', 'context'])
  const image = scalarAt(['services', service, 'image'])
  const upstream = scalarAt(['services', service, 'labels', 'shipshape.fork.upstream'])
  if (!context || !image || !upstream) return refuse('a pinned value has no source range')
  if (context.type && context.type !== 'PLAIN') return refuse('build.context is quoted; the editor only rewrites plain scalars')
  if (image.type && image.type !== 'PLAIN') return refuse('image: is quoted; the editor only rewrites plain scalars')
  if (upstream.type && upstream.type !== 'PLAIN') return refuse('shipshape.fork.upstream is quoted; the editor only rewrites plain scalars')
  splice(context, newContext)
  splice(image, newImage)
  splice(upstream, input.newUpstream)

  // Only inside build.args values: the base tag, the sha and its short form each follow.
  // Nowhere else -- a comment that mentions the old version is prose, and an environment
  // variable that happens to equal the tag is not the fork's pin.
  const follow = (v: string): string => followValue(v, pin, input.newSha, newShort, input.newTag)
  const argsNode = doc.getIn(['services', service, 'build', 'args'], true)
  const expectedArgs: Record<string, string> = {}
  if (isMap(argsNode)) {
    for (const p of argsNode.items) {
      if (!isScalar(p.key) || !isScalar(p.value) || !p.value.range) continue
      const key = String(p.key.value)
      const old = String(p.value.value ?? '')
      const next = follow(old)
      expectedArgs[key] = next
      if (next !== old) {
        if (p.value.type && p.value.type !== 'PLAIN' && p.value.type !== 'QUOTE_DOUBLE' && p.value.type !== 'QUOTE_SINGLE') {
          return refuse(`build.args.${key} is not a plain or quoted scalar`)
        }
        splice(p.value, next)
      }
    }
  } else if (isSeq(argsNode)) {
    for (const item of argsNode.items) {
      if (!isScalar(item) || typeof item.value !== 'string' || !item.range) continue
      const eq = item.value.indexOf('=')
      if (eq === -1) continue
      const key = item.value.slice(0, eq)
      const old = item.value.slice(eq + 1)
      const next = follow(old)
      expectedArgs[key] = next
      if (next !== old) splice(item, `${key}=${next}`)
    }
  }

  const after = applySplices(text, splices)

  // The result must re-parse to the original with exactly these changes.
  const reparsed = parseDocument(after)
  if (reparsed.errors.length > 0) return refuse(`the edit produced invalid YAML: ${reparsed.errors[0]!.message}`)
  type Svc = { build?: { context?: unknown; args?: unknown }; image?: unknown; labels?: Record<string, unknown> }
  const expected = (parseDocument(text).toJS() ?? {}) as { services?: Record<string, Svc> }
  const got = (reparsed.toJS() ?? {}) as Record<string, unknown>
  const e = expected.services?.[service]
  if (!e || !e.build || typeof e.build !== 'object') return refuse(`no service "${service}" in this file`)
  e.build.context = newContext
  if (e.build.args !== undefined) {
    e.build.args = Array.isArray(e.build.args)
      ? (e.build.args as unknown[]).map((x) =>
          typeof x === 'string' && x.includes('=') ? `${x.slice(0, x.indexOf('='))}=${expectedArgs[x.slice(0, x.indexOf('='))] ?? x.slice(x.indexOf('=') + 1)}` : x,
        )
      : Object.fromEntries(
          Object.entries(e.build.args as Record<string, unknown>).map(([k, v]) => [
            k,
            k in expectedArgs ? expectedArgs[k] : v,
          ]),
        )
  }
  e.image = newImage
  e.labels = { ...(e.labels ?? {}), 'shipshape.fork.upstream': input.newUpstream }
  if (canon(got) !== canon(expected)) return refuse('the edit changed more than the fork pins')

  // And line for line: the same number of lines, each changed line one of the splices.
  const changed = changedLines(text, after)
  if (changed === null) return refuse('the edit added or removed lines')
  if (changed.length > splices.length) return refuse('the edit touched a line it did not mean to')

  return { ok: true, text: after }
}

/**
 * The new spelling of one `build.args` value: the full sha first, then the short one, then
 * the base tag -- longest first so the short sha never matches inside the long one. The
 * tag is only replaced where it stands as a whole version (`v3.3.3` in `v3.3.3-fork.x`,
 * not in `v3.3.30`).
 */
function followValue(v: string, pin: ForkPin, newSha: string, newShort: string, newTag: string): string {
  let out = v.split(pin.sha).join(newSha)
  out = out.split(pin.shortSha).join(newShort)
  const tag = pin.baseTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  out = out.replace(new RegExp(`(^|[^0-9A-Za-z.])${tag}(?![0-9A-Za-z.])`, 'g'), `$1${newTag}`)
  return out
}

function applySplices(text: string, splices: Splice[]): string {
  const sorted = [...splices].sort((a, b) => b.start - a.start)
  let out = text
  for (const s of sorted) out = out.slice(0, s.start) + s.text + out.slice(s.end)
  return out
}

/** Indices of the lines that differ, or null when the line count changed. */
function changedLines(before: string, after: string): number[] | null {
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length !== b.length) return null
  const out: number[] = []
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i)
  return out
}

export interface RetireForkInput {
  /** The pinned commit the file is expected to carry now. */
  expectedSha: string
  /** The plain upstream reference `image:` goes back to. */
  upstreamRef: string
}

/**
 * Put the plain upstream service back: `image:` becomes the upstream reference, the
 * `build:` block and both fork labels go. Nothing else moves; the comment that explained
 * the fork is left for a person to rewrite.
 */
export function retireFork(text: string, service: string, input: RetireForkInput): ForkEditResult {
  const read = readForkPin(text, service)
  if (!read.ok) {
    // A file that no longer has a build: block and already names the upstream has been
    // retired -- by this editor earlier, or by hand.
    const doc = parseDocument(text)
    const image = doc.getIn(['services', service, 'image'])
    const build = doc.getIn(['services', service, 'build'])
    const fork = doc.getIn(['services', service, 'labels', 'shipshape.fork.upstream'])
    if (image === input.upstreamRef && build === undefined && fork === undefined) {
      return { ok: false, alreadyApplied: true, reason: `${service} already runs the upstream image ${input.upstreamRef}` }
    }
    return refuse(read.reason)
  }
  const pin = read.pin
  if (pin.sha !== input.expectedSha) {
    return { ok: false, reason: `${service} now builds from ${pin.sha.slice(0, 7)}, expected ${input.expectedSha.slice(0, 7)}` }
  }

  const doc = parseDocument(text, { keepSourceTokens: true })
  const svc = doc.getIn(['services', service], true) as YAMLMap
  if (svc.flow) return refuse(`service "${service}" is written in flow style; edit it by hand`)

  const image = doc.getIn(['services', service, 'image'], true)
  if (!isScalar(image) || !image.range) return refuse('image: has no source range')
  if (image.type && image.type !== 'PLAIN') return refuse('image: is quoted; the editor only rewrites plain scalars')

  const buildPair = svc.items.find((p) => isScalar(p.key) && p.key.value === 'build') as Pair<Scalar, unknown> | undefined
  if (!buildPair || !buildPair.key.range) return refuse('build: has no source range')
  const buildEnd = nodeEnd(buildPair)
  if (buildEnd === null) return refuse('build: block has no source range')
  const buildStart = text.lastIndexOf('\n', buildPair.key.range[0] - 1) + 1
  const buildStop = text.indexOf('\n', buildEnd - 1)
  const indent = text.slice(buildStart, buildPair.key.range[0])
  if (!/^[ \t]*$/.test(indent)) return refuse('build: does not start its line')

  // The image first (later in the file than build: or not, the splices are applied from
  // the end), then the whole build block, lines inclusive.
  let after = applySplices(text, [
    { start: image.range[0], end: image.range[1], text: input.upstreamRef },
    { start: buildStart, end: buildStop === -1 ? text.length : buildStop + 1, text: '' },
  ])

  for (const key of ['shipshape.fork.upstream', 'shipshape.fork.waits-on']) {
    const cut = setLabel(after, service, key, null)
    if (!cut.ok) return refuse(cut.reason)
    after = cut.text
  }

  const reparsed = parseDocument(after)
  if (reparsed.errors.length > 0) return refuse(`the edit produced invalid YAML: ${reparsed.errors[0]!.message}`)
  type Svc = { build?: unknown; image?: unknown; labels?: Record<string, unknown> }
  const expected = (parseDocument(text).toJS() ?? {}) as { services?: Record<string, Svc> }
  const got = (reparsed.toJS() ?? {}) as Record<string, unknown>
  const e = expected.services?.[service]
  if (!e) return refuse(`no service "${service}" in this file`)
  delete e.build
  e.image = input.upstreamRef
  if (e.labels) {
    delete e.labels['shipshape.fork.upstream']
    delete e.labels['shipshape.fork.waits-on']
    if (Object.keys(e.labels).length === 0) delete e.labels
  }
  if (canon(got) !== canon(expected)) return refuse('the edit changed more than the fork')
  return { ok: true, text: after }
}

/** The byte just past the last scalar inside a pair's value, for a block mapping. */
function nodeEnd(pair: Pair<unknown, unknown>): number | null {
  const v = pair.value
  if (isScalar(v)) return v.range ? v.range[1] : null
  if (isMap(v) || isSeq(v)) {
    let end: number | null = v.range ? v.range[1] : null
    for (const item of v.items) {
      const e = isMap(v) ? nodeEnd(item as Pair<unknown, unknown>) : isScalar(item) ? (item.range ? item.range[1] : null) : nodeEnd({ key: null, value: item } as Pair<unknown, unknown>)
      if (e !== null && (end === null || e > end)) end = e
    }
    return end
  }
  return null
}

/** JSON with object keys sorted, so comparison sees structure rather than layout. */
function canon(x: unknown): string {
  return JSON.stringify(sortKeys(x))
}

function sortKeys(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sortKeys)
  if (x && typeof x === 'object' && !(x instanceof Date)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(x as Record<string, unknown>).sort()) {
      out[k] = sortKeys((x as Record<string, unknown>)[k])
    }
    return out
  }
  return x
}
