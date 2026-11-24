import { readFileSync } from 'node:fs'

/**
 * The running version, read once.
 *
 * Lived in server.ts, but the shell shows it too and a second copy of a file read is
 * how the two drift. The relative path resolves the same from `src/` and from
 * `dist/`, which is why it is stated as a URL against import.meta rather than cwd.
 */
let cached: string | null = null

export function version(): string {
  if (cached !== null) return cached
  try {
    cached = (
      JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
        version: string
      }
    ).version
  } catch {
    cached = 'unknown'
  }
  return cached
}
