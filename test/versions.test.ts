import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectUpdate, intermediateTags } from '../src/versions/compare.ts'
import { inferPattern, parseTag, classify } from '../src/versions/patterns.ts'

test('plain semver picks the newest and classifies the slot', () => {
  const tags = ['2.16.9', '2.17.0', '2.17.1', '3.0.0']
  assert.deepEqual(selectUpdate({ currentTag: '2.17.0', availableTags: tags, kind: 'semver' }), {
    status: 'update',
    tag: '3.0.0',
    magnitude: 'major',
  })
  assert.deepEqual(selectUpdate({ currentTag: '2.17.0', availableTags: ['2.17.1', '2.16.0'], kind: 'semver' }), {
    status: 'update',
    tag: '2.17.1',
    magnitude: 'patch',
  })
  assert.deepEqual(selectUpdate({ currentTag: '2.17.0', availableTags: ['2.18.0'], kind: 'semver' }), {
    status: 'update',
    tag: '2.18.0',
    magnitude: 'minor',
  })
})

// The trap AGENTS.md documents at length: a bare \d+ in the major slot matches a
// four-digit date, and the compare then ranks 2021.12.16 above every real release.
test('four-digit date tags never masquerade as semver', () => {
  const tags = ['2.17.0', '2.17.1', '2021.12.16', '2026.04.1']
  const got = selectUpdate({ currentTag: '2.17.0', availableTags: tags, kind: 'semver' })
  assert.deepEqual(got, { status: 'update', tag: '2.17.1', magnitude: 'patch' })
})

test('a tag outside the series is not a candidate', () => {
  // postgres:16 must not drift onto 16-alpine, and semver must ignore `latest`.
  assert.deepEqual(
    selectUpdate({
      currentTag: '16',
      availableTags: ['16-alpine', '17-bookworm', 'latest'],
      kind: 'major-only',
    }),
    { status: 'up-to-date' },
  )
  assert.deepEqual(
    selectUpdate({ currentTag: '16', availableTags: ['17', 'latest', '16-alpine'], kind: 'major-only' }),
    { status: 'update', tag: '17', magnitude: 'major' },
  )
})

test('linuxserver build counters compare numerically, not lexically', () => {
  // The whole point of the -lsN transform WUD needed: ls9 < ls374 numerically, but
  // "ls9" > "ls374" lexically.
  assert.deepEqual(
    selectUpdate({
      currentTag: '2.2.0-ls9',
      availableTags: ['2.2.0-ls9', '2.2.0-ls374'],
      kind: 'lsio-ls',
    }),
    { status: 'update', tag: '2.2.0-ls374', magnitude: 'patch' },
  )
  // A pure packaging bump is a patch -- the app did not change, only the container.
  assert.deepEqual(
    selectUpdate({
      currentTag: '5.1.4-r3-ls453',
      availableTags: ['5.1.4-r3-ls460'],
      kind: 'lsio-r-ls',
    }),
    { status: 'update', tag: '5.1.4-r3-ls460', magnitude: 'patch' },
  )
  // ...but an upstream move in the same tag family is still major.
  assert.deepEqual(
    selectUpdate({
      currentTag: '5.1.4-r3-ls453',
      availableTags: ['6.0.0-r1-ls400'],
      kind: 'lsio-r-ls',
    }),
    { status: 'update', tag: '6.0.0-r1-ls400', magnitude: 'major' },
  )
})

test('lsio tags carrying a distro marker still parse', () => {
  // jellyfin ships 10.11.11ubu2604-ls43
  const p = parseTag('10.11.11ubu2604-ls43', 'lsio-ls')
  assert.ok(p, 'expected the ubu marker to be tolerated')
  assert.deepEqual(p.parts, [10, 11, 11, 43])
})

test('date tags order correctly', () => {
  assert.deepEqual(
    selectUpdate({
      currentTag: '2026.04.1',
      availableTags: ['2026.03.2', '2026.04.1', '2026.04.2', '2026.05.0'],
      kind: 'date',
    }),
    { status: 'update', tag: '2026.05.0', magnitude: 'minor' },
  )
  assert.deepEqual(
    selectUpdate({
      currentTag: '2026-07-28',
      availableTags: ['2026-07-29'],
      kind: 'date',
    }),
    { status: 'update', tag: '2026-07-29', magnitude: 'patch' },
  )
})

