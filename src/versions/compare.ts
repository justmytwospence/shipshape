import { classify, compareTags, parseTag, type Magnitude, type PatternKind, type ParsedTag } from './patterns.ts'

export interface SelectOptions {
  currentTag: string
  availableTags: string[]
  kind: PatternKind
  /** Optional refinement applied on top of the pattern (the `shipshape.tag.include`
   *  label). A tag must satisfy BOTH to be considered. */
  tagInclude?: string | null
  /** Custom regex when kind === 'regex'. */
  regex?: string | null
}

/**
 * The outcome of a comparison.
 *
 * "no update" and "I could not read this" are deliberately different results. Collapsing
 * them into a single null is how an update tool ends up confidently reporting that a
 * stale image is current -- the worst failure available to it, because it is silent.
 * Anything other than `update` or `up-to-date` is a condition a human should see.
 */
export type Comparison =
  | { status: 'update'; tag: string; magnitude: Magnitude }
  /** `constrainedFrom` names a newer tag that a `tag.include` refinement suppressed --
   *  e.g. postgres pinned inside `^16\.` while 18 exists. Purely informational, so a
   *  deliberate constraint stays visible instead of looking like genuine currency. */
  | { status: 'up-to-date'; constrainedFrom?: string }
  /** The pinned tag does not parse under its declared pattern -- wrong or missing
   *  `shipshape.pattern`, or the operator moved the service onto a different tag series. */
  | { status: 'unparseable-current'; detail: string }
  /** `latest`/`digest`: no ordering exists. Movement is detected by digest instead. */
  | { status: 'not-orderable' }
  /** A `shipshape.tag.include` that does not compile. Failing closed here is intentional:
   *  ignoring a broken refinement would silently widen the candidate set. */
  | { status: 'bad-refinement'; detail: string }

export function selectUpdate(opts: SelectOptions): Comparison {
  const { currentTag, availableTags, kind, tagInclude, regex } = opts

  if (kind === 'latest' || kind === 'digest') return { status: 'not-orderable' }

  const current = parseTag(currentTag, kind, regex)
  if (!current) {
    return {
      status: 'unparseable-current',
      detail: `tag "${currentTag}" does not match pattern "${kind}"`,
    }
  }

  let include: RegExp | null = null
  if (tagInclude) {
    try {
      include = new RegExp(tagInclude)
    } catch (err) {
      return {
        status: 'bad-refinement',
        detail: `tag.include "${tagInclude}" is not a valid regex: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  // "Same series" is what stops `postgres:16` drifting onto `16-alpine`, or a `-lsN` tag
  // being ranked against a `nightly-*` build: a tag that does not parse under the
  // pattern is not a candidate at all.
  let best: ParsedTag | null = null
  for (const tag of availableTags) {
    if (include && !include.test(tag)) continue
    const parsed = parseTag(tag, kind, regex)
    if (!parsed) continue
    // A different flavour is a different image, never a newer version of this one.
    if (parsed.variant !== current.variant) continue
    if (compareTags(parsed, current) <= 0) continue
    if (!best || compareTags(parsed, best) > 0) best = parsed
  }

  if (!best) {
    // Nothing newer passed the refinement. Check whether the refinement is what
    // suppressed it, so the UI can say "constrained" rather than "up to date".
    if (include) {
      let unconstrained: ParsedTag | null = null
      for (const tag of availableTags) {
        const parsed = parseTag(tag, kind, regex)
        if (!parsed) continue
        if (parsed.variant !== current.variant) continue
        if (compareTags(parsed, current) <= 0) continue
        if (!unconstrained || compareTags(parsed, unconstrained) > 0) unconstrained = parsed
      }
      if (unconstrained) return { status: 'up-to-date', constrainedFrom: unconstrained.raw }
    }
    return { status: 'up-to-date' }
  }
  return { status: 'update', tag: best.raw, magnitude: classify(current, best, kind) }
}

/** Every newer tag in the series, oldest first. The changelog assembler hands Claude the
 *  full set of intermediate releases rather than just the endpoints, so a summary covers
 *  what actually accumulated across the gap. */
export function intermediateTags(opts: SelectOptions): string[] {
  const { currentTag, availableTags, kind, tagInclude, regex } = opts
  const current = parseTag(currentTag, kind, regex)
  if (!current) return []
  let include: RegExp | null = null
  if (tagInclude) {
    try {
      include = new RegExp(tagInclude)
    } catch {
      return []
    }
  }
  return availableTags
    .filter((t) => !include || include.test(t))
    .map((t) => parseTag(t, kind, regex))
    .filter((p): p is ParsedTag => !!p && p.variant === current.variant && compareTags(p, current) > 0)
    .sort(compareTags)
    .map((p) => p.raw)
}
