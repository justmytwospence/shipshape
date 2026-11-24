import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, test } from 'node:test'
import { resetVersionCache, revision, userAgent, version } from '../src/version.ts'

const pkg = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string })
  .version

afterEach(() => {
  delete process.env.SHIPSHAPE_VERSION
  delete process.env.SHIPSHAPE_REVISION
  resetVersionCache()
})

test("an image's SHIPSHAPE_VERSION wins over package.json", () => {
  process.env.SHIPSHAPE_VERSION = '0.2.0+edge.d303138d3031'
  resetVersionCache()
  assert.equal(version(), '0.2.0+edge.d303138d3031')
})

test('without it, the version is the one in package.json', () => {
  resetVersionCache()
  assert.equal(version(), pkg)
})

test('a blank SHIPSHAPE_VERSION counts as unset', () => {
  process.env.SHIPSHAPE_VERSION = '  '
  resetVersionCache()
  assert.equal(version(), pkg)
})

test('the revision is a commit sha, shortened to 12 characters, or nothing', () => {
  process.env.SHIPSHAPE_REVISION = 'D303138D303138D303138D303138D303138D3031'
  assert.equal(revision(), 'd303138d3031')
  process.env.SHIPSHAPE_REVISION = 'unknown'
  assert.equal(revision(), null)
  delete process.env.SHIPSHAPE_REVISION
  assert.equal(revision(), null)
})

test('every outbound request names the version', () => {
  process.env.SHIPSHAPE_VERSION = '0.2.0'
  resetVersionCache()
  assert.equal(userAgent(), 'shipshape/0.2.0 (+https://github.com/justmytwospence/shipshape)')
})
