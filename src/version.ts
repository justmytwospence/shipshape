import { readFileSync } from 'node:fs'

/**
 * Which build of shipshape this is: its version, the commit it was built from, and the
 * User-Agent every outbound request carries.
 *
 * A published image says both in its environment (`SHIPSHAPE_VERSION`,
 * `SHIPSHAPE_REVISION`, baked in from build arguments by the release workflow), so an
 * edge build reports `0.2.0+edge.<sha>` rather than the last release. Anywhere else the
 * version is package.json's, found relative to this file so it resolves the same from
 * `src/` and `dist/`, and the revision is unknown.
 *
 * Read from process.env directly rather than through `env` in config: these are facts
 * about the build, not configuration, and this module must load without config's
 * import-time work (the policy path, the branch lookup).
 */
let cached: string | null = null

export function version(): string {
  if (cached !== null) return cached
  const baked = process.env.SHIPSHAPE_VERSION?.trim()
  if (baked) {
    cached = baked
    return cached
  }
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

/** The commit the running image was built from, shortened to 12 characters, or null. */
export function revision(): string | null {
  const r = process.env.SHIPSHAPE_REVISION?.trim()
  return r && /^[0-9a-f]{7,40}$/i.test(r) ? r.slice(0, 12).toLowerCase() : null
}

/** The User-Agent of every request shipshape makes: registries, GitHub, release notes. */
export function userAgent(): string {
  return `shipshape/${version()} (+https://github.com/justmytwospence/shipshape)`
}

/** For tests: read the version again. */
export function resetVersionCache(): void {
  cached = null
}
