import { isMap, isScalar, isSeq, parse as parseYaml, parseDocument, type Document } from 'yaml'

/**
 * Applying model-authored configuration changes to a compose file.
 *
 * The model never emits YAML or a diff. It emits operations from a fixed vocabulary,
 * and this applies them deterministically -- because a model-written diff mis-applies
 * silently, whereas an operation either matches the document or is refused by name.
 *
 * Everything is byte-splicing guided by the parsed document, the same discipline the
 * image editor uses: compose files here carry comments on almost every line, and a YAML
 * emitter would quietly reformat all of them.
 */

/**
 * Every op may name the service it targets. Absent means the service being updated,
 * which is the only one reachable at the default scope.
 */
export type Op = { service?: string; file?: string } & (
  | { op: 'set_image'; image: string }
  | { op: 'set_env'; key: string; value: string }
  | { op: 'remove_env'; key: string }
  | { op: 'rename_env'; from: string; to: string }
  | { op: 'set_label'; key: string; value: string }
  | { op: 'remove_label'; key: string }
  // Path operations address any YAML document, not just compose. Same technique --
  // locate the node, splice its bytes, verify by deep-comparing against the ops applied
  // to the parsed object -- which was never compose-specific, only its callers were.
  | { op: 'set_path'; path: (string | number)[]; value: string }
  | { op: 'remove_path'; path: (string | number)[] }
  | { op: 'rename_path'; path: (string | number)[]; to: string }
  // For files with no structure to address. The anchor must match exactly once, which
  // is what makes the edit checkable: the same guarantee the deep-compare gives for a
  // document -- the applier changed precisely what was named and nothing else -- without
  // needing a parse to give it.
  | { op: 'replace_text'; find: string; replace: string }
)

export type ApplyOutcome = { ok: true; text: string; changed: string[] } | { ok: false; reason: string }

/** Top-level service keys a draft may never write: each widens what the container can reach on the host. */
const DENIED_SERVICE_KEYS = new Set([
  'privileged',
  'cap_add',
  'devices',
  'pid',
  'ipc',
  'network_mode',
  'volumes',
  'volumes_from',
  'security_opt',
  'build',
  'user',
  'userns_mode',
  'cgroup',
  'runtime',
  'group_add',
])

/** A compose document: its root is a mapping with a `services` mapping. */
function isComposeDocument(text: string): boolean {
  try {
    const doc = parseYaml(text) as unknown
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false
    const services = (doc as Record<string, unknown>).services
    return !!services && typeof services === 'object' && !Array.isArray(services)
  } catch {
    return false
  }
}

/**
 * What a draft may do in a compose document, beyond the per-service operations: path
 * operations only under `services.<a permitted service>`, never a key that widens what the
 * container can reach, labels only through set_label / remove_label, and never a
 * `shipshape.*` label. A refusal, or null.
 */
function composeGuard(op: Op, allowed: string[]): ApplyOutcome | null {
  if (op.op === 'replace_text') {
    return { ok: false, reason: 'replace_text is not allowed in a compose file — name the key to change instead' }
  }
  if (op.op === 'set_path' || op.op === 'remove_path' || op.op === 'rename_path') {
    const path = op.path
    if (path[0] !== 'services' || path.length < 3) {
      return {
        ok: false,
        reason: `a draft may only change keys under services.<service> in a compose file, not ${path.join('.')}`,
      }
    }
    if (typeof path[1] !== 'string' || !allowed.includes(path[1])) {
      return {
        ok: false,
        reason: `this proposal may not change "${String(path[1])}" — permitted: ${allowed.join(', ')}`,
      }
    }
    const key = String(path[2])
    const denied = DENIED_SERVICE_KEYS.has(key)
      ? key
      : op.op === 'rename_path' && path.length === 3 && DENIED_SERVICE_KEYS.has(op.to)
        ? op.to
        : null
    if (denied) {
      return {
        ok: false,
        reason: `a draft may not change ${denied} on ${path[1]}: it widens what the container can reach on the host`,
      }
    }
    if (key === 'labels')
      return { ok: false, reason: 'labels are changed with set_label and remove_label, not path operations' }
  }
  if ((op.op === 'set_label' || op.op === 'remove_label') && /^shipshape\./i.test(op.key)) {
    return { ok: false, reason: 'a draft may not change shipshape.* labels' }
  }
  return null
}

