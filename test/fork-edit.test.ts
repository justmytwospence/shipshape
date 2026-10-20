import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'yaml'
import { bumpFork, readForkPin, retireFork } from '../src/compose/fork-edit.ts'

/**
 * Moving a fork's pins (FORKS.md) in compose text, and nothing else.
 *
 * The fixture is the shape of the one real fork, grimmory in books/, copied rather than
 * read so this test is about the editor and not about the live file.
 */

const OLD_SHA = 'ecca03b9b1b03f2aa6023ac34f5dc5dadbdbe4dd'
const NEW_SHA = '9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d'
const OLD_UPSTREAM =
  'ghcr.io/grimmory-tools/grimmory:v3.3.3@sha256:fffd0ae0bfccd64ca00441e8fa58a14e286b9115e5df1cb47eecf294ad09e6ff'
const NEW_UPSTREAM =
  'ghcr.io/grimmory-tools/grimmory:v3.5.1@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

const FIXTURE = `services:

  # ---------- Grimmory: ebook library + Kobo/OPDS/KOReader sync ----------
  mariadb:
    image: lscr.io/linuxserver/mariadb:11.4.5
    labels:
      shipshape.watch: "true"

  grimmory:
    container_name: grimmory
    # FORK (FORKS.md): runs our \`homelab\` branch of justmytwospence/grimmory = upstream
    # v3.3.3 + the Kobo reading-statistics fix (grimmory-tools/grimmory#2952). Retire it
    # once shipshape reports #2952 released. Deploy with \`up -d --build grimmory\`.
    build:
      context: https://github.com/justmytwospence/grimmory.git#${OLD_SHA}
      args:
        APP_VERSION: v3.3.3-fork.ecca03b
        APP_REVISION: ${OLD_SHA}
    image: grimmory-fork:v3.3.3-ecca03b
    restart: unless-stopped
    environment:
      TZ: "\${TZ}"
      ALLOWED_ORIGINS: "https://books.\${DOMAIN}"   # pin CORS origins
    labels:
      traefik.enable: true
      traefik.http.routers.grimmory.rule: "Host(\`books.\${DOMAIN}\`)"   # v3.3.3 is mentioned nowhere here
      shipshape.watch: "true"
      shipshape.fork.upstream: ${OLD_UPSTREAM}
      shipshape.fork.waits-on: grimmory-tools/grimmory#2952
      shipshape.pattern: v-semver
      shipshape.tag.include: '^v\\d{1,3}\\.\\d+\\.\\d+$$'
      shipshape.policy: manual
    networks:
      - grimmory
      - traefik

  shelfmark:
    image: ghcr.io/calibrain/shelfmark:1.4.0
`

const BUMP = { expectedSha: OLD_SHA, newSha: NEW_SHA, newTag: 'v3.5.1', newUpstream: NEW_UPSTREAM }

test('readForkPin reads the four pins and the build args', () => {
  const r = readForkPin(FIXTURE, 'grimmory')
  assert.ok(r.ok)
  assert.deepEqual(r.pin, {
    contextUrl: 'https://github.com/justmytwospence/grimmory.git',
    sha: OLD_SHA,
    shortSha: 'ecca03b',
    image: 'grimmory-fork:v3.3.3-ecca03b',
    imageName: 'grimmory-fork',
    baseTag: 'v3.3.3',
    upstream: OLD_UPSTREAM,
    args: { APP_VERSION: 'v3.3.3-fork.ecca03b', APP_REVISION: OLD_SHA },
  })
})

