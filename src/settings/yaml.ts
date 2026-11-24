/**
 * Editing policy.yaml from the browser.
 *
 * Settings ARE policy.yaml -- there is no second store to drift out of step, and the
 * file stays the tracked, reviewable source of truth the rest of this repo expects.
 * Edits are line splices, never a re-serialisation: the file is written for humans and
 * carries a comment above almost every key explaining why it is set that way, all of
 * which a YAML emitter would discard.
 *
 * ## Why the splicer inserts as well as replaces
 *
 * It originally only replaced an existing line, and returned null -- "could not find X
 * in policy.yaml" -- for anything else. That looked safe and was not: every field on
 * the page is submitted on every save, so the first setting whose key had never been
 * written to the file failed the whole save, including the twenty-five that were fine.
 * A policy.yaml written before `merge`, `model_tier`, `claude.web` and
 * `claude.code_model` existed therefore made the entire Settings page inert, silently,
 * with no way to fix it from the page that was broken.
 *
 * The rule that fixes it is the same one that keeps the file legible: a key the schema
 * knows about is always addressable. Missing keys are inserted at the end of their
 * section, missing sections are appended, and everything already in the file keeps its
 * comments and its position.
 */

/**
 * Set one key's value, leaving every other byte of structure and commentary alone.
 *
 * Works at any depth, and creates what is missing. Three cases, in order:
 *
 *   1. the key is already there  -> its value is replaced, trailing comment kept
 *   2. its parent block is there -> the key is inserted at the end of that block
 *   3. nothing is there          -> the block, and the key, are appended
 *
 * Cases 2 and 3 are why this exists at all: without them, a key the schema knows about
 * but the file has never mentioned is permanently unreachable from the UI, and since
 * every field is submitted on every save, one such key disables the whole page.
 *
 * Returns null only when the path itself is unusable (empty, or an empty segment).
 */
export function setValue(text: string, path: string, formatted: string): string | null {
  const parts = path.split('.')
  if (parts.length === 0 || parts.some((p) => p === '')) return null

  const replaced = spliceValue(text, path, formatted)
  if (replaced !== null) return replaced
  return insertValue(text, parts, formatted)
}

/**
 * Replace an existing key, or null when it is not in the file.
 *
 * Each segment narrows the search to its parent's block, which is what disambiguates
 * identically-named keys: `mode` exists under `claude`, `propose`, `deploy` and
 * `model_tier`, and only the enclosing range tells them apart.
 */
