import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'yaml'
import { spliceValue, setValue, SETTINGS, SECTIONS } from '../src/settings.ts'

/**
 * A trimmed copy of the real policy.yaml, keeping what makes splicing risky: comments
 * above and beside keys, blank lines, a quoted cron, a list value, and two sections
 * that both contain a key named `mode`.
 *
 * It deliberately does NOT contain every settable key. That is the case the original
 * implementation could not handle and the one that mattered: the shipped policy.yaml
 * predated four whole sections of settings, so every save failed on the first missing
 * key and reported nothing about the twenty-five that were fine.
 */
const FIXTURE = `# shipshape policy -- the single place update semantics are declared.

merge_method: squash

sync:
  # Kill-switch. Setting this false degrades shipshape to alert-only.
  push_main: true
  blackout: ["00:45-02:30"]
  poll_active_s: 60

scan:
  # Seconds-field cron (croner).
  cron: "0 0 3 * * *"

claude:
  mode: advisory
  min_confidence: medium
  model: claude-haiku-4-5-20251001
  monthly_budget_usd: 10

prs:
  enabled: true
  scope: wud-coexist
  max_open: 5   # trailing comment worth preserving

exclude_stacks: []
`

// ------------------------------------------------------------------ replacing

test('replaces a nested value and leaves every other byte alone', () => {
  const out = spliceValue(FIXTURE, 'claude.model', 'claude-sonnet-5')!
  assert.ok(out.includes('  model: claude-sonnet-5'))
  // Everything else is byte-identical.
  const a = FIXTURE.split('\n').filter((l) => !l.startsWith('  model:'))
  const b = out.split('\n').filter((l) => !l.startsWith('  model:'))
  assert.deepEqual(b, a)
})

test('comments above and beside a key survive', () => {
  const out = spliceValue(FIXTURE, 'prs.max_open', '8')!
  assert.ok(out.includes('  max_open: 8   # trailing comment worth preserving'))
  assert.ok(out.includes('# shipshape policy -- the single place update semantics are declared.'))
  assert.ok(out.includes('  # Kill-switch. Setting this false degrades shipshape to alert-only.'))
})

test('a top-level key is reachable too', () => {
  const out = spliceValue(FIXTURE, 'merge_method', 'merge')!
  assert.ok(out.includes('\nmerge_method: merge\n'))
  // ...and did not disturb the nested keys.
  assert.ok(out.includes('  scope: wud-coexist'))
})

test('section scoping picks the right key when names could collide', () => {
  // `scope` exists under prs; a naive whole-file match could hit something else later.
  const out = spliceValue(FIXTURE, 'prs.scope', 'full')!
  assert.ok(out.includes('  scope: full'))
  assert.equal(out.split('\n').filter((l) => l.trim().startsWith('scope:')).length, 1)
})

test('quoted values stay quoted and lists are rewritten wholesale', () => {
  const cron = spliceValue(FIXTURE, 'scan.cron', '"0 30 4 * * *"')!
  assert.ok(cron.includes('  cron: "0 30 4 * * *"'))
  const win = spliceValue(FIXTURE, 'sync.blackout', '["01:00-02:00", "03:00-03:30"]')!
  assert.ok(win.includes('  blackout: ["01:00-02:00", "03:00-03:30"]'))
})

test('spliceValue alone still reports a key it cannot find', () => {
  assert.equal(spliceValue(FIXTURE, 'claude.nonexistent', 'x'), null)
  assert.equal(spliceValue(FIXTURE, 'nosuchsection.key', 'x'), null)
})

test('a key is only found inside its own section', () => {
  // `mode` lives under claude; asking for it under prs must not wander.
  assert.equal(spliceValue(FIXTURE, 'prs.mode', 'off'), null)
})

test('splicing is idempotent', () => {
  const once = spliceValue(FIXTURE, 'prs.max_open', '9')!
  const twice = spliceValue(once, 'prs.max_open', '9')!
  assert.equal(once, twice)
})

test('the result still parses as the same shape', () => {
  const out = spliceValue(FIXTURE, 'claude.monthly_budget_usd', '25')!
  const doc = parse(out) as Record<string, Record<string, unknown>>
  assert.equal(doc.claude!.monthly_budget_usd, 25)
  assert.equal(doc.prs!.max_open, 5)
  assert.deepEqual(doc.sync!.blackout, ['00:45-02:30'])
})

// ------------------------------------------------------------------- inserting

test('turning on comment handling writes a section the file has never had', () => {
  // The whole `revise:` block is absent from every policy.yaml that predates it, so the
  // first save has to create the section and the key. If it could not, the switch in
  // Settings would be a control that silently does nothing -- which is the failure this
  // file's own fixture comment is about.
  let out = setValue(FIXTURE, 'revise.mode', 'reply')!
  out = setValue(out, 'revise.scope', 'compose-dir')!
  const doc = parse(out) as Record<string, Record<string, unknown>>
  assert.equal(doc.revise!.mode, 'reply')
  assert.equal(doc.revise!.scope, 'compose-dir')
  // ...without disturbing anything that was already there.
  assert.equal(doc.claude!.mode, 'advisory')
  assert.equal(doc.prs!.max_open, 5)
  assert.deepEqual(doc.sync!.blackout, ['00:45-02:30'])
  // And `mode` under `revise` must not be confused with `mode` under `claude`.
  assert.match(out, /revise:\n(?:.*\n)*?\s+mode: reply/)
})

