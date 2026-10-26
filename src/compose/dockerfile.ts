/**
 * Reading and rewriting the `FROM` lines of a Dockerfile we build ourselves.
 *
 * A service with `build:` runs an image nothing publishes, so there is no registry to
 * poll for it -- but its base image is published, and that is where most of what it
 * carries comes from: the distribution's packages, the language runtime, OpenSSL. Left
 * alone, a local build keeps whatever base it was last built on, and `compose up -d`
 * reuses that image indefinitely. So a watched `build:` service is watched through the
 * base of its final stage (see compose/scan.ts), and its bump is an edit to the `FROM`
 * line here.
 *
 * Same discipline as the compose editors: pure (string in, string out), the edit is a
 * splice of the image token's bytes, and the result is re-parsed and compared before it
 * is trusted. Anything this module does not fully understand -- an `escape` directive, a
 * `FROM` continued across lines, an image named by a build argument -- is refused in
 * words rather than guessed at.
 */

export interface FromLine {
  /** 1-based line number. */
  line: number
  /** The image reference exactly as written. */
  image: string
  /** `AS <name>`, lowercased, or null. */
  alias: string | null
  /** Byte range of `image` in the text. */
  start: number
  end: number
}

export type ParseResult = { ok: true; froms: FromLine[] } | { ok: false; reason: string }

const FROM_RE = /^([ \t]*)FROM([ \t]+)/i

/** Every `FROM` instruction, in order. */
export function parseFroms(text: string): ParseResult {
  const lines = text.split('\n')
  // Parser directives sit before the first instruction. `escape` changes what a line
  // continuation is, and nothing here is written to follow that.
  for (const l of lines) {
    if (!/^\s*#/.test(l)) break
    if (/^\s*#\s*escape\s*=/i.test(l)) return { ok: false, reason: 'the Dockerfile sets an escape directive' }
  }

  const froms: FromLine[] = []
  let offset = 0
  let continued = false
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const lineStart = offset
    offset += raw.length + 1
    const l = raw.replace(/\r$/, '')
    const wasContinued = continued
    continued = /\\\s*$/.test(l) && !/^\s*#/.test(l)
    if (wasContinued) continue
    const m = FROM_RE.exec(l)
    if (!m) continue
    if (continued) return { ok: false, reason: `line ${i + 1}: a FROM continued across lines` }

    // FROM [--platform=<p>] <image> [AS <name>]
    let rest = l.slice(m[0].length)
    let at = lineStart + m[0].length
    for (;;) {
      const flag = /^(--\S+)([ \t]+)/.exec(rest)
      if (!flag) break
      rest = rest.slice(flag[0].length)
      at += flag[0].length
    }
    const tok = /^(\S+)/.exec(rest)
    if (!tok) return { ok: false, reason: `line ${i + 1}: FROM names no image` }
    const image = tok[1]!
    const after = rest.slice(image.length).replace(/\s+#.*$/, '').trim()
    let alias: string | null = null
    if (after) {
      const as = /^AS[ \t]+(\S+)$/i.exec(after)
      if (!as) return { ok: false, reason: `line ${i + 1}: cannot read "${l.trim()}"` }
      alias = as[1]!.toLowerCase()
    }
    froms.push({ line: i + 1, image, alias, start: at, end: at + image.length })
  }
  if (froms.length === 0) return { ok: false, reason: 'the Dockerfile has no FROM' }
  return { ok: true, froms }
}

export type BaseResult = { ok: true; from: FromLine } | { ok: false; reason: string }

/**
 * The published image the final stage is built on: the last `FROM`, followed back through
 * any earlier stage it names (`FROM base AS final` where `base` is `FROM node:22 AS base`).
 * The final stage is what runs, so its base is what decides which distribution packages
 * and runtime ship -- a builder stage's base leaves only what is copied out of it.
 */
export function finalBase(froms: FromLine[]): BaseResult {
  let idx = froms.length - 1
  for (let hops = 0; hops <= froms.length; hops++) {
    const f = froms[idx]!
    const name = f.image.toLowerCase()
    if (name === 'scratch') return { ok: false, reason: 'the final stage is FROM scratch' }
    if (f.image.includes('$')) {
      return { ok: false, reason: `line ${f.line}: the base image is set by a build argument (${f.image})` }
    }
    // A stage can only name a stage declared before it.
    const stage = froms.slice(0, idx).map((s, i) => ({ s, i })).reverse().find(({ s }) => s.alias === name)
    if (!stage) return { ok: true, from: f }
    idx = stage.i
  }
  return { ok: false, reason: 'the stages name each other in a loop' }
}

export type RewriteResult = { ok: true; text: string; count: number } | { ok: false; reason: string; alreadyApplied?: boolean }

/**
 * Point every `FROM` that names `oldRef` at `newRef`, and provably nothing else.
 *
 * Every line naming the same image moves together: a builder and a runtime stage on one
 * base are one base, and leaving one behind would build half the image on each.
 */
export function rewriteFroms(text: string, oldRef: string, newRef: string): RewriteResult {
  const parsed = parseFroms(text)
  if (!parsed.ok) return parsed
  const hits = parsed.froms.filter((f) => f.image === oldRef)
  if (hits.length === 0) {
    const already = parsed.froms.some((f) => f.image === newRef)
    return {
      ok: false,
      alreadyApplied: already,
      reason: already
        ? `the Dockerfile already builds FROM ${newRef}`
        : `the Dockerfile no longer builds FROM ${oldRef} (it names ${[...new Set(parsed.froms.map((f) => f.image))].join(', ')})`,
    }
  }
  let out = text
  for (const f of [...hits].reverse()) out = out.slice(0, f.start) + newRef + out.slice(f.end)

  // The gate: re-parsed, the instructions are the same instructions with exactly the
  // intended image changed, and every other byte outside the FROM lines is untouched.
  const again = parseFroms(out)
  if (!again.ok) return { ok: false, reason: `the edit produced an unreadable Dockerfile: ${again.reason}` }
  if (again.froms.length !== parsed.froms.length) return { ok: false, reason: 'the edit changed the number of stages' }
  for (let i = 0; i < parsed.froms.length; i++) {
    const a = parsed.froms[i]!
    const b = again.froms[i]!
    const want = a.image === oldRef ? newRef : a.image
    if (b.image !== want || b.alias !== a.alias || b.line !== a.line) {
      return { ok: false, reason: `the edit changed more than the base image (line ${a.line})` }
    }
  }
  const before = text.split('\n')
  const after = out.split('\n')
  if (before.length !== after.length) return { ok: false, reason: 'the edit changed the number of lines' }
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i] && !FROM_RE.test(before[i]!)) {
      return { ok: false, reason: `the edit touched a line that is not a FROM (line ${i + 1})` }
    }
  }
  return { ok: true, text: out, count: hits.length }
}