test('latest and digest series are reported as not-orderable, not up-to-date', () => {
  assert.deepEqual(selectUpdate({ currentTag: 'latest', availableTags: ['latest'], kind: 'latest' }), {
    status: 'not-orderable',
  })
  // bluesky/pds pins `0.4@sha256:...` where 0.4 is a moving alias -- comparing the tag
  // string would be meaningless, so digest watching handles it instead.
  assert.deepEqual(selectUpdate({ currentTag: '0.4', availableTags: ['0.4', '0.5'], kind: 'digest' }), {
    status: 'not-orderable',
  })
})

test('tag.include refines the candidate set', () => {
  // grafana ships 12.4-ubuntu alongside plain tags; the refinement keeps the variant.
  const tags = ['12.4.0', '12.5.0', '12.5.0-ubuntu']
  assert.deepEqual(
    selectUpdate({
      currentTag: '12.4.0',
      availableTags: tags,
      kind: 'semver',
      tagInclude: '^\\d{1,3}\\.\\d+\\.\\d+$',
    }),
    { status: 'update', tag: '12.5.0', magnitude: 'minor' },
  )
})

test('a malformed tag.include fails closed rather than widening the set', () => {
  assert.equal(
    selectUpdate({
      currentTag: '1.0.0',
      availableTags: ['2.0.0'],
      kind: 'semver',
      tagInclude: '([unclosed',
    }).status,
    'bad-refinement',
  )
})

test('custom regex uses named groups when present', () => {
  // paperless-webdav fork tags: v2.3.6-fork.8
  assert.deepEqual(
    selectUpdate({
      currentTag: 'v2.3.6-fork.8',
      availableTags: ['v2.3.6-fork.8', 'v2.3.6-fork.9', 'v2.3.7-fork.1'],
      kind: 'regex',
      regex: '^v(?<major>\\d{1,3})\\.(?<minor>\\d+)\\.(?<patch>\\d+)-fork\\.(?<build>\\d+)$',
    }),
    { status: 'update', tag: 'v2.3.7-fork.1', magnitude: 'patch' },
  )
})

test('downgrades and equal tags are never proposed', () => {
  assert.deepEqual(selectUpdate({ currentTag: '3.0.0', availableTags: ['2.9.9', '3.0.0'], kind: 'semver' }), {
    status: 'up-to-date',
  })
})

test('intermediate tags give the analyzer every release in the range', () => {
  assert.deepEqual(
    intermediateTags({
      currentTag: '2.17.0',
      availableTags: ['2.16.0', '2.17.0', '2.17.1', '2.18.0', '2.17.2'],
      kind: 'semver',
    }),
    ['2.17.1', '2.17.2', '2.18.0'],
  )
})

test('pattern inference seeds the label migration from a real tag', () => {
  const cases: [string, string][] = [
    ['2.17.0', 'semver'],
    ['v3.11.3', 'v-semver'],
    ['17', 'major-only'],
    ['v2', 'v-major-only'],
    ['2.2.0-ls374', 'lsio-ls'],
    ['5.1.4-r3-ls453', 'lsio-r-ls'],
    ['10.11.11ubu2604-ls43', 'lsio-ls'],
    ['2026.04.1', 'date'],
    ['2026-07-28', 'date'],
    ['latest', 'latest'],
    ['stable', 'latest'],
    ['apache', 'latest'],
  ]
  for (const [tag, want] of cases) {
    assert.equal(inferPattern(tag), want, `inferPattern(${tag})`)
  }
  // apache/tika ships four-component versions.
  assert.equal(inferPattern('3.3.1.0'), 'semver-quad')
  // Genuinely ambiguous shapes must return null so the migration reports them for a
  // human rather than guessing.
  assert.equal(inferPattern('RELEASE.2025-09-07T16-13-09Z'), null)
  assert.equal(inferPattern('version-v2.7.1'), null)
  assert.equal(inferPattern('v0-14-3-1'), null)
  assert.equal(inferPattern('stdio'), null)
})

