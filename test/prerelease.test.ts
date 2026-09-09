import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normaliseReleaseTag } from '../src/changelog/github.ts'
import { selectUpdate } from '../src/versions/compare.ts'

/**
 * A prerelease is not an update.
 *
 * The registry publishes betas and stable builds with identical tag shapes, so nothing
 * about a tag can separate them -- n8n ships 2.39.0 (prerelease) alongside 2.38.5
 * (stable), and 2.39.0 sorts higher. shipshape targeted the beta and then held it on a
 * changelog review that could not find its notes, because `fetchReleases` had already
 * filtered prereleases out. The same opinion, applied on one side and not the other.
 */

test('a release tag and an image tag meet in the middle', () => {
  // n8n publishes `n8n@2.39.0` for the image `2.39.0`.
  assert.equal(normaliseReleaseTag('n8n@2.39.0'), '2.39.0')
  // A leading v appears on either side, inconsistently.
  assert.equal(normaliseReleaseTag('v0.17.14'), '0.17.14')
  assert.equal(normaliseReleaseTag('V1.2.3'), '1.2.3')
  // Already bare.
  assert.equal(normaliseReleaseTag('2.38.5'), '2.38.5')
  // Both at once, and surrounding whitespace.
  assert.equal(normaliseReleaseTag('  app@v3.0.1 '), '3.0.1')
})

test('normalisation does not eat a version that merely starts with v', () => {
  // `version-v2.7.1` is grocy's real tag shape; chopping a leading `v` off the wrong
  // token would make two unrelated tags collide and exclude a stable release.
  assert.equal(normaliseReleaseTag('version-v2.7.1'), 'ersion-v2.7.1')
  assert.notEqual(normaliseReleaseTag('version-v2.7.1'), normaliseReleaseTag('v2.7.1'))
})

test('dropping the prerelease picks the stable below it, not nothing', () => {
  // The n8n case exactly: 2.39.x are prereleases, 2.38.5 is current stable, and the
  // service is on 2.38.4. Filtering the betas out must yield 2.38.5 -- reporting
  // up-to-date would silently withhold a real patch.
  const all = ['2.38.4', '2.38.5', '2.39.0', '2.39.1']
  const withBetas = selectUpdate({ currentTag: '2.38.4', availableTags: all, kind: 'semver' })
  assert.equal(withBetas.status, 'update')
  assert.equal(withBetas.status === 'update' ? withBetas.tag : '', '2.39.1')

  const stableOnly = all.filter((t) => !['2.39.0', '2.39.1'].includes(t))
  const withoutBetas = selectUpdate({
    currentTag: '2.38.4',
    availableTags: stableOnly,
    kind: 'semver',
  })
  assert.equal(withoutBetas.status, 'update')
  assert.equal(withoutBetas.status === 'update' ? withoutBetas.tag : '', '2.38.5')
})

test('when every candidate is a prerelease the answer is up-to-date, not a beta', () => {
  const all = ['1.2.0', '1.3.0', '1.3.1']
  const filtered = all.filter((t) => !['1.3.0', '1.3.1'].includes(t))
  const cmp = selectUpdate({ currentTag: '1.2.0', availableTags: filtered, kind: 'semver' })
  assert.equal(cmp.status, 'up-to-date')
})

test('filtering can only narrow, never widen', () => {
  // The safety property of doing this as a second pass over a subset: whatever comes
  // back was already an acceptable candidate before the filter ran.
  const all = ['2.0.0', '2.1.0', '2.2.0']
  const before = selectUpdate({ currentTag: '2.0.0', availableTags: all, kind: 'semver' })
  const after = selectUpdate({
    currentTag: '2.0.0',
    availableTags: all.filter((t) => t !== '2.2.0'),
    kind: 'semver',
  })
  assert.equal(before.status === 'update' ? before.tag : '', '2.2.0')
  assert.equal(after.status === 'update' ? after.tag : '', '2.1.0')
  assert.ok(all.includes(after.status === 'update' ? after.tag : ''))
})
