import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OUTCOMES } from '../src/updates/vocabulary.ts'

test("every outcome's dot can be seen", () => {
  for (const [k, w] of Object.entries(OUTCOMES)) assert.notEqual(w.dotCls, 'bg-base-300', k)
})
