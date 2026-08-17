import { parseDocument, parse as parseYamlValue, isMap, isScalar, isSeq } from 'yaml'
import type { Pair, Scalar, YAMLMap } from 'yaml'

/**
 * Writing one `shipshape.*` label into compose-file text and provably nothing else.
 *
 * Same discipline as gitops/editor.ts and for the same reason: these files are heavily
 * commented, and a YAML emitter would quietly reflow all of it. The label is located
 * through the document tree, its byte range spliced, and the result re-parsed and
 * compared against the original with the one intended change normalised away. Pure --
 * no fs, no git -- so the whole matrix of layouts is testable as string in, string out.
 */

export type SetLabelResult = { ok: true; text: string } | { ok: false; reason: string }

const refuse = (reason: string): SetLabelResult => ({ ok: false, reason })

/**
 * Set, replace, or (`value === null`) remove `services.<service>.labels.<key>`.
 * Removing a key that is not there returns the text unchanged: idempotent, so a caller
 * cleaning up `shipshape.pr` does not have to check whether the line exists first.
 */
export function setLabel(
  text: string,
  service: string,
  key: string,
  value: string | null,
): SetLabelResult {
  const doc = parseDocument(text, { keepSourceTokens: true })
  if (doc.errors.length > 0) {
    return refuse(`the file is not valid YAML: ${doc.errors[0]!.message}`)
  }

  const svc = doc.getIn(['services', service], true)
  if (!isMap(svc)) return refuse(`no service "${service}" in this file`)
  if (svc.flow || svc.items.length === 0) {
    return refuse(`service "${service}" is written in flow style; edit it by hand`)
  }

  const labelsNode = doc.getIn(['services', service, 'labels'], true)
  if (isSeq(labelsNode)) {
    return refuse(
      `the labels for "${service}" use the list form (- key=value), which cannot be ` +
        `edited line-by-line without rewriting the block; convert it to map form first`,
    )
  }
  if (isMap(labelsNode) && labelsNode.flow) {
    return refuse(`the labels for "${service}" are in flow style ({...}); edit them by hand`)
  }

  const formatted = value === null ? null : formatValue(key, value)
  let edited: string

  if (isMap(labelsNode) && labelsNode.items.length > 0) {
    const pair = findPair(labelsNode, key)
    if (pair) {
      if (formatted === null) {
        const cut = deleteLabelLine(text, svc, labelsNode, pair)
        if (!cut.ok) return cut
        edited = cut.text
      } else {
        const v = pair.value
        if (!isScalar(v) || !v.range) {
          return refuse(`the ${key} value for "${service}" is not a plain scalar`)
        }
        if (text.slice(v.range[0], v.range[1]) === formatted) return { ok: true, text }
        edited = text.slice(0, v.range[0]) + formatted + text.slice(v.range[1])
      }
    } else {
      if (formatted === null) return { ok: true, text }
      const ins = insertAfterLastLabel(text, labelsNode, key, formatted)
      if (!ins.ok) return ins
      edited = ins.text
    }
  } else {
    // No labels map: either the key is absent entirely, or it exists with an empty
    // value (`labels:` and nothing under it).
    if (formatted === null) return { ok: true, text }
    const ins = insertLabelsBlock(text, svc, key, formatted)
    if (!ins.ok) return ins
    edited = ins.text
  }

  return verifyRoundTrip(text, edited, service, key, value, formatted)
}

/**
 * `shipshape.watch` is quoted because the repo's 140 existing lines all write
 * `"true"`/`"false"` -- and because bare `true` would round-trip as a YAML boolean.
 * Everything else is written bare unless YAML would read the bare spelling back as
 * something other than that exact string (a boolean, a number, a second document line);
 * those are JSON-quoted, which doubles as the guard against a value smuggling a newline
 * into the file as a new key.
 */
function formatValue(key: string, value: string): string {
  if (key === 'shipshape.watch') return JSON.stringify(value)
  let parsed: unknown
  try {
    parsed = parseYamlValue(value)
  } catch {
    parsed = undefined
  }
  return parsed === value ? value : JSON.stringify(value)
}

function findPair(map: YAMLMap, key: string): Pair<unknown, unknown> | undefined {
  return map.items.find((p) => isScalar(p.key) && String(p.key.value) === key)
}

/** [start of the line containing `at`, exclusive end just past its newline]. */
function lineBounds(text: string, at: number, endPos: number): { start: number; end: number } {
  const start = text.lastIndexOf('\n', at - 1) + 1
  const nl = text.indexOf('\n', endPos)
  return { start, end: nl === -1 ? text.length : nl + 1 }
}

function pairEnd(pair: Pair<unknown, unknown>): number {
  const k = pair.key as Scalar
  const v = pair.value
  return isScalar(v) && v.range ? Math.max(v.range[1], k.range![1]) : k.range![1]
}