test('setValue adds a key that is missing from an existing section', () => {
  const out = setValue(FIXTURE, 'claude.code_model', 'claude-opus-5')!
  const doc = parse(out) as Record<string, Record<string, unknown>>
  assert.equal(doc.claude!.code_model, 'claude-opus-5')
  // ...into the claude block, not at the end of the file.
  assert.ok(out.includes('  monthly_budget_usd: 10\n  code_model: claude-opus-5'))
  // ...and nothing else moved.
  assert.equal(doc.prs!.max_open, 5)
  assert.equal(doc.merge_method, 'squash')
})

test('setValue adds a whole section that is missing', () => {
  const out = setValue(FIXTURE, 'merge.auto', 'true')!
  const doc = parse(out) as Record<string, Record<string, unknown>>
  assert.equal(doc.merge!.auto, true)
  assert.ok(out.includes('\nmerge:\n  auto: true'))
  // The document still ends cleanly rather than gaining a run of blank lines.
  assert.ok(!/\n\n\n/.test(out))
})

test('setValue reaches three levels deep, creating the middle one', () => {
  // claude.web.* is the path the old two-segment splicer could not express at all.
  const out = setValue(FIXTURE, 'claude.web.searches', '4')!
  const doc = parse(out) as Record<string, Record<string, Record<string, unknown>>>
  assert.equal(doc.claude!.web!.searches, 4)
  assert.ok(out.includes('  web:\n    searches: 4'))
})

test('a three-level key, once written, is replaced rather than duplicated', () => {
  const once = setValue(FIXTURE, 'claude.web.searches', '4')!
  const twice = setValue(once, 'claude.web.searches', '9')!
  const doc = parse(twice) as Record<string, Record<string, Record<string, unknown>>>
  assert.equal(doc.claude!.web!.searches, 9)
  assert.equal(twice.split('\n').filter((l) => l.trim().startsWith('searches:')).length, 1)
})

test('siblings accumulate under a block created by an earlier insert', () => {
  let text: string = FIXTURE
  for (const [path, value] of [
    ['claude.web.searches', '4'],
    ['claude.web.fetches', '5'],
    ['claude.web.content_tokens', '12000'],
  ] as const) {
    text = setValue(text, path, value)!
  }
  const doc = parse(text) as Record<string, Record<string, Record<string, unknown>>>
  assert.deepEqual(doc.claude!.web, { searches: 4, fetches: 5, content_tokens: 12000 })
  assert.equal(text.split('\n').filter((l) => l.trim() === 'web:').length, 1)
})

test('setValue rejects only a path it could not construct', () => {
  assert.equal(setValue(FIXTURE, '', 'x'), null)
  assert.equal(setValue(FIXTURE, 'claude..model', 'x'), null)
})

/**
 * The regression that matters: apply the whole settings page to a policy.yaml that has
 * never heard of half of it, exactly as a browser save does, and require every key to
 * land. This is the case that made the Settings page save nothing at all.
 */
test('every settable key survives a full-page save against a partial file', () => {
  let text: string = FIXTURE
  const settable = SETTINGS.filter((s) => !s.locked)
  for (const def of settable) {
    const out = setValue(text, def.path, sampleFor(def.path))
    assert.ok(out, `${def.path} was not settable`)
    text = out
  }

  const doc = parse(text) as Record<string, unknown>
  for (const def of settable) {
    const got = def.path
      .split('.')
      .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], doc)
    assert.notEqual(got, undefined, `${def.path} is missing after the save`)
  }
  // The file the operator hand-wrote is still recognisable underneath.
  assert.ok(text.includes('# shipshape policy -- the single place update semantics are declared.'))
  assert.ok(text.includes('  # Kill-switch. Setting this false degrades shipshape to alert-only.'))
})

/** A syntactically plausible value per key -- the splicer does not care which. */
function sampleFor(path: string): string {
  if (path === 'scan.cron') return '"0 0 3 * * *"'
  if (path === 'sync.blackout') return '["00:45-02:30"]'
  if (path.endsWith('_s') || path.endsWith('_usd') || path.endsWith('_open')) return '7'
  if (path.endsWith('.searches') || path.endsWith('.fetches')) return '4'
  if (path.endsWith('.content_tokens')) return '12000'
  if (path.endsWith('max_per_run')) return '3'
  if (path === 'merge.auto' || path === 'prs.enabled' || path === 'sync.push_main') return 'false'
  return 'placeholder'
}

// -------------------------------------------------------------------- the model

test('every setting belongs to a declared section, and every section is used', () => {
  const declared = SECTIONS.map(([name]) => name)
  for (const def of SETTINGS) {
    assert.ok(declared.includes(def.section), `${def.path}: unknown section ${def.section}`)
  }
  for (const name of declared) {
    assert.ok(
      SETTINGS.some((s) => s.section === name),
      `section "${name}" has no settings`,
    )
  }
})

test('no setting is declared twice', () => {
  // Two entries for deploy.health_window_s once put it in two different sections with
  // two different input kinds, rendering the same key twice on one form.
  const seen = new Set<string>()
  for (const def of SETTINGS) {
    assert.ok(!seen.has(def.path), `${def.path} is declared more than once`)
    seen.add(def.path)
  }
})

test('an enum default is always one of its own options', () => {
  for (const def of SETTINGS) {
    if (def.kind !== 'enum') continue
    assert.ok(
      def.options?.includes(def.defaultValue),
      `${def.path}: default "${def.defaultValue}" is not an option`,
    )
  }
})
