import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '../config.ts'

/**
 * A static asset's URL with its content hash, so a browser (and the service worker) can
 * keep it forever and a new build is a new URL. Read once; in the UI sandbox, where the
 * stylesheet is rebuilt while the server runs, read on every call.
 */
const memo = new Map<string, string>()

export function asset(file: 'app.css' | 'app.js' | 'htmx.min.js'): string {
  if (!env.uiDev) {
    const hit = memo.get(file)
    if (hit) return hit
  }
  let url: string
  try {
    const hash = createHash('sha256').update(readFileSync(join('./public', file))).digest('hex').slice(0, 10)
    url = `/static/${file}?v=${hash}`
  } catch {
    url = `/static/${file}`
  }
  memo.set(file, url)
  return url
}