test('readForkPin refuses shapes the editor could not bump', () => {
  const bad = (text: string, re: RegExp) => {
    const r = readForkPin(text, 'app')
    assert.equal(r.ok, false)
    assert.match((r as { reason: string }).reason, re)
  }
  bad(`services:\n  app:\n    image: x:1\n`, /no build\.context/)
  bad(`services:\n  app:\n    build:\n      context: https://x/y.git#main\n    image: x:1-abc1234\n`, /not pinned to a commit/)
  bad(`services:\n  app:\n    build:\n      context: https://x/y.git#${OLD_SHA}\n    image: x:v1\n`, /does not end with the pinned commit/)
  bad(`services:\n  app:\n    build:\n      context: https://x/y.git#${OLD_SHA}\n    image: x:v1-ecca03b\n`, /no shipshape\.fork\.upstream/)
  bad(`services:\n  app:\n    build:\n      context: https://x/y.git#${OLD_SHA}\n    image: x\n    labels:\n      shipshape.fork.upstream: u:1\n`, /has no tag/)
})

test('bumpFork rewrites exactly the four places, and the args follow', () => {
  const r = bumpFork(FIXTURE, 'grimmory', BUMP)
  assert.ok(r.ok, (r as { reason?: string }).reason)
  const before = FIXTURE.split('\n')
  const after = r.text.split('\n')
  assert.equal(after.length, before.length, 'no line added or removed')
  const changed = before.map((l, i) => (l === after[i] ? null : [l.trim(), after[i]!.trim()])).filter(Boolean)
  assert.deepEqual(changed, [
    [
      `context: https://github.com/justmytwospence/grimmory.git#${OLD_SHA}`,
      `context: https://github.com/justmytwospence/grimmory.git#${NEW_SHA}`,
    ],
    ['APP_VERSION: v3.3.3-fork.ecca03b', 'APP_VERSION: v3.5.1-fork.9f1c2d3'],
    [`APP_REVISION: ${OLD_SHA}`, `APP_REVISION: ${NEW_SHA}`],
    ['image: grimmory-fork:v3.3.3-ecca03b', 'image: grimmory-fork:v3.5.1-9f1c2d3'],
    [`shipshape.fork.upstream: ${OLD_UPSTREAM}`, `shipshape.fork.upstream: ${NEW_UPSTREAM}`],
  ])
  // The comment that mentions v3.3.3 and the traefik label that mentions it are untouched.
  assert.ok(r.text.includes('# v3.3.3 + the Kobo reading-statistics fix'))
  assert.ok(r.text.includes('# v3.3.3 is mentioned nowhere here'))
  // The other services are byte-identical.
  const svc = (t: string, name: string) => parse(t).services[name]
  assert.deepEqual(svc(r.text, 'mariadb'), svc(FIXTURE, 'mariadb'))
  assert.deepEqual(svc(r.text, 'shelfmark'), svc(FIXTURE, 'shelfmark'))
  const g = svc(r.text, 'grimmory')
  assert.equal(g.build.context, `https://github.com/justmytwospence/grimmory.git#${NEW_SHA}`)
  assert.equal(g.build.args.APP_VERSION, 'v3.5.1-fork.9f1c2d3')
  assert.equal(g.image, 'grimmory-fork:v3.5.1-9f1c2d3')
  assert.equal(g.labels['shipshape.fork.upstream'], NEW_UPSTREAM)
  assert.equal(g.labels['shipshape.fork.waits-on'], 'grimmory-tools/grimmory#2952')
})

test('bumpFork is idempotent: applied to its own output it reports already applied', () => {
  const once = bumpFork(FIXTURE, 'grimmory', BUMP)
  assert.ok(once.ok)
  const twice = bumpFork(once.text, 'grimmory', BUMP)
  assert.equal(twice.ok, false)
  assert.equal((twice as { alreadyApplied?: boolean }).alreadyApplied, true)
})

test('bumpFork refuses when the file builds from a commit it did not expect', () => {
  const r = bumpFork(FIXTURE, 'grimmory', { ...BUMP, expectedSha: 'a'.repeat(40) })
  assert.equal(r.ok, false)
  assert.notEqual((r as { alreadyApplied?: boolean }).alreadyApplied, true)
  assert.match((r as { reason: string }).reason, /now builds from ecca03b, expected aaaaaaa/)
})

