/**
 * A web page reduced to the text a changelog review can read.
 *
 * Small on purpose: release-notes pages are headings and lists, and the one structure worth
 * keeping is the headings, written back as markdown `#` headings so the page can be cut by
 * version exactly like a CHANGELOG.md. Scripts, styles and navigation go; every other tag
 * is dropped and its text kept.
 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
}

/** Elements whose content is never text worth reading. */
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'nav'])
/** Closing tags that end a line. Not `</li>`: the next `<li>` starts its own line. */
const BLOCK_END = new Set(['p', 'div', 'ul', 'ol', 'pre', 'section', 'article', 'table', 'tr', 'blockquote', 'dd', 'dt'])

/**
 * `indexOf` that remembers its answer per needle. Correct because each needle is searched
 * from a position that never moves backwards, and it is what keeps the scan linear: an
 * unclosed `<!--` or `<script` repeated a hundred thousand times would otherwise search
 * to the end of the page once per repetition.
 */
function finder(hay: string): (needle: string, from: number) => number {
  const memo = new Map<string, number>()
  return (needle, from) => {
    const m = memo.get(needle)
    if (m !== undefined && (m === -1 || m >= from)) return m
    const r = hay.indexOf(needle, from)
    memo.set(needle, r)
    return r
  }
}

/**
 * One forward scan, in time linear in the page. The regular expressions this replaces
 * were each quadratic on unclosed input, so a page of nothing but `<` took seconds per
 * hundred kilobytes, and a linked changelog is a page anyone can write.
 */
export function htmlToText(html: string): string {
  const lower = html.toLowerCase()
  const find = finder(html)
  const findLower = finder(lower)
  const out: string[] = []
  let heading: { level: number; buf: string[] } | null = null
  const emit = (s: string) => (heading ? heading.buf.push(s) : out.push(s))

  let i = 0
  while (i < html.length) {
    const lt = find('<', i)
    if (lt === -1) {
      emit(html.slice(i))
      break
    }
    if (lt > i) emit(html.slice(i, lt))
    i = lt

    if (html.startsWith('<!--', i)) {
      const end = find('-->', i + 4)
      if (end !== -1) {
        i = end + 3
        continue
      }
    }
    const next = html[i + 1] ?? ''
    const closing = next === '/'
    const first = closing ? (html[i + 2] ?? '') : next
    const isTag = /[a-z]/i.test(first) || (next === '!' && !closing)
    if (!isTag) {
      emit('<')
      i++
      continue
    }
    const close = find('>', i + 1)
    if (close === -1) {
      emit('<')
      i++
      continue
    }
    const name = /^[a-z][a-z0-9-]*/.exec(lower.slice(i + (closing ? 2 : 1), Math.min(close, i + 40)))?.[0] ?? ''
    const selfClosing = html[close - 1] === '/'
    i = close + 1

    if (!closing && SKIP.has(name) && !selfClosing) {
      // Skip to the matching close tag, `</name` followed by optional space and `>`.
      let at = findLower(`</${name}`, i)
      // With no close, only the tag itself goes.
      while (at !== -1) {
        const rest = /^\s*>/.exec(lower.slice(at + name.length + 2, at + name.length + 66))
        if (rest) {
          i = at + name.length + 2 + rest[0].length
          break
        }
        at = lower.indexOf(`</${name}`, at + 1)
      }
      continue
    }
    const h = /^h([1-6])$/.exec(name)
    if (h && !closing && !heading) {
      heading = { level: Number(h[1]), buf: [] }
      continue
    }
    if (h && closing && heading && Number(h[1]) === heading.level) {
      out.push(`\n\n${'#'.repeat(heading.level)} ${inline(heading.buf.join(''))}\n\n`)
      heading = null
      continue
    }
    if (heading) continue // inside a heading every other tag is dropped
    if (!closing && name === 'li') out.push('\n- ')
    else if (name === 'br') out.push('\n')
    else if (closing && BLOCK_END.has(name)) out.push('\n')
  }
  if (heading) out.push(heading.buf.join(''))

  return decode(out.join(''))
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A heading's text: its tags are already gone, so only entities and whitespace remain. */
function inline(s: string): string {
  return decode(s).replace(/\s+/g, ' ').trim()
}

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e.startsWith('#')) {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}
