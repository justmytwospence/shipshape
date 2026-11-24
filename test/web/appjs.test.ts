import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/** Facts about public/app.js, which is served as written and has no other tests. */

const src = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')

test('Enter is left to the browser', () => {
  assert.doesNotMatch(src, /case 'Enter'/)
})

test('storage is only touched inside a try', () => {
  assert.equal((src.match(/localStorage\./g) ?? []).length, 2)
  assert.match(src, /function load\(k\) \{ try \{ return localStorage\.getItem/)
  assert.match(src, /function save\(k, v\) \{ try \{ localStorage\.setItem/)
})

test('j and k walk the list, not the pane', () => {
  assert.match(src, /#list \[data-row\]/)
})

test('the address bar colour follows a pinned theme', () => {
  assert.match(src, /meta\[name=theme-color\]'\)\.forEach/)
  assert.doesNotMatch(src, /:not\(\[media\]\)/)
})
