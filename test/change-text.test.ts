import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changeText } from '../src/gitops/body.ts'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'shipshape-test-'))

/**
 * A line that says something landed names the versions it moved between.
 *
 * The deployed line used to be "#102 deployed — jackett up in 47s": how long it took,
 * which the timeline already shows, in place of what is running now, which nothing else
 * in the activity log says.
 */

const m = (service: string, from_tag: string, to_tag: string) => ({ service, from_tag, to_tag })

// ---------------------------------------------------------------------------------------
// changeText
// ---------------------------------------------------------------------------------------

test('one update is its two versions, named only when asked', () => {
  assert.equal(changeText([m('bitwarden', '1.37.2', '1.37.3')]), '1.37.2 -> 1.37.3')
  assert.equal(changeText([m('bitwarden', '1.37.2', '1.37.3')], { named: true }), 'bitwarden 1.37.2 -> 1.37.3')
})

test('a group on the same versions names its members once', () => {
  const group = [m('n8n-import', '2.38.5', '2.38.7'), m('n8n', '2.38.5', '2.38.7')]
  assert.equal(changeText(group), 'n8n-import, n8n 2.38.5 -> 2.38.7')
  assert.equal(changeText(group, { named: true }), 'n8n-import, n8n 2.38.5 -> 2.38.7')
})

test('members on different versions are each written out', () => {
  // Folding them onto the first member's tags would state a version b never ran.
  assert.equal(changeText([m('a', '1.0', '2.0'), m('b', '1.1', '2.0')]), 'a 1.0 -> 2.0, b 1.1 -> 2.0')
})

test('digest refs are shortened on both sides', () => {
  const from = `main@sha256:c509fb90708d${'0'.repeat(52)}`
  const to = `main@sha256:caf0cd77c922${'f'.repeat(52)}`
  assert.equal(changeText([m('huginn', from, to)]), 'main@c509fb90708d -> main@caf0cd77c922')
})