/**
 * Apply `ops` to `service` in `text`.
 *
 * Operations are applied one at a time, re-parsing between each, so every edit is
 * located against the document as it actually is rather than against stale offsets.
 * That costs a few parses and removes a whole class of splice-collision bug.
 */
export function applyOps(
  text: string,
  service: string,
  ops: Op[],
  /** Services this proposal may touch. Defaults to the one being updated. */
  allowed: string[] = [service],
): ApplyOutcome {
  if (ops.length === 0) return { ok: true, text, changed: [] }

  let current = text
  const changed: string[] = []
  const compose = isComposeDocument(text)

  for (const op of ops) {
    const target = op.service ?? service
    if (compose) {
      const refused = composeGuard(op, allowed)
      if (refused) return refused
    }
    // Path operations in any other document carry no service; their boundary is the
    // file, checked before this function is reached. In a compose document composeGuard
    // has already held them to the permitted services.
    const isPathOp =
      op.op === 'set_path' || op.op === 'remove_path' || op.op === 'rename_path' || op.op === 'replace_text'
    // Scope is enforced here rather than trusted from the prompt: an op naming a
    // service outside the permitted set is refused by name, whatever the model was
    // told it could do.
    if (!isPathOp && !allowed.includes(target)) {
      return {
        ok: false,
        reason: `this proposal may not change "${target}" — permitted: ${allowed.join(', ')}`,
      }
    }
    const step = applyOne(current, target, op)
    if (!step.ok) return step
    current = step.text
    changed.push(describe(op, target, service))
  }

  const check = verify(text, current, service, ops)
  if (!check.ok) return check
  return { ok: true, text: current, changed }
}

function describe(op: Op, target: string, primary: string): string {
  const where = target === primary ? '' : ` (${target})`
  return describeOp(op) + where
}

function describeOp(op: Op): string {
  switch (op.op) {
    case 'set_image':
      return `image → ${op.image}`
    case 'set_env':
      return `env ${op.key}`
    case 'remove_env':
      return `env ${op.key} removed`
    case 'rename_env':
      return `env ${op.from} → ${op.to}`
    case 'set_label':
      return `label ${op.key}`
    case 'remove_label':
      return `label ${op.key} removed`
    case 'set_path':
      return `${op.path.join('.')} → ${op.value}`
    case 'remove_path':
      return `${op.path.join('.')} removed`
    case 'rename_path':
      return `${op.path.join('.')} → ${op.to}`
    case 'replace_text':
      return `text: ${preview(op.find)} → ${preview(op.replace) || '(removed)'}`
  }
}

/**
 * Replace an exactly-once anchor.
 *
 * Zero matches means the file is not what the model thought and the edit would be a
 * guess. More than one means it cannot say which, and picking the first is precisely
 * how a plausible edit lands in the wrong place. Both are refused, so what remains is
 * unambiguous by construction.
 */
function replaceText(text: string, find: string, replace: string): ApplyOutcome {
  if (!find) return { ok: false, reason: 'empty anchor' }
  const first = text.indexOf(find)
  if (first === -1) return { ok: false, reason: `"${preview(find)}" does not appear in this file` }
  if (text.indexOf(find, first + find.length) !== -1) {
    return {
      ok: false,
      reason: `"${preview(find)}" appears more than once — give an anchor that matches exactly one place`,
    }
  }
  return { ok: true, text: text.slice(0, first) + replace + text.slice(first + find.length), changed: [] }
}

function preview(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > 40 ? `${one.slice(0, 40)}…` : one
}

