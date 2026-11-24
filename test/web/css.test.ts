import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../../src/styles/app.css', import.meta.url), 'utf8')

test('the light warning colour is readable as text', () => {
  // 5.08:1 on base-100; the old 62% was 3.66:1.
  assert.match(css, /name: 'bridge';[\s\S]*?--color-warning: oklch\(54% 0\.13 65\)/)
})
