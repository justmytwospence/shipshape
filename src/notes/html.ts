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

export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg|nav)\b[\s\S]*?<\/\1\s*>/gi, '')
  s = s.replace(
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi,
    (_m, level: string, inner: string) => `\n\n${'#'.repeat(Number(level))} ${inline(inner)}\n\n`,
  )
  s = s
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    // Not `</li>`: the next `<li>` starts its own line, and two newlines would space the list out.
    .replace(/<\/(p|div|ul|ol|pre|section|article|table|tr|blockquote|dd|dt)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  return decode(s)
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function inline(s: string): string {
  return decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
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