function applyOne(text: string, service: string, op: Op): ApplyOutcome {
  // Before any parse: an unstructured file has none to succeed at, and requiring one
  // would refuse exactly the files this operation exists for.
  if (op.op === 'replace_text') return replaceText(text, op.find, op.replace)

  const doc = parseDocument(text, { keepSourceTokens: true })
  if (doc.errors.length > 0) return { ok: false, reason: `file does not parse: ${doc.errors[0]!.message}` }

  // Path operations address the document root and are valid in any structured file, so
  // the compose shape is only required by the operations that assume it.
  switch (op.op) {
    case 'set_path':
      return setPath(doc, text, op.path, op.value)
    case 'remove_path':
      return removePath(doc, text, op.path)
    case 'rename_path':
      return renamePath(doc, text, op.path, op.to)
  }

  const svc = doc.getIn(['services', service])
  if (!svc || !isMap(svc)) return { ok: false, reason: `no service "${service}" in this file` }

  switch (op.op) {
    case 'set_image':
      return replaceScalar(doc, text, ['services', service, 'image'], op.image)
    case 'set_env':
      return setMapEntry(doc, text, service, 'environment', op.key, op.value)
    case 'remove_env':
      return removeMapEntry(doc, text, service, 'environment', op.key)
    case 'set_label':
      return setMapEntry(doc, text, service, 'labels', op.key, op.value)
    case 'remove_label':
      return removeMapEntry(doc, text, service, 'labels', op.key)
    case 'rename_env':
      return renameEnv(doc, text, service, op.from, op.to)
  }
}

/**
 * Set a value at an arbitrary path, creating the final key when the parent exists.
 *
 * A missing parent is refused rather than conjured: inventing intermediate structure is
 * how a plausible-looking edit ends up in the wrong place in someone's config.
 */
function setPath(doc: Document, text: string, path: (string | number)[], value: string): ApplyOutcome {
  if (path.length === 0) return { ok: false, reason: 'empty path' }
  const existing = doc.getIn(path, true)
  if (existing && isScalar(existing) && existing.range) {
    return replaceScalar(doc, text, path, value)
  }
  const parentPath = path.slice(0, -1)
  const key = path[path.length - 1]
  const parent = parentPath.length === 0 ? doc.contents : doc.getIn(parentPath)
  if (!parent || !isMap(parent)) {
    return { ok: false, reason: `no mapping at ${parentPath.join('.') || '(root)'} to add ${String(key)} to` }
  }
  return insertAfterLast(text, parent, `${String(key)}: ${value}`)
}

function removePath(doc: Document, text: string, path: (string | number)[]): ApplyOutcome {
  if (path.length === 0) return { ok: false, reason: 'empty path' }
  const parentPath = path.slice(0, -1)
  const key = path[path.length - 1]
  const parent = parentPath.length === 0 ? doc.contents : doc.getIn(parentPath)
  if (!parent || !isMap(parent)) {
    return { ok: false, reason: `no mapping at ${parentPath.join('.') || '(root)'}` }
  }
  const pair = (parent as { items: { key?: unknown }[] }).items.find((p) => isScalar(p.key) && p.key.value === key)
  if (!pair) return { ok: false, reason: `no entry at ${path.join('.')}` }
  return deleteLinesFor(text, pair as { key?: unknown; value?: unknown })
}

/** Rename a key while keeping its value's exact bytes, at any depth. */
function renamePath(doc: Document, text: string, path: (string | number)[], to: string): ApplyOutcome {
  if (path.length === 0) return { ok: false, reason: 'empty path' }
  const parentPath = path.slice(0, -1)
  const key = path[path.length - 1]
  const parent = parentPath.length === 0 ? doc.contents : doc.getIn(parentPath)
  if (!parent || !isMap(parent)) {
    return { ok: false, reason: `no mapping at ${parentPath.join('.') || '(root)'}` }
  }
  const pair = (parent as { items: { key?: unknown }[] }).items.find((p) => isScalar(p.key) && p.key.value === key)
  if (!pair) return { ok: false, reason: `no entry at ${path.join('.')}` }
  const k = pair.key as { range?: [number, number, number] }
  if (!k.range) return { ok: false, reason: 'key has no source range' }
  return { ok: true, text: text.slice(0, k.range[0]) + to + text.slice(k.range[1]), changed: [] }
}

