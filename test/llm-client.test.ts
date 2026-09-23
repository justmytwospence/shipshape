import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * One place decides who serves the model, and under what credential.
 *
 * Four places used to answer it for themselves -- the verdict, the proposal, the revision
 * and the model list -- each reading `env.anthropicApiKey` and constructing its own
 * client. Moving off the direct Anthropic API meant finding all four, and the one that
 * got missed would have gone on calling the old endpoint with the old key: not a crash,
 * just a bill and a 401 on a path nobody was watching. Same shape as the upstream-link
 * bug this repository already has a boundary test for, so it gets the same treatment.
 */

const SRC = join(import.meta.dirname, '..', 'src')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return files(p)
    return /\.(ts|tsx)$/.test(name) ? [relative(SRC, p).split(sep).join('/')] : []
  })
}

const ALL = files(SRC)
const read = (f: string) => readFileSync(join(SRC, f), 'utf8')

test('only the client module constructs an Anthropic client', () => {
  const offenders = ALL.filter((f) => f !== 'analyze/client.ts').filter((f) =>
    /\bnew Anthropic\s*\(/.test(read(f)),
  )
  assert.deepEqual(offenders, [])
})

test('only the client module reads a model credential out of the environment', () => {
  // config.ts declares them; everything else asks the client module instead. A direct
  // read is how a call site ends up deciding the provider for itself.
  const offenders = ALL.filter((f) => f !== 'analyze/client.ts' && f !== 'config.ts').filter((f) =>
    /\benv\.(anthropicApiKey|openrouterApiKey|llmBaseUrl)\b/.test(read(f)),
  )
  assert.deepEqual(offenders, [])
})

test('nothing outside the client module hardcodes the Anthropic API host', () => {
  const offenders = ALL.filter((f) => f !== 'analyze/client.ts').filter((f) =>
    /api\.anthropic\.com/.test(read(f)),
  )
  assert.deepEqual(offenders, [])
})
