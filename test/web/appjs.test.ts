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
  assert.match(src, /function load\(k\) \{\s*try \{\s*return localStorage\.getItem/)
  assert.match(src, /function save\(k, v\) \{\s*try \{\s*localStorage\.setItem/)
})

test('j and k walk the list, not the pane', () => {
  assert.match(src, /#list \[data-row\]/)
})

test('the address bar colour follows a pinned theme', () => {
  assert.match(src, /meta\[name=theme-color\]'\)\.forEach/)
  assert.doesNotMatch(src, /:not\(\[media\]\)/)
})

test('a poll never raises a toast', () => {
  const failed = src.slice(src.indexOf('function failed('), src.indexOf("addEventListener('htmx:responseError'"))
  assert.match(failed, /isPoll\(e\)/)
  assert.match(src.slice(src.indexOf('function isPoll('), src.indexOf('function showConn(')), /\\bevery\\b/)
})

test('an error toast is an alert with a close button and a pausable timer', () => {
  assert.match(src, /'alert' : 'status'/)
  assert.match(src, /aria-label', 'Dismiss'/)
  assert.match(src, /mouseenter/)
  assert.match(src, /focusin/)
})

test("times tick every minute in the server's zone", () => {
  assert.match(src, /setInterval\(formatTimes, 60000\)/)
  assert.match(src, /getAttribute\('data-tz'\)/)
})

test('focus follows a swap', () => {
  assert.match(src, /htmx:beforeSwap/)
  assert.match(src, /data-pane-heading/)
})