/** Overwrite a scalar's bytes, leaving quoting style and everything around it alone. */
function replaceScalar(doc: Document, text: string, path: (string | number)[], value: string): ApplyOutcome {
  const node = doc.getIn(path, true)
  if (!node || !isScalar(node) || !node.range) {
    return { ok: false, reason: `no ${path[path.length - 1]} to replace` }
  }
  return { ok: true, text: text.slice(0, node.range[0]) + value + text.slice(node.range[1]), changed: [] }
}

/**
 * Compose accepts `environment:` and `labels:` as a map (`KEY: value`) or a sequence
 * (`- KEY=value`). Both appear in real files, so both are handled -- and the existing
 * style is always preserved rather than normalised.
 */
function collectionStyle(svc: unknown): 'map' | 'seq' | 'absent' {
  if (isMap(svc)) return 'map'
  if (isSeq(svc)) return 'seq'
  return 'absent'
}

function setMapEntry(
  doc: Document,
  text: string,
  service: string,
  block: 'environment' | 'labels',
  key: string,
  value: string,
): ApplyOutcome {
  const node = doc.getIn(['services', service, block])
  const style = collectionStyle(node)

  if (style === 'map') {
    const existing = doc.getIn(['services', service, block, key], true)
    if (existing && isScalar(existing) && existing.range) {
      return replaceScalar(doc, text, ['services', service, block, key], value)
    }
    return insertAfterLast(text, node, `${key}: ${value}`)
  }

  if (style === 'seq') {
    const items = (node as { items: unknown[] }).items
    for (const item of items) {
      if (!isScalar(item) || typeof item.value !== 'string' || !item.range) continue
      if (item.value.startsWith(`${key}=`)) {
        return {
          ok: true,
          text: text.slice(0, item.range[0]) + `${key}=${value}` + text.slice(item.range[1]),
          changed: [],
        }
      }
    }
    return insertAfterLast(text, node, `- ${key}=${value}`)
  }

  // No such block: create it directly after the service's image line, which every
  // watched service has and which reads naturally.
  return createBlock(doc, text, service, block, key, value)
}

function removeMapEntry(
  doc: Document,
  text: string,
  service: string,
  block: 'environment' | 'labels',
  key: string,
): ApplyOutcome {
  const node = doc.getIn(['services', service, block])
  const style = collectionStyle(node)
  if (style === 'absent') return { ok: false, reason: `${service} has no ${block} block` }

  if (style === 'map') {
    const pair = (node as { items: { key?: unknown }[] }).items.find((p) => isScalar(p.key) && p.key.value === key)
    if (!pair) return { ok: false, reason: `${service} has no ${block} entry "${key}"` }
    return deleteLinesFor(text, pair as { key?: unknown; value?: unknown })
  }

  const item = (node as { items: unknown[] }).items.find(
    (i) => isScalar(i) && typeof i.value === 'string' && i.value.startsWith(`${key}=`),
  )
  if (!item) return { ok: false, reason: `${service} has no ${block} entry "${key}"` }
  return deleteLinesFor(text, { value: item })
}

/**
 * Rename a key while keeping its value's exact bytes.
 *
 * Re-emitting the value from the parsed model would drop quoting and any `${VAR}`
 * spelling; the whole point of a rename is that only the key changes.
 */
function renameEnv(doc: Document, text: string, service: string, from: string, to: string): ApplyOutcome {
  const node = doc.getIn(['services', service, 'environment'])
  const style = collectionStyle(node)
  if (style === 'absent') return { ok: false, reason: `${service} has no environment block` }

  if (style === 'map') {
    const pair = (node as { items: { key?: unknown; value?: unknown }[] }).items.find(
      (p) => isScalar(p.key) && p.key.value === from,
    )
    if (!pair) return { ok: false, reason: `${service} has no environment entry "${from}"` }
    const k = pair.key as { range?: [number, number, number] }
    if (!k.range) return { ok: false, reason: 'environment key has no source range' }
    return { ok: true, text: text.slice(0, k.range[0]) + to + text.slice(k.range[1]), changed: [] }
  }

  const item = (node as { items: unknown[] }).items.find(
    (i) => isScalar(i) && typeof i.value === 'string' && i.value.startsWith(`${from}=`),
  ) as { value?: string; range?: [number, number, number] } | undefined
  if (!item?.range) return { ok: false, reason: `${service} has no environment entry "${from}"` }
  const rest = String(item.value).slice(from.length) // "=value"
  return {
    ok: true,
    text: text.slice(0, item.range[0]) + to + rest + text.slice(item.range[1]),
    changed: [],
  }
}