test('classify treats a date year-rollover as major', () => {
  const a = parseTag('2025.12.1', 'date')!
  const b = parseTag('2026.01.1', 'date')!
  assert.equal(classify(a, b, 'date'), 'major')
})

// The bug this guards against: `traefik:v3.7` declared as `semver` parses as nothing,
// and an earlier version of selectUpdate returned null for that -- indistinguishable
// from "no newer release". A stale image would have been reported as current forever.
test('a tag that does not match its pattern is reported, not silently up-to-date', () => {
  const got = selectUpdate({
    currentTag: 'v3.7',
    availableTags: ['v3.7', 'v3.8'],
    kind: 'semver',
  })
  assert.equal(got.status, 'unparseable-current')
})

test('two-component series preserve their precision', () => {
  // traefik pins v3.7: it must move to v3.8, never to v3.8.0.
  assert.deepEqual(
    selectUpdate({
      currentTag: 'v3.7',
      availableTags: ['v3.7', 'v3.8', 'v3.8.0', 'v4.0'],
      kind: 'v-semver-minor',
    }),
    { status: 'update', tag: 'v4.0', magnitude: 'major' },
  )
  assert.deepEqual(
    selectUpdate({
      currentTag: 'v3.7',
      availableTags: ['v3.8', 'v3.8.1'],
      kind: 'v-semver-minor',
    }),
    { status: 'update', tag: 'v3.8', magnitude: 'minor' },
  )
  assert.equal(inferPattern('v3.7'), 'v-semver-minor')
  assert.equal(inferPattern('12.4'), 'semver-minor')
})

test('variant series never cross flavours', () => {
  // postgres:16-alpine must follow the alpine line only. Moving it to a plain `17` --
  // or to `17-bookworm` -- would swap the base image out from under the database.
  assert.deepEqual(
    selectUpdate({
      currentTag: '16-alpine',
      availableTags: ['16-alpine', '17-alpine', '18', '17-bookworm'],
      kind: 'major-variant',
    }),
    { status: 'update', tag: '17-alpine', magnitude: 'major' },
  )
  // grafana:12.4-ubuntu
  assert.deepEqual(
    selectUpdate({
      currentTag: '12.4-ubuntu',
      availableTags: ['12.5-ubuntu', '12.6.0', '13.0-alpine'],
      kind: 'semver-minor-variant',
    }),
    { status: 'update', tag: '12.5-ubuntu', magnitude: 'minor' },
  )
  // glances:4.5.4-full, minuspod:2.83.3-cpu
  assert.deepEqual(
    selectUpdate({
      currentTag: '4.5.4-full',
      availableTags: ['4.5.5-full', '4.6.0', '4.6.0-slim'],
      kind: 'semver-variant',
    }),
    { status: 'update', tag: '4.5.5-full', magnitude: 'patch' },
  )
  assert.equal(inferPattern('16-alpine'), 'major-variant')
  assert.equal(inferPattern('12.4-ubuntu'), 'semver-minor-variant')
  assert.equal(inferPattern('4.5.4-full'), 'semver-variant')
})

test('variant kinds do not swallow linuxserver build counters', () => {
  // The reason variants are opt-in kinds rather than an implicit feature of semver:
  // under a naive variant rule `2.2.0-ls374` would parse as variant "ls374", unique to
  // that build, and the image would never update again.
  assert.equal(inferPattern('2.2.0-ls374'), 'lsio-ls')
  assert.equal(inferPattern('5.1.4-r3-ls453'), 'lsio-r-ls')
})

test('four-component versions compare on every slot', () => {
  assert.deepEqual(
    selectUpdate({
      currentTag: '3.3.1.0',
      availableTags: ['3.3.1.0', '3.3.1.1', '3.3.2.0'],
      kind: 'semver-quad',
    }),
    { status: 'update', tag: '3.3.2.0', magnitude: 'patch' },
  )
})