test('bumpFork handles list-form build args and a fork with none', () => {
  const list = FIXTURE.replace(
    `      args:\n        APP_VERSION: v3.3.3-fork.ecca03b\n        APP_REVISION: ${OLD_SHA}\n`,
    `      args:\n        - APP_VERSION=v3.3.3-fork.ecca03b\n        - APP_REVISION=${OLD_SHA}\n`,
  )
  const r = bumpFork(list, 'grimmory', BUMP)
  assert.ok(r.ok, (r as { reason?: string }).reason)
  assert.deepEqual(parse(r.text).services.grimmory.build.args, [
    'APP_VERSION=v3.5.1-fork.9f1c2d3',
    `APP_REVISION=${NEW_SHA}`,
  ])

  const none = FIXTURE.replace(`      args:\n        APP_VERSION: v3.3.3-fork.ecca03b\n        APP_REVISION: ${OLD_SHA}\n`, '')
  const n = bumpFork(none, 'grimmory', BUMP)
  assert.ok(n.ok, (n as { reason?: string }).reason)
  assert.equal(parse(n.text).services.grimmory.build.args, undefined)
})

test('bumpFork follows the base tag only where it stands as a whole version', () => {
  const tricky = FIXTURE.replace(
    `        APP_REVISION: ${OLD_SHA}\n`,
    `        APP_REVISION: ${OLD_SHA}\n        NOT_THIS: v3.3.30\n        BARE: v3.3.3\n`,
  )
  const r = bumpFork(tricky, 'grimmory', BUMP)
  assert.ok(r.ok, (r as { reason?: string }).reason)
  const args = parse(r.text).services.grimmory.build.args
  assert.equal(args.NOT_THIS, 'v3.3.30')
  assert.equal(args.BARE, 'v3.5.1')
})

test('retireFork removes build: and the fork labels, and sets the upstream image', () => {
  const r = retireFork(FIXTURE, 'grimmory', { expectedSha: OLD_SHA, upstreamRef: NEW_UPSTREAM })
  assert.ok(r.ok, (r as { reason?: string }).reason)
  const g = parse(r.text).services.grimmory
  assert.equal(g.build, undefined)
  assert.equal(g.image, NEW_UPSTREAM)
  assert.equal(g.labels['shipshape.fork.upstream'], undefined)
  assert.equal(g.labels['shipshape.fork.waits-on'], undefined)
  // Everything else about the service survives, the other labels included.
  assert.equal(g.labels['shipshape.pattern'], 'v-semver')
  assert.equal(g.labels['shipshape.policy'], 'manual')
  assert.equal(g.container_name, 'grimmory')
  assert.deepEqual(g.networks, ['grimmory', 'traefik'])
  // The prose is left for a person, and the neighbours are untouched.
  assert.ok(r.text.includes('# FORK (FORKS.md)'))
  assert.deepEqual(parse(r.text).services.mariadb, parse(FIXTURE).services.mariadb)
  assert.deepEqual(parse(r.text).services.shelfmark, parse(FIXTURE).services.shelfmark)
  // Line-level: the build block (5 lines) and two labels went; one line changed.
  assert.equal(r.text.split('\n').length, FIXTURE.split('\n').length - 7)
  assert.ok(!r.text.includes('      context:'))
  assert.ok(!r.text.includes('APP_REVISION'))
})

test('retireFork is idempotent and refuses an unexpected pin', () => {
  const once = retireFork(FIXTURE, 'grimmory', { expectedSha: OLD_SHA, upstreamRef: NEW_UPSTREAM })
  assert.ok(once.ok)
  const twice = retireFork(once.text, 'grimmory', { expectedSha: OLD_SHA, upstreamRef: NEW_UPSTREAM })
  assert.equal(twice.ok, false)
  assert.equal((twice as { alreadyApplied?: boolean }).alreadyApplied, true)

  const wrong = retireFork(FIXTURE, 'grimmory', { expectedSha: 'b'.repeat(40), upstreamRef: NEW_UPSTREAM })
  assert.equal(wrong.ok, false)
  assert.match((wrong as { reason: string }).reason, /expected bbbbbbb/)
})
