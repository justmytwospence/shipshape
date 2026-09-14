import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectUpdate } from '../src/versions/compare.ts'
import { versionKey } from '../src/versions/key.ts'
import { prereleaseStream, prereleaseExclusions, type StreamRelease } from '../src/versions/stream.ts'

/**
 * A prerelease is not an update -- for a service on the stable line.
 *
 * The registry publishes betas and stable builds with identical tag shapes, so nothing
 * about a tag can separate them: n8n ships 2.39.0 (prerelease) alongside 2.38.5 (stable),
 * and 2.39.0 sorts higher. But minuspod's maintainer marks nearly every release a
 * prerelease, and the version running here is one of them; excluding prereleases there
 * would stop its updates altogether. So the rule follows the stream the service is on.
 */

const rel = (tag: string, prerelease = false): StreamRelease => ({ tag, key: versionKey(tag), prerelease })

const N8N = [rel('n8n@2.39.1', true), rel('n8n@2.39.0', true), rel('n8n@2.38.5'), rel('n8n@2.38.4')]
const MINUSPOD = [
  rel('v2.96.25', true),
  rel('v2.96.24', true),
  rel('v2.96.22', true),
  rel('v2.96.15', true),
  rel('v2.95.3'),
  rel('v2.94.11', true),
]

test('n8n on a stable release is on the stable stream, and its betas are set aside', () => {
  const s = prereleaseStream('2.38.4', N8N)
  assert.equal(s.stream, 'stable')
  assert.match(s.basis, /n8n@2\.38\.4, is stable/)

  const tags = ['2.38.4', '2.38.5', '2.39.0', '2.39.1']
  const excluded = prereleaseExclusions(tags, N8N, s)
  assert.deepEqual([...excluded].sort(), ['2.39.0', '2.39.1'])

  const cmp = selectUpdate({ currentTag: '2.38.4', availableTags: tags.filter((t) => !excluded.has(t)), kind: 'semver' })
  assert.equal(cmp.status === 'update' && cmp.tag, '2.38.5', 'the real patch still arrives')
})

test('minuspod on a version with no release follows the nearest release below it, a prerelease', () => {
  const s = prereleaseStream('2.96.17-cpu', MINUSPOD)
  assert.equal(s.stream, 'prerelease')
  assert.match(s.basis, /nearest release below it, v2\.96\.15, is a prerelease/)
  assert.deepEqual([...prereleaseExclusions(['2.96.17-cpu', '2.96.22-cpu', '2.96.25-cpu'], MINUSPOD, s)], [])
})

test('a running tag that is itself a prerelease is on the prerelease stream', () => {
  assert.equal(prereleaseStream('1.3.0-rc.1', [rel('v1.2.0'), rel('v1.3.0-rc.2', true)]).stream, 'prerelease')
})

test('with no releases to compare against, nothing is set aside', () => {
  const s = prereleaseStream('2.38.4', [])
  assert.equal(s.stream, 'unknown')
  assert.deepEqual([...prereleaseExclusions(['2.39.0'], [], s)], [])
})

test('a version older than every release fetched is treated as stable', () => {
  const s = prereleaseStream('1.0.0', [rel('v2.1.0-beta.1', true), rel('v2.0.0')])
  assert.equal(s.stream, 'stable')
})

test('a floating tag names a line, not a release, so the stream is unknown', () => {
  assert.equal(prereleaseStream('16', [rel('v16.4'), rel('v17.0-beta1', true)]).stream, 'unknown')
})

test("code-server's LinuxServer build matches coder's releases by version, not by build", () => {
  const coder = [rel('v4.137.0', true), rel('v4.136.2')]
  const s = prereleaseStream('4.136.2-ls363', coder)
  assert.equal(s.stream, 'stable')
  assert.deepEqual([...prereleaseExclusions(['4.136.2-ls363', '4.137.0-ls364'], coder, s)], ['4.137.0-ls364'])
})

test("grocy's version- tags meet their releases", () => {
  // The old normalisation turned `version-v2.7.1` into `ersion-v2.7.1`, so it matched nothing.
  const grocy = [rel('v2.8.0', true), rel('v2.7.1')]
  const s = prereleaseStream('version-v2.7.1', grocy)
  assert.equal(s.stream, 'stable')
  assert.deepEqual([...prereleaseExclusions(['version-v2.7.1', 'version-v2.8.0'], grocy, s)], ['version-v2.8.0'])
})

test('a version published both as a prerelease and as a release is a release', () => {
  const both = [rel('v3.0.0', true), rel('v3.0.0'), rel('v2.9.0')]
  const s = prereleaseStream('2.9.0', both)
  assert.deepEqual([...prereleaseExclusions(['3.0.0'], both, s)], [])
})

test('dropping the prerelease picks the stable below it, not nothing', () => {
  const all = ['2.38.4', '2.38.5', '2.39.0', '2.39.1']
  const withBetas = selectUpdate({ currentTag: '2.38.4', availableTags: all, kind: 'semver' })
  assert.equal(withBetas.status === 'update' && withBetas.tag, '2.39.1')
  const withoutBetas = selectUpdate({ currentTag: '2.38.4', availableTags: ['2.38.4', '2.38.5'], kind: 'semver' })
  assert.equal(withoutBetas.status === 'update' && withoutBetas.tag, '2.38.5')
})

test('when every candidate is a prerelease the answer is up-to-date, not a beta', () => {
  const cmp = selectUpdate({ currentTag: '1.2.0', availableTags: ['1.2.0'], kind: 'semver' })
  assert.equal(cmp.status, 'up-to-date')
})

test('filtering can only narrow, never widen', () => {
  // The safety property of a second pass over a subset: whatever comes back was already an
  // acceptable candidate before the filter ran.
  const all = ['2.0.0', '2.1.0', '2.2.0']
  const before = selectUpdate({ currentTag: '2.0.0', availableTags: all, kind: 'semver' })
  const after = selectUpdate({ currentTag: '2.0.0', availableTags: all.filter((t) => t !== '2.2.0'), kind: 'semver' })
  assert.equal(before.status === 'update' && before.tag, '2.2.0')
  assert.equal(after.status === 'update' && after.tag, '2.1.0')
})
