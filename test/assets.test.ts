import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const { asset } = await import('../src/web/assets.ts')

test('an asset URL names its content', () => {
  const url = asset('app.js')
  assert.match(url, /^\/static\/app\.js\?v=[0-9a-f]{10}$/)
  const want = createHash('sha256').update(readFileSync('public/app.js')).digest('hex').slice(0, 10)
  assert.equal(url, `/static/app.js?v=${want}`)
})
