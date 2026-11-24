import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { KNOWN_LABELS } from '../src/compose/scan.ts'
import { PASSTHROUGH } from '../src/docker/env.ts'
import { PolicySchema, SinkSchema } from '../src/policy-schema.ts'

/**
 * The reference pages are written by hand and held to the code here: a variable, a label,
 * a policy key or a sink field the code has and a page lacks (or the page has and the code
 * does not) fails the build, so the pages cannot drift quietly.
 */

const ROOT = join(import.meta.dirname, '..')
const PAGES = join(ROOT, 'docs', 'src', 'content', 'docs')
const page = (rel: string) => readFileSync(join(PAGES, rel), 'utf8')

/** Every file under `dir` whose name matches `re`. */
function files(dir: string, re: RegExp): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...files(p, re))
    else if (re.test(name)) out.push(p)
  }
  return out
}

/** `` `NAME` `` in the first cell of a Markdown table row. */
function firstColumn(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(/^\|\s*`([^`]+)`/gm)) out.add(m[1]!)
  return out
}

// Read by the code but documented on the development page, not the environment reference.
const DEVELOPMENT_ONLY = new Set(['SHIPSHAPE_UI_DEV'])
// Documented on the environment page for the example compose files; shipshape never reads them.
const COMPOSE_ONLY = new Set(['PUID', 'PGID', 'DOCKER_GID'])

/**
 * The names the code reads: `process.env.X`, the `env.X` of a local alias of it (the auth
 * modules read `const env = process.env`), and `v.X` (the credential resolver's parameter);
 * the names docker compose is passed; and the variables the sinks name by default.
 */
function envReadByCode(): Set<string> {
  const names = new Set<string>()
  for (const f of files(join(ROOT, 'src'), /\.tsx?$/)) {
    for (const m of readFileSync(f, 'utf8').matchAll(/\b(?:process\.env|env|v)\.([A-Z][A-Z0-9_]*)\b/g)) {
      names.add(m[1]!)
    }
  }
  // A refactor that hides a read from the pattern above must fail here, loudly, instead of
  // silently shrinking what the tests below check.
  assert.ok(names.has('SHIPSHAPE_PASSWORD'), 'the extraction no longer sees SHIPSHAPE_PASSWORD')
  assert.ok(names.has('GIT_USERNAME'), 'the extraction no longer sees GIT_USERNAME')
  for (const n of PASSTHROUGH) names.add(n)
  // The variables sinks read by default (a sink may name others; those are the operator's).
  const minimal = [
    { type: 'webhook' },
    { type: 'email' },
    { type: 'ntfy', url: 'https://ntfy.example', topic: 't' },
    { type: 'discord' },
    { type: 'gotify', url: 'https://gotify.example' },
    { type: 'apprise', url: 'https://apprise.example/notify' },
  ]
  for (const raw of minimal) {
    const sink = SinkSchema.parse(raw) as Record<string, unknown>
    for (const [k, v] of Object.entries(sink)) if (k.endsWith('_env') && typeof v === 'string') names.add(v)
  }
  return names
}

test('every environment variable the code reads is in the environment reference', () => {
  const documented = firstColumn(page('reference/environment.mdx'))
  const missing = [...envReadByCode()].filter((n) => !DEVELOPMENT_ONLY.has(n) && !documented.has(n))
  assert.deepEqual(missing, [], `add these to docs/src/content/docs/reference/environment.mdx: ${missing.join(', ')}`)
})

test('the environment reference names nothing the code does not read', () => {
  const read = envReadByCode()
  const stale = [...firstColumn(page('reference/environment.mdx'))].filter(
    (n) => /^[A-Z][A-Z0-9_]*$/.test(n) && !read.has(n) && !COMPOSE_ONLY.has(n),
  )
  assert.deepEqual(stale, [], `documented but never read: ${stale.join(', ')}`)
})

const REMOVED_LABELS = new Set(['shipshape.policy', 'shipshape.pr', 'shipshape.claude'])

test('every label the scanner knows is in the labels reference, and nothing else is', () => {
  const documented = firstColumn(page('reference/labels.mdx'))
  const known = [...KNOWN_LABELS].map((k) => `shipshape.${k}`)
  const missing = known.filter((l) => !documented.has(l))
  assert.deepEqual(missing, [], `add these to reference/labels.mdx: ${missing.join(', ')}`)
  const stale = [...documented].filter(
    (l) => l.startsWith('shipshape.') && !known.includes(l) && !REMOVED_LABELS.has(l),
  )
  assert.deepEqual(stale, [], `documented labels the scanner does not read: ${stale.join(', ')}`)
})

/** Dotted paths of every key the parsed default policy has; arrays and null are leaves. */
function policyPaths(value: unknown, prefix = ''): string[] {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return prefix ? [prefix] : []
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k
    const children = policyPaths(v, path)
    return children.length > 0 ? children : [path]
  })
}

test('every policy key is in the policy reference', () => {
  const documented = firstColumn(page('reference/policy.mdx'))
  const missing = policyPaths(PolicySchema.parse({})).filter((p) => !documented.has(p))
  assert.deepEqual(missing, [], `add these to reference/policy.mdx: ${missing.join(', ')}`)
})

test('the notifications page names every sink type and field', () => {
  const text = page('reference/notifications.mdx')
  const documented = firstColumn(text)
  const missing: string[] = []
  for (const option of SinkSchema.options) {
    const shape = option.shape
    const type = shape.type.value
    if (!text.includes(`\`type: ${type}\``)) missing.push(`type: ${type}`)
    for (const field of Object.keys(shape)) {
      if (field !== 'type' && !documented.has(`${type}.${field}`)) missing.push(`${type}.${field}`)
    }
  }
  assert.deepEqual(missing, [], `add these to reference/notifications.mdx: ${missing.join(', ')}`)
})
