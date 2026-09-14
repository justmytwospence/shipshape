import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changeText } from '../src/gitops/body.ts'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'shipshape-test-'))

const { deployLine } = await import('../src/notify/digest.ts')

/**
 * A line that says something landed names the versions it moved between.
 *
 * The deployed line used to be "#102 deployed — jackett up in 47s": how long it took,
 * which the timeline already shows, in place of what is running now, which nothing else
 * in the digest says. And a deploy that started nothing had no line of its own at all.
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

test('nothing carried is no line, not an empty arrow', () => {
  assert.equal(changeText([]), null)
})

// ---------------------------------------------------------------------------------------
// deployLine
// ---------------------------------------------------------------------------------------

test('a clean deploy names the versions it moved between', () => {
  const line = deployLine({
    prNumber: 102,
    change: changeText([m('jackett', 'v0.24.2572-ls26', 'v0.24.2586-ls28')]),
    broughtUp: 1,
    left: [],
  })
  assert.deepEqual(line, { category: 'deployed', summary: '#102 deployed — v0.24.2572-ls26 -> v0.24.2586-ls28' })
})

test('a deploy that started nothing is left stopped, not deployed', () => {
  const change = changeText([m('bitwarden', '1.37.2', '1.37.3')])
  assert.deepEqual(deployLine({ prNumber: 101, change, broughtUp: 0, left: [{ service: 'bitwarden', absent: false }] }), {
    category: 'left-stopped',
    summary: '#101 merged — 1.37.2 -> 1.37.3, left stopped (not running)',
  })
  assert.equal(
    deployLine({ prNumber: 101, change, broughtUp: 0, left: [{ service: 'bitwarden', absent: true }] })!.summary,
    '#101 merged — 1.37.2 -> 1.37.3, left stopped (no container)',
  )
  // "no container" only when it is true of every service left; one that exists but is
  // stopped is the more useful thing to say.
  assert.match(
    deployLine({
      prNumber: 101,
      change,
      broughtUp: 0,
      left: [
        { service: 'a', absent: true },
        { service: 'b', absent: false },
      ],
    })!.summary,
    /\(not running\)$/,
  )
})

test('a partial group says which half it left', () => {
  const change = changeText([m('n8n-import', '2.38.5', '2.38.7'), m('n8n', '2.38.5', '2.38.7')])
  assert.deepEqual(
    deployLine({ prNumber: 91, change, broughtUp: 1, left: [{ service: 'n8n-import', absent: false }] }),
    {
      category: 'deployed',
      summary: '#91 deployed — n8n-import, n8n 2.38.5 -> 2.38.7; n8n-import left stopped (not running)',
    },
  )
  assert.equal(
    deployLine({
      prNumber: 7,
      change: '1 -> 2',
      broughtUp: 1,
      left: [
        { service: 'b', absent: true },
        { service: 'a', absent: false },
      ],
    })!.summary,
    '#7 deployed — 1 -> 2; a left stopped (not running); b left stopped (no container)',
  )
})

test('a redeploy has no pull request to name', () => {
  assert.equal(
    deployLine({ prNumber: null, change: 'latest@cb4826a1b2c3 -> latest@09fb11d4e5f6', broughtUp: 1, left: [] })!.summary,
    'redeployed — latest@cb4826a1b2c3 -> latest@09fb11d4e5f6',
  )
  // Nothing merged and nothing started: there is nothing to report.
  assert.equal(
    deployLine({ prNumber: null, change: '1 -> 2', broughtUp: 0, left: [{ service: 'actual', absent: false }] }),
    null,
  )
})

test('warnings are said in the line, before the versions', () => {
  assert.equal(
    deployLine({ prNumber: 9, change: '1 -> 2', broughtUp: 1, left: [], warnings: true })!.summary,
    '#9 deployed with warnings — 1 -> 2',
  )
})

test('an unknown change still reads as a sentence', () => {
  assert.equal(
    deployLine({ prNumber: 101, change: null, broughtUp: 0, left: [{ service: 'bitwarden', absent: false }] })!.summary,
    '#101 merged, left stopped (not running)',
  )
  assert.equal(deployLine({ prNumber: 5, change: null, broughtUp: 1, left: [] })!.summary, '#5 deployed')
})
