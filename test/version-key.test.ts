import { test } from 'node:test'
import assert from 'node:assert/strict'
import { versionKey, sameVersion, compareKeys, inRange } from '../src/versions/key.ts'

/**
 * One version, however it is spelled.
 *
 * Every row here is a tag shape found in this lab's images or their upstream releases.
 */

const k = (tag: string) => {
  const v = versionKey(tag)
  assert.ok(v, `${tag} should have a version`)
  return v
}

test('image and release shapes reduce to the same version', () => {
  const table: [string, { core: number[]; pre?: string | null; build?: number[]; partial?: boolean; family?: string }][] = [
    ['2.96.17-cpu', { core: [2, 96, 17] }],
    ['v2.96.22', { core: [2, 96, 22] }],
    ['n8n@2.39.0', { core: [2, 39, 0] }],
    ['4.137.0-ls364', { core: [4, 137, 0], build: [364] }],
    ['v0.24.2554-ls24', { core: [0, 24, 2554], build: [24] }],
    ['5.1.4-r3-ls453', { core: [5, 1, 4], build: [3, 453] }],
    ['10.11.11ubu2604-ls43', { core: [10, 11, 11], build: [43] }],
    ['version-v2.7.1', { core: [2, 7, 1] }],
    ['mariadb-10.11.8', { core: [10, 11, 8] }],
    ['v0-14-7-1', { core: [0, 14, 7], build: [1] }],
    ['1.2.3-rc.1', { core: [1, 2, 3], pre: 'rc.1' }],
    ['1.2.3b2', { core: [1, 2, 3], pre: 'beta.2' }],
    ['2026-07-28', { core: [2026, 7, 28], family: 'date' }],
    ['2021.12.16', { core: [2021, 12, 16], family: 'date' }],
    ['16', { core: [16], partial: true }],
    ['12.4-ubuntu', { core: [12, 4], partial: true }],
  ]
  for (const [tag, want] of table) {
    const v = k(tag)
    assert.deepEqual(v.core, want.core, `${tag} core`)
    assert.equal(v.pre, want.pre ?? null, `${tag} pre`)
    assert.deepEqual(v.build, want.build ?? [], `${tag} build`)
    assert.equal(v.partial, want.partial ?? false, `${tag} partial`)
    assert.equal(v.family, want.family ?? 'semver', `${tag} family`)
  }
})

test('things that are not versions have no key', () => {
  for (const tag of ['latest', 'main', 'RELEASE.2025-09-07T16-13-09Z', 'e5521bd8c', '3f9d2c1a7b6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c', '', 'nightly-build']) {
    assert.equal(versionKey(tag), null, tag)
  }
})

test('a variant is a flavour, and the flavour does not change the version', () => {
  assert.ok(sameVersion(k('2.96.22-cpu'), k('v2.96.22')))
  assert.ok(sameVersion(k('4.137.0-ls364'), k('v4.137.0')), 'a build only has to agree when both carry one')
  assert.ok(!sameVersion(k('4.137.0-ls364'), k('4.137.0-ls363')), 'two builds of one version are two images')
  assert.ok(sameVersion(k('version-v2.7.1'), k('v2.7.1')), "grocy's tag and its release are one version")
  assert.ok(!sameVersion(k('1.2.3-rc.1'), k('1.2.3')), 'a prerelease is not its release')
})

test('versions order numerically, releases above their prereleases', () => {
  assert.equal(compareKeys(k('2.96.17-cpu'), k('v2.96.15')), 1)
  assert.equal(compareKeys(k('2.38.5'), k('n8n@2.39.0')), -1)
  assert.equal(compareKeys(k('1.2.3'), k('1.2.3-rc.1')), 1)
  assert.equal(compareKeys(k('1.2.3-beta.2'), k('1.2.3-rc.1')), -1)
  assert.equal(compareKeys(k('1.2.3-rc.1'), k('1.2.3-rc.2')), -1)
  assert.equal(compareKeys(k('2.13.4-ls180'), k('2.13.4-ls181')), -1)
  assert.equal(compareKeys(k('2026-07-28'), k('1.2.3')), null, 'a date and a semver do not compare')
})

test('a range excludes where you are and includes where you are going', () => {
  const from = k('2.96.15')
  const to = k('2.96.17')
  assert.ok(!inRange(k('v2.96.15'), from, to))
  assert.ok(inRange(k('2.96.16'), from, to))
  assert.ok(inRange(k('v2.96.17'), from, to))
  assert.ok(!inRange(k('2.96.22'), from, to))
  assert.ok(inRange(k('1.0.0'), null, to), 'no lower bound means everything up to the target')
})
