import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative, sep } from 'node:path'

/**
 * Dependencies point down: the web layer reads everything, nothing reads the web layer.
 * The MCP server once imported the activity query and the version from src/web, and a
 * service query imported its types from a view -- the next one fails here instead.
 */

const SRC = join(import.meta.dirname, '..', 'src')
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return files(p)
    return /\.(ts|tsx)$/.test(name) ? [relative(SRC, p).split(sep).join('/')] : []
  })
const ALL = files(SRC)

/** Every relative module a file imports (static, dynamic, `export … from`, `import('…').T`), as a src-relative path. */
function imports(f: string): string[] {
  const text = readFileSync(join(SRC, f), 'utf8')
  const specs = [...text.matchAll(/(?:from\s+|import\s*\(\s*)'(\.{1,2}\/[^']+)'/g)].map((m) => m[1]!)
  return specs.map((s) =>
    normalize(join(dirname(f), s))
      .split(sep)
      .join('/'),
  )
}

test('nothing outside src/web imports from it, except the entry point', () => {
  const offenders = ALL.filter((f) => !f.startsWith('web/') && f !== 'index.ts').flatMap((f) =>
    imports(f)
      .filter((t) => t.startsWith('web/'))
      .map((t) => `${f} -> ${t}`),
  )
  assert.deepEqual(offenders, [])
})

test('the views are imported only from src/web', () => {
  const offenders = ALL.filter((f) => !f.startsWith('web/')).flatMap((f) =>
    imports(f)
      .filter((t) => t.startsWith('web/views/'))
      .map((t) => `${f} -> ${t}`),
  )
  assert.deepEqual(offenders, [])
})
