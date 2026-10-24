import { test } from 'node:test'
import assert from 'node:assert/strict'
import { affected, compareVersions, upstreamVersion } from '../src/security/versions.ts'
import { checkFix, matchPackages, type Target } from '../src/security/match.ts'

/**
 * Matching is the part that decides whether a security fix may merge, so it is pure and
 * pinned against the shapes seen on this host on 2026-10-24.
 */

test('versions compare the way an advisory means them', () => {
  assert.equal(compareVersions('22.23.3', '22.23.4'), -1)
  assert.equal(compareVersions('22.23.4', '22.23.4'), 0)
  assert.equal(compareVersions('24.22.1', '24.9.0'), 1)
  assert.equal(compareVersions('v3.3.5', '3.3.5'), 0)
  assert.equal(compareVersions('22.23', '22.23.0'), 0)
  assert.equal(compareVersions('1.2.3-rc.1', '1.2.3'), -1)
  assert.equal(compareVersions('16.4.1-canary.3', '16.4.1'), -1)
  assert.equal(compareVersions('13.0.0rc1', '13.0.0'), -1)
  assert.equal(compareVersions('1.2.0.2', '1.2.1.0'), -1)
  assert.equal(compareVersions('2.0.0.post1', '2.0.0'), 1)
})

test('the upstream part of package versions is what is compared', () => {
  assert.equal(upstreamVersion('1:9.20.30-1~deb13u1', 'deb'), '9.20.30')
  assert.equal(upstreamVersion('1.2.3-r0', 'apk'), '1.2.3')
  assert.equal(upstreamVersion('1.43.4.10903-e5521bd8c', 'deb'), '1.43.4.10903')
  assert.equal(compareVersions('1.43.4.10903-e5521bd8c', '1.43.3.10861', 'deb'), 1)
  assert.equal(compareVersions('1.43.2.9999-abcdef12', '1.43.3.10861', 'deb'), -1)
})

const node: Target = {
  ecosystem: 'binary',
  names: ['node'],
  affected: [
    { lt: '22.23.4' },
    { gte: '23.0.0', lt: '24.0.0' },
    { gte: '24.0.0', lt: '24.22.1' },
    { gte: '25.0.0', lt: '26.0.0' },
    { gte: '26.0.0', lt: '26.12.1' },
  ],
  fixed: ['22.23.4', '24.22.1', '26.12.1'],
}
const brotli: Target = {
  ecosystem: 'pypi',
  names: ['Brotli', 'brotlicffi'],
  affected: [{ gte: '1.0.3', lte: '1.2.0' }],
  fixed: ['1.2.1'],
}

test('every line of a runtime advisory is honoured', () => {
  for (const [v, hit] of [
    ['20.19.2', true],
    ['22.23.3', true],
    ['22.23.4', false],
    ['23.1.0', true],
    ['24.21.0', true],
    ['24.22.1', false],
    ['26.7.0', true],
    ['26.12.1', false],
  ] as const) {
    assert.equal(affected(v, node.affected), hit, v)
  }
})

test('packages match by ecosystem and normalised name', () => {
  const hits = matchPackages(
    [node, brotli],
    [
      { type: 'binary', name: 'node', version: '24.21.0' },
      { type: 'npm', name: 'node', version: '1.0.0' },
      { type: 'python', name: 'brotli', version: '1.2.0' },
      { type: 'python', name: 'BrotliCFFI', version: '1.2.0.2' },
      { type: 'python', name: 'pillow', version: '12.3.0' },
    ],
  )
  assert.deepEqual(
    hits.map((h) => `${h.type}:${h.name}@${h.version}`).sort(),
    ['binary:node@24.21.0', 'python:brotli@1.2.0'],
  )
})

test('an `any` target catches a vendor package wherever it is', () => {
  const plex: Target = { ecosystem: 'any', names: ['plexmediaserver'], affected: [{ lt: '1.43.3.10861' }], fixed: [] }
  assert.equal(matchPackages([plex], [{ type: 'deb', name: 'plexmediaserver', version: '1.43.4.10903-e5521bd8c' }]).length, 0)
  assert.equal(matchPackages([plex], [{ type: 'deb', name: 'plexmediaserver', version: '1.43.2.10000-aaaaaaaa' }]).length, 1)
})

test('a fix is verified only when the candidate carries a fixed version of every exposed package', () => {
  const running = matchPackages([node], [{ type: 'binary', name: 'node', version: '24.21.0' }])
  assert.equal(running.length, 1)

  const fixed = checkFix([node], running, [{ type: 'binary', name: 'node', version: '24.22.1' }])
  assert.equal(fixed.verified, true)
  assert.deepEqual(fixed.evidence, [{ type: 'binary', name: 'node', from: '24.21.0', to: ['24.22.1'] }])

  const same = checkFix([node], running, [{ type: 'binary', name: 'node', version: '24.21.0' }])
  assert.equal(same.verified, false)

  // Gone from the inventory is not proof of a fix.
  const vanished = checkFix([node], running, [{ type: 'npm', name: 'left-pad', version: '1.0.0' }])
  assert.equal(vanished.verified, false)
  assert.match(vanished.reason!, /not in the new image/)

  // Fixing one package while bringing in another affected one does not verify.
  const swapped = checkFix([node, brotli], running, [
    { type: 'binary', name: 'node', version: '24.22.1' },
    { type: 'python', name: 'brotli', version: '1.1.0' },
  ])
  assert.equal(swapped.verified, false)
})

test('a target with no ranges matches nothing', () => {
  assert.equal(
    matchPackages([{ ecosystem: 'any', names: ['node'], affected: [], fixed: [] }], [{ type: 'binary', name: 'node', version: '1.0.0' }]).length,
    0,
  )
})