export function spliceValue(text: string, path: string, formatted: string): string | null {
  const lines = text.split('\n')
  const found = locate(lines, path.split('.'))
  if (!found) return null

  const m = new RegExp(`^([ \\t]*${escapeRe(found.key)}:[ \\t]*)(.*)$`).exec(lines[found.line]!)
  if (!m) return null
  // Preserve any trailing comment on the same line.
  const trailing = /(\s+#.*)$/.exec(m[2]!)?.[1] ?? ''
  lines[found.line] = `${m[1]}${formatted}${trailing}`
  return lines.join('\n')
}

/**
 * Remove a key and everything nested under it, with the comment lines directly above it
 * at the same indent (they describe the key). A parent left with no keys goes too.
 * Returns the text unchanged when the key is absent, null when the path is unusable.
 *
 * A run of comments that reaches the top of the file is the file's header, not the key's
 * description, so it stays.
 */
export function removeValue(text: string, path: string): string | null {
  const parts = path.split('.')
  if (parts.length === 0 || parts.some((p) => p === '')) return null

  const lines = text.split('\n')
  const found = locate(lines, parts)
  if (!found) return text

  const depth = parts.length - 1
  const end = Math.max(found.line + 1, backUpOverBlanks(lines, blockEnd(lines, found.line, depth)))
  const comment = new RegExp(`^${'  '.repeat(depth)}#`)
  let start = found.line
  while (start > 0 && comment.test(lines[start - 1]!)) start--
  if (start === 0) start = found.line

  lines.splice(start, end - start)
  // Removing a block that had a blank line on each side would leave two in a row.
  if (start > 0 && start < lines.length && lines[start - 1]!.trim() === '' && lines[start]!.trim() === '') {
    lines.splice(start, 1)
  }
  const out = lines.join('\n')
  if (parts.length === 1) return out

  const parent = parts.slice(0, -1)
  const after = out.split('\n')
  const p = locate(after, parent)
  if (!p) return out
  if (!/:\s*(#.*)?$/.test(after[p.line]!)) return out
  const stop = blockEnd(after, p.line, depth - 1)
  for (let i = p.line + 1; i < stop; i++) {
    const l = after[i]!.trim()
    if (l !== '' && !l.startsWith('#')) return out
  }
  return removeValue(out, parent.join('.'))
}

/** Where a dotted path's final key sits, or null when any segment is absent. */
function locate(lines: string[], parts: string[]): { line: number; key: string; indent: string } | null {
  let from = 0
  let to = lines.length
  let depth = 0

  for (let p = 0; p < parts.length; p++) {
    const key = parts[p]!
    const indent = '  '.repeat(depth)
    const re = new RegExp(`^${indent}${escapeRe(key)}:([ \\t]|$)`)
    let hit = -1
    for (let i = from; i < to; i++) {
      if (re.test(lines[i]!)) {
        hit = i
        break
      }
    }
    if (hit === -1) return null
    if (p === parts.length - 1) return { line: hit, key, indent }
    from = hit + 1
    to = blockEnd(lines, hit, depth)
    depth++
  }
  return null
}

/** The first line at or above `depth` after `start` -- i.e. where that block stops. */
function blockEnd(lines: string[], start: number, depth: number): number {
  const want = depth * 2
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!
    if (l.trim() === '') continue
    const indent = /^[ \t]*/.exec(l)![0].length
    // A comment at the parent's own indent belongs to whatever comes next, not to this
    // block -- stopping before it keeps an inserted key above the next section's header
    // comment rather than orphaning it below.
    if (indent <= want) return i
  }
  return lines.length
}

/**
 * Insert a key that is not in the file yet, creating any parent blocks it needs.
 *
 * Appended at the end of the deepest parent that does exist, so an insertion never
 * lands between a comment and the key that comment describes.
 */
function insertValue(text: string, parts: string[], formatted: string): string {
  const lines = text.split('\n')

  // How much of the path already exists?
  let from = 0
  let to = lines.length
  let depth = 0
  let insertAt = lines.length
  let matched = 0

  for (const key of parts.slice(0, -1)) {
    const re = new RegExp(`^${'  '.repeat(depth)}${escapeRe(key)}:([ \\t]|$)`)
    let hit = -1
    for (let i = from; i < to; i++) {
      if (re.test(lines[i]!)) {
        hit = i
        break
      }
    }
    if (hit === -1) break
    matched++
    from = hit + 1
    to = blockEnd(lines, hit, depth)
    insertAt = to
    depth++
  }

  // For a top-level key with no parents, append at the end of the document.
  if (parts.length === 1) insertAt = trailingBlank(lines)
  else if (matched === 0) insertAt = trailingBlank(lines)
  else insertAt = backUpOverBlanks(lines, insertAt)

  const block: string[] = []
  // Nesting depth is path depth, so segment `p` always sits at `p` levels of indent.
  for (let p = matched; p < parts.length - 1; p++) {
    block.push(`${'  '.repeat(p)}${parts[p]}:`)
  }
  const leafIndent = '  '.repeat(parts.length - 1)
  block.push(`${leafIndent}${parts[parts.length - 1]}: ${formatted}`)

  // A brand-new top-level block reads better with a blank line above it.
  if (matched === 0 && parts.length > 1) block.unshift('')

  lines.splice(insertAt, 0, ...block)
  return lines.join('\n')
}

/** Index of the first trailing blank line, so an append does not add to the gap. */
function trailingBlank(lines: string[]): number {
  let i = lines.length
  while (i > 0 && lines[i - 1]!.trim() === '') i--
  return i
}

/** Step back over blank lines so an insertion hugs the block it belongs to. */
function backUpOverBlanks(lines: string[], at: number): number {
  let i = at
  while (i > 0 && lines[i - 1]!.trim() === '') i--
  return i
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
