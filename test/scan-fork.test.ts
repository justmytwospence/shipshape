import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KNOWN_LABELS, parseWaitsOn, scanRepo } from '../src/compose/scan.ts'
import { tierFor } from '../src/policy.ts'
import { actionsFor, refusalFor } from '../src/updates/actions.ts'

/**
 * A fork (FORKS.md) is a `build:` service that is watched anyway: its `ref` is the
 * upstream image named by `shipshape.fork.upstream`, its references are read from
 * `shipshape.fork.waits-on`, and its tier is held whatever else the labels say.
 */

const repo = mkdtempSync(join(tmpdir(), 'shipshape-fork-scan-'))
after(() => rmSync(repo, { recursive: true, force: true }))

mkdirSync(join(repo, 'books'))
writeFileSync(
  join(repo, 'books', 'docker-compose.yaml'),
  `services:
  grimmory:
    build:
      context: https://github.com/justmytwospence/grimmory.git#ecca03b9b1b03f2aa6023ac34f5dc5dadbdbe4dd
    image: grimmory-fork:v3.3.3-ecca03b
    labels:
      shipshape.watch: "true"
      shipshape.fork.upstream: ghcr.io/grimmory-tools/grimmory:v3.3.3@sha256:fffd0ae0bfccd64ca00441e8fa58a14e286b9115e5df1cb47eecf294ad09e6ff
      shipshape.fork.waits-on: grimmory-tools/grimmory#2952, grimmory-tools/grimmory#2960,not-a-ref, grimmory-tools/grimmory#2952
      shipshape.pattern: digest
      shipshape.tag.include: '^v\\d{1,3}\\.\\d+\\.\\d+$$'
      shipshape.policy: manual
  plain-build:
    build: ./x
    image: local:1
    labels:
      shipshape.watch: "true"
  bad-fork:
    build: ./y
    image: local:2
    labels:
      shipshape.watch: "true"
      shipshape.fork.upstream: \${UPSTREAM_IMAGE}
  orphan:
    image: nginx:1.27.0
    labels:
      shipshape.watch: "true"
      shipshape.fork.waits-on: o/r#1
`,
)

const byName = Object.fromEntries(scanRepo(repo).map((s) => [s.service, s]))

test('the fork labels are known labels, not warnings', () => {
  assert.ok(KNOWN_LABELS.has('fork.upstream'))
  assert.ok(KNOWN_LABELS.has('fork.waits-on'))
  assert.deepEqual(byName.grimmory!.unknownLabels, [])
})

test('a fork is watched despite build:, and its ref is the upstream image', () => {
  const s = byName.grimmory!
  assert.equal(s.hasBuild, true)
  assert.equal(s.unwatchable, null)
  assert.equal(s.watched, true)
  // The local build name stays as what the file says runs.
  assert.equal(s.imageRaw, 'grimmory-fork:v3.3.3-ecca03b')
  assert.equal(s.ref?.registry, 'ghcr.io')
  assert.equal(s.ref?.repository, 'grimmory-tools/grimmory')
  assert.equal(s.ref?.tag, 'v3.3.3')
  assert.match(s.ref?.digest ?? '', /^sha256:fffd/)
  assert.equal(s.fork?.upstream, 'ghcr.io/grimmory-tools/grimmory:v3.3.3@sha256:fffd0ae0bfccd64ca00441e8fa58a14e286b9115e5df1cb47eecf294ad09e6ff')
  // The other labels still describe the upstream image.
  assert.equal(s.pattern, 'digest')
  assert.equal(s.policyLabel, 'manual')
})

test('waits-on is split, trimmed, deduplicated, and a malformed entry is reported rather than fatal', () => {
  const s = byName.grimmory!
  assert.deepEqual(s.fork?.waitsOn, ['grimmory-tools/grimmory#2952', 'grimmory-tools/grimmory#2960'])
  assert.deepEqual(s.labelProblems, ['shipshape.fork.waits-on entry "not-a-ref" is not owner/repo#N'])
  assert.deepEqual(parseWaitsOn(' o/r#1 ,o/r#2,,'), { refs: ['o/r#1', 'o/r#2'], malformed: [] })
  assert.deepEqual(parseWaitsOn(null), { refs: [], malformed: [] })
  assert.deepEqual(parseWaitsOn('https://github.com/o/r/pull/3'), { refs: [], malformed: ['https://github.com/o/r/pull/3'] })
})

test('a plain build: service is still unwatchable, and a fork.upstream that cannot be read leaves it so', () => {
  assert.equal(byName['plain-build']!.unwatchable, 'build')
  assert.equal(byName['plain-build']!.fork, null)
  const bad = byName['bad-fork']!
  assert.equal(bad.unwatchable, 'build')
  assert.equal(bad.fork, null)
  assert.equal(bad.labelProblems.length, 1)
  assert.match(bad.labelProblems[0]!, /fork\.upstream .* is not an image reference/)
})

test('waits-on without an upstream is said out loud and changes nothing', () => {
  const o = byName.orphan!
  assert.equal(o.fork, null)
  assert.equal(o.ref?.repository, 'library/nginx')
  assert.deepEqual(o.labelProblems, ['shipshape.fork.waits-on without shipshape.fork.upstream does nothing'])
})

const DEFAULTS = { patch: 'auto', minor: 'auto', major: 'manual', digest: 'manual' } as const

test('a fork is held on every rung, whatever the labels say', () => {
  for (const magnitude of ['patch', 'minor', 'major', 'digest'] as const) {
    for (const policyLabel of [null, 'auto', 'manual', 'attended', 'on-request', 'skip', 'typo']) {
      assert.equal(
        tierFor({ magnitude, policyLabel, prLabel: null, fork: true, defaults: DEFAULTS }),
        'held',
        `${magnitude} with policy ${policyLabel}`,
      )
    }
  }
  // And nothing changes for everything else.
  assert.equal(tierFor({ magnitude: 'patch', policyLabel: null, prLabel: null, fork: false, defaults: DEFAULTS }), 'auto')
  assert.equal(tierFor({ magnitude: 'patch', policyLabel: 'skip', prLabel: null, defaults: DEFAULTS }), 'skip')
})

test('a held fork update offers no pull request, and says why', () => {
  assert.deepEqual(actionsFor({ state: 'held', fork: true }), ['skip'])
  assert.deepEqual(actionsFor({ state: 'held' }), ['open-pr', 'skip'])
  assert.match(refusalFor('open-pr', { state: 'held', fork: true }), /fork.*FORKS\.md/)
})