function deleteLabelLine(
  text: string,
  svc: YAMLMap,
  labels: YAMLMap,
  pair: Pair<unknown, unknown>,
): SetLabelResult {
  const k = pair.key
  if (!isScalar(k) || !k.range) return refuse('the label key has no source range')
  const { start, end } = lineBounds(text, k.range[0], pairEnd(pair))

  if (labels.items.length === 1) {
    // Deleting the only label would leave a dangling `labels:` reading as null -- an
    // unfinished edit to anyone opening the file -- so the block goes with it. If a
    // comment sits between `labels:` and its one entry it is swept up here; the
    // caller's diff gate turns that into a refusal rather than a silent deletion.
    const labelsPair = findPair(svc, 'labels')
    const lk = labelsPair?.key
    if (!lk || !isScalar(lk) || !lk.range) return refuse('the labels key has no source range')
    const blockStart = text.lastIndexOf('\n', lk.range[0] - 1) + 1
    return { ok: true, text: text.slice(0, blockStart) + text.slice(end) }
  }
  return { ok: true, text: text.slice(0, start) + text.slice(end) }
}

function insertAfterLastLabel(
  text: string,
  labels: YAMLMap,
  key: string,
  formatted: string,
): SetLabelResult {
  const last = labels.items[labels.items.length - 1]!
  const k = last.key
  if (!isScalar(k) || !k.range) return refuse('the last label has no source range')
  const { start, end } = lineBounds(text, k.range[0], pairEnd(last))
  const indent = text.slice(start, k.range[0])
  if (!/^[ \t]*$/.test(indent)) return refuse('the last label does not start its line')
  // A last label sitting on an unterminated final line needs its newline supplied.
  const prefix = end === text.length && !text.endsWith('\n') ? '\n' : ''
  return {
    ok: true,
    text: text.slice(0, end) + `${prefix}${indent}${key}: ${formatted}\n` + text.slice(end),
  }
}

/**
 * No labels map exists. Insert a whole block: after the `labels:` line when the key is
 * present but empty, otherwise directly under `image:` -- the line every service has
 * and the one an operator scanning the file reads first.
 */
function insertLabelsBlock(
  text: string,
  svc: YAMLMap,
  key: string,
  formatted: string,
): SetLabelResult {
  const emptyLabels = findPair(svc, 'labels')
  if (emptyLabels) {
    const lk = emptyLabels.key
    if (!isScalar(lk) || !lk.range) return refuse('the labels key has no source range')
    const { start, end } = lineBounds(text, lk.range[0], pairEnd(emptyLabels))
    const indent = text.slice(start, lk.range[0])
    return {
      ok: true,
      text: text.slice(0, end) + `${indent}  ${key}: ${formatted}\n` + text.slice(end),
    }
  }

  const anchor = findPair(svc, 'image') ?? svc.items[0]!
  const ak = anchor.key
  if (!isScalar(ak) || !ak.range) return refuse('found no line to anchor a labels block on')
  const { start, end } = lineBounds(text, ak.range[0], pairEnd(anchor))
  const indent = text.slice(start, ak.range[0])
  if (!/^[ \t]*$/.test(indent)) return refuse('the anchor line does not start with its key')
  return {
    ok: true,
    text:
      text.slice(0, end) +
      `${indent}labels:\n${indent}  ${key}: ${formatted}\n` +
      text.slice(end),
  }
}

/**
 * The splice is only trusted after the result re-parses to the original document with
 * exactly the intended label changed. Key order is canonicalised away: inserting
 * `labels:` after `image:` puts the key mid-map, while applying the same change to a
 * parsed object appends it, and that difference is layout, not meaning.
 */
function verifyRoundTrip(
  before: string,
  after: string,
  service: string,
  key: string,
  value: string | null,
  formatted: string | null,
): SetLabelResult {
  const reparsed = parseDocument(after)
  if (reparsed.errors.length > 0) {
    return refuse(`the edit produced invalid YAML: ${reparsed.errors[0]!.message}`)
  }

  type Svc = { labels?: Record<string, unknown> }
  const expected = (parseDocument(before).toJS() ?? {}) as { services?: Record<string, Svc> }
  const got = (reparsed.toJS() ?? {}) as Record<string, unknown>

  const svcObj = expected.services?.[service]
  if (!svcObj || typeof svcObj !== 'object') return refuse(`no service "${service}" in this file`)
  const labels = (svcObj.labels ?? {}) as Record<string, unknown>
  if (value === null) {
    delete labels[key]
    if (Object.keys(labels).length === 0) delete svcObj.labels
    else svcObj.labels = labels
  } else {
    labels[key] = parseYamlValue(formatted!)
    svcObj.labels = labels
  }

  if (canon(got) !== canon(expected)) {
    return refuse('the edit changed more than the target label')
  }
  return { ok: true, text: after }
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