/** Add a line after the collection's last entry, matching its indentation exactly. */
function insertAfterLast(text: string, node: unknown, line: string): ApplyOutcome {
  const items = (node as { items?: unknown[] }).items ?? []
  if (items.length === 0) return { ok: false, reason: 'cannot extend an empty block' }

  const last = items[items.length - 1] as { key?: unknown; value?: unknown; range?: [number, number, number] }
  const anchor = rangeOf(last)
  if (!anchor) return { ok: false, reason: 'cannot locate the end of the block' }

  const lines = text.split('\n')
  const endLine = lineAt(text, anchor[1])
  const indent = (lines[lineAt(text, anchor[0])] ?? '').match(/^\s*/)![0]
  lines.splice(endLine + 1, 0, `${indent}${line}`)
  return { ok: true, text: lines.join('\n'), changed: [] }
}

function createBlock(
  doc: Document,
  text: string,
  service: string,
  block: string,
  key: string,
  value: string,
): ApplyOutcome {
  const image = doc.getIn(['services', service, 'image'], true)
  if (!image || !isScalar(image) || !image.range) {
    return { ok: false, reason: `${service} has no ${block} block and no image: line to anchor one to` }
  }
  const lines = text.split('\n')
  const at = lineAt(text, image.range[0])
  const indent = (lines[at] ?? '').match(/^\s*/)![0]
  lines.splice(at + 1, 0, `${indent}${block}:`, `${indent}  ${key}: ${value}`)
  return { ok: true, text: lines.join('\n'), changed: [] }
}

function deleteLinesFor(text: string, pair: { key?: unknown; value?: unknown }): ApplyOutcome {
  const range = rangeOf(pair)
  if (!range) return { ok: false, reason: 'cannot locate the entry to remove' }
  const lines = text.split('\n')
  const from = lineAt(text, range[0])
  const to = lineAt(text, range[1] - 1)
  lines.splice(from, to - from + 1)
  return { ok: true, text: lines.join('\n'), changed: [] }
}

function rangeOf(pair: { key?: unknown; value?: unknown; range?: [number, number, number] }): [number, number] | null {
  if (pair.range) return [pair.range[0], pair.range[1]]
  const k = pair.key as { range?: [number, number, number] } | undefined
  const v = pair.value as { range?: [number, number, number] } | undefined
  if (!k?.range) return null
  return [k.range[0], v?.range?.[1] ?? k.range[1]]
}

