import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'yaml'
import { PolicySchema } from '../src/config.ts'
import { SETTINGS, setValue, validateSetting, formatSetting } from '../src/settings.ts'

/**
 * `prs.max_open` is nullable, and null means no ceiling.
 *
 * It defaulted to 5 on the theory that a backlog arriving at once is a wall rather than
 * a review queue. What that actually produced was a silent deadlock: five pull requests
 * nobody merged held fifteen updates shut for six days, visible only as one repeated
 * log line. These tests pin the three places null has to survive -- the schema, the
 * file, and the form -- because a nullable key that silently coerces to a number would
 * restore the ceiling without saying so.
 */

const def = SETTINGS.find((s) => s.path === 'prs.max_open')!

test('the schema default is no ceiling at all', () => {
  const p = PolicySchema.parse({})
  assert.equal(p.prs.max_open, null)
})

test('an explicit ceiling still parses, and null stays null', () => {
  assert.equal(PolicySchema.parse({ prs: { max_open: 3 } }).prs.max_open, 3)
  assert.equal(PolicySchema.parse({ prs: { max_open: null } }).prs.max_open, null)
})

test('a ceiling of zero or below is still rejected', () => {
  // `null` is the way to say "no limit"; 0 would mean "open nothing", which is what
  // `prs.enabled: false` is for. Allowing it would give two spellings for one state.
  assert.throws(() => PolicySchema.parse({ prs: { max_open: 0 } }))
  assert.throws(() => PolicySchema.parse({ prs: { max_open: -1 } }))
})

test('the field offers blank, and names the default rather than showing an empty one', () => {
  assert.equal(def.optional, true)
  assert.equal(def.defaultValue, '')
  assert.equal(def.defaultLabel, 'unlimited')
})

test('blank is accepted on this field and written to the file as null', () => {
  assert.equal(validateSetting(def, ''), null)
  assert.equal(formatSetting(def, ''), 'null')
})

test('blank is still an error on an int field that is not optional', () => {
  const searches = SETTINGS.find((s) => s.path === 'merge.max_per_run')!
  assert.equal(searches.optional, undefined)
  assert.ok(validateSetting(searches, ''))
})

test('a number typed into the field is still validated and written as itself', () => {
  assert.equal(validateSetting(def, '3'), null)
  assert.equal(formatSetting(def, '3'), '3')
  assert.ok(validateSetting(def, '0'), 'below min')
  assert.ok(validateSetting(def, 'lots'), 'not a number')
})

test('writing null into policy.yaml keeps the trailing comment', () => {
  const yaml = `prs:\n  enabled: true\n  max_open: 5   # trailing comment worth preserving\n`
  const out = setValue(yaml, 'prs.max_open', formatSetting(def, ''))!
  assert.ok(out.includes('  max_open: null   # trailing comment worth preserving'))
  // And it round-trips back through the schema as the absence of a ceiling.
  assert.equal(PolicySchema.parse(parse(out)).prs.max_open, null)
})