function lineAt(text: string, offset: number): number {
  let line = 0
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

/**
 * Confirm the result is exactly what the ops asked for and nothing else.
 *
 * The ops are applied a second time to the *parsed object* independently, and the two
 * are compared. Anything the splices did beyond the intent -- a collided key, a
 * clobbered neighbour, a mangled block -- shows up as a mismatch here rather than in
 * someone's running stack.
 */
function verify(before: string, after: string, service: string, ops: Op[]): ApplyOutcome {
  // Text operations carry their own guarantee -- an anchor that matched exactly once --
  // and an unstructured file has no parsed model to compare against. When that is all
  // there is, there is nothing further to check.
  if (ops.every((o) => o.op === 'replace_text')) return { ok: true, text: after, changed: [] }

  const parsedAfter = parseDocument(after)
  if (parsedAfter.errors.length > 0) {
    return { ok: false, reason: `result does not parse: ${parsedAfter.errors[0]!.message}` }
  }

  const expected = parseDocument(before).toJS() as Record<string, any>

  for (const op of ops) {
    // Path operations address the document root, not a service, so they are checked
    // against the same parsed object by walking their own path.
    if (op.op === 'replace_text') continue
    if (op.op === 'set_path' || op.op === 'remove_path' || op.op === 'rename_path') {
      const applied = applyPathToObject(expected, op)
      if (!applied.ok) return applied
      continue
    }
    // Resolved per op, not once: an op may name a sibling service, and applying it to
    // the primary would make the comparison disagree with a correct edit.
    const svc = expected?.services?.[op.service ?? service]
    if (!svc) return { ok: false, reason: `service "${op.service ?? service}" vanished` }
    switch (op.op) {
      case 'set_image':
        svc.image = op.image
        break
      case 'set_env':
        applyToCollection(svc, 'environment', (m) => (m[op.key] = scalarValue(op.value)), op.key, op.value)
        break
      case 'remove_env':
        applyToCollection(svc, 'environment', (m) => delete m[op.key], op.key)
        break
      case 'set_label':
        applyToCollection(svc, 'labels', (m) => (m[op.key] = scalarValue(op.value)), op.key, op.value)
        break
      case 'remove_label':
        applyToCollection(svc, 'labels', (m) => delete m[op.key], op.key)
        break
      case 'rename_env': {
        const env = svc.environment
        if (Array.isArray(env)) {
          const i = env.findIndex((e: string) => e.startsWith(`${op.from}=`))
          if (i >= 0) env[i] = `${op.to}=${String(env[i]).slice(op.from.length + 1)}`
        } else if (env && typeof env === 'object') {
          if (op.from in env) {
            env[op.to] = env[op.from]
            delete env[op.from]
          }
        }
        break
      }
    }
  }

  const actual = parsedAfter.toJS() as Record<string, unknown>
  if (JSON.stringify(sorted(actual)) !== JSON.stringify(sorted(expected))) {
    return { ok: false, reason: 'the edit changed more than the requested operations' }
  }
  return { ok: true, text: after, changed: [] }
}

function applyToCollection(
  svc: Record<string, any>,
  block: string,
  mutate: (m: Record<string, unknown>) => void,
  key: string,
  value?: string,
): void {
  const existing = svc[block]
  if (Array.isArray(existing)) {
    const i = existing.findIndex((e: string) => String(e).startsWith(`${key}=`))
    if (value === undefined) {
      if (i >= 0) existing.splice(i, 1)
    } else if (i >= 0) {
      existing[i] = `${key}=${value}`
    } else {
      existing.push(`${key}=${value}`)
    }
    return
  }
  svc[block] ??= {}
  mutate(svc[block] as Record<string, unknown>)
}

/**
 * An op's `value` is raw YAML scalar text, so the model can choose quoting and keep
 * `${VAR}` references intact. The verifier has to interpret it exactly as the parser
 * will, or a deliberately quoted value looks like unintended drift.
 */
function scalarValue(raw: string): unknown {
  try {
    const v = parseYaml(raw)
    return v === undefined || v === null ? raw : v
  } catch {
    return raw
  }
}

/**
 * Mirror a path operation onto the parsed object, so the splice can be checked against
 * it. Same walk the applier does, expressed over plain values.
 */
function applyPathToObject(
  root: Record<string, any>,
  op: Extract<Op, { op: 'set_path' | 'remove_path' | 'rename_path' }>,
): ApplyOutcome {
  const parentPath = op.path.slice(0, -1)
  const key = op.path[op.path.length - 1] as string
  let parent: any = root
  for (const seg of parentPath) {
    parent = parent?.[seg as never]
    if (parent === undefined || parent === null) {
      return { ok: false, reason: `no mapping at ${parentPath.join('.')}` }
    }
  }
  if (typeof parent !== 'object') {
    return { ok: false, reason: `${parentPath.join('.')} is not a mapping` }
  }
  if (op.op === 'set_path') parent[key] = scalarValue(op.value)
  else if (op.op === 'remove_path') delete parent[key]
  else {
    parent[op.to] = parent[key]
    delete parent[key]
  }
  return { ok: true, text: '', changed: [] }
}

/** Key order is not meaningful in YAML mappings; compare content, not ordering. */
function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted)
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, x]) => [k, sorted(x)]),
    )
  }
  return v
}
