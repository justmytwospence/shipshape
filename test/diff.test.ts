import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA = mkdtempSync(join(tmpdir(), 'shipshape-diff-'))
const REPO = mkdtempSync(join(tmpdir(), 'shipshape-repo-'))
process.env.DATA_DIR = DATA
process.env.HOMELAB_REPO = REPO

const { getDb } = await import('../src/db.ts')
const { buildUpdateDiff } = await import('../src/diff.ts')

/**
 * The fixture mirrors the shapes that actually bite: heavy comments around the target
 * line, and two services in one file carrying byte-identical image lines.
 */
const FIXTURE = `networks:
  demo:
    external: true

services:

  # The primary application. Comments here must survive untouched.
  app:
    container_name: demo_app
    image: ghcr.io/example/app:v2.7.5
    restart: unless-stopped
    labels:
      shipshape.watch: "true"
      shipshape.pattern: v-semver

  db:
    container_name: demo_db
    image: postgres:13.2
    restart: always

  # A second database on exactly the same image and tag as the first.
  db2:
    container_name: demo_db2
    image: postgres:13.2
    restart: always

  cache:
    container_name: demo_cache
    image: docker.io/valkey/valkey:9@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    restart: always
`

function seed(opts: {
  service: string
  fromTag: string
  toTag: string
  imageRef: string
  detail?: string
}): number {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO images (stack, service, compose_file, image_ref, registry, repository,
                         current_tag, watched, last_seen_at)
     VALUES ('demo', ?, 'demo/docker-compose.yaml', ?, 'docker.io', 'x/y', ?, 1, ?)
     ON CONFLICT(stack, service) DO UPDATE SET image_ref = excluded.image_ref`,
  ).run(opts.service, opts.imageRef, opts.fromTag, now)
  const info = db
    .prepare(
      `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state,
                            detail, detected_at, updated_at)
       VALUES ('demo', ?, ?, ?, ?, 'minor', 'manual', 'detected', ?, ?, ?)`,
    )
    .run(opts.service, opts.imageRef, opts.fromTag, opts.toTag, opts.detail ?? null, now, now)
  return Number(info.lastInsertRowid)
}

beforeEach(() => {
  mkdirSync(join(REPO, 'demo'), { recursive: true })
  writeFileSync(join(REPO, 'demo', 'docker-compose.yaml'), FIXTURE)
  getDb().exec(`DELETE FROM updates; DELETE FROM images;`)
})

test('produces exactly one replaced line, with surrounding context', () => {
  const id = seed({
    service: 'app',
    fromTag: 'v2.7.5',
    toTag: 'v3.1.0',
    imageRef: 'ghcr.io/example/app:v2.7.5',
  })
  const r = buildUpdateDiff(id)
  assert.ok(!('error' in r), 'expected a diff')
  const hunk = r.hunks[0]!

  const del = hunk.lines.filter((l) => l.kind === 'del')
  const add = hunk.lines.filter((l) => l.kind === 'add')
  assert.equal(del.length, 1)
  assert.equal(add.length, 1)
  assert.match(del[0]!.text, /image: ghcr\.io\/example\/app:v2\.7\.5$/)
  assert.match(add[0]!.text, /image: ghcr\.io\/example\/app:v3\.1\.0$/)
  // Indentation is preserved because only the value is spliced.
  assert.equal(del[0]!.text.match(/^\s*/)![0], add[0]!.text.match(/^\s*/)![0])
  // Context is real neighbouring content, including the comment above the service.
  assert.ok(hunk.lines.some((l) => l.kind === 'ctx' && l.text.includes('container_name: demo_app')))
})

test('targets the right service when two carry identical image lines', () => {
  // A whole-file search would rewrite db's line for db2. The document lookup must not.
  const idDb = seed({
    service: 'db',
    fromTag: '13.2',
    toTag: '18.4',
    imageRef: 'postgres:13.2',
  })
  const idDb2 = seed({
    service: 'db2',
    fromTag: '13.2',
    toTag: '18.4',
    imageRef: 'postgres:13.2',
  })

  const a = buildUpdateDiff(idDb)
  const b = buildUpdateDiff(idDb2)
  assert.ok(!('error' in a) && !('error' in b))
  const lineA = a.hunks[0]!.lines.find((l) => l.kind === 'del')!.no
  const lineB = b.hunks[0]!.lines.find((l) => l.kind === 'del')!.no
  assert.notEqual(lineA, lineB, 'the two services must resolve to different lines')
  assert.ok(a.hunks[0]!.header.endsWith('db'))
  assert.ok(b.hunks[0]!.header.endsWith('db2'))
})

test('digest bumps swap only the digest and keep the tag and registry spelling', () => {
  const oldRef =
    'docker.io/valkey/valkey:9@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const id = seed({
    service: 'cache',
    fromTag: '9@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    toTag: '9@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    imageRef: oldRef,
  })
  const r = buildUpdateDiff(id)
  assert.ok(!('error' in r))
  const add = r.hunks[0]!.lines.find((l) => l.kind === 'add')!
  assert.ok(add.text.includes('docker.io/valkey/valkey:9@sha256:bbbb'), add.text)
  assert.ok(!add.text.includes('aaaa'))
})

test('rolling rows explain themselves instead of rendering an empty diff', () => {
  const id = seed({
    service: 'app',
    fromTag: 'latest@sha256:aaa',
    toTag: 'latest@sha256:bbb',
    imageRef: 'ghcr.io/example/app:v2.7.5',
    detail: 'rolling',
  })
  const r = buildUpdateDiff(id)
  assert.ok('error' in r)
  assert.match(r.error, /Nothing changes in git/)
})

test('a stale row is reported rather than producing a wrong diff', () => {
  // The file says v2.7.5; this row claims to start from something else.
  const id = seed({
    service: 'app',
    fromTag: 'v1.0.0',
    toTag: 'v1.1.0',
    imageRef: 'ghcr.io/example/app:v1.0.0',
  })
  const r = buildUpdateDiff(id)
  assert.ok('error' in r)
  assert.match(r.error, /now reads .* but this update was computed against/)
})

test('unknown updates and missing services fail cleanly', () => {
  const missing = buildUpdateDiff(999999)
  assert.ok('error' in missing)
  const id = seed({
    service: 'ghost',
    fromTag: '1.0.0',
    toTag: '1.1.0',
    imageRef: 'ghost:1.0.0',
  })
  const r = buildUpdateDiff(id)
  assert.ok('error' in r)
  assert.match(r.error, /no image: found/)
})

/**
 * A fork's change (FORKS.md): nothing to show until the pull request pass has replayed the
 * fork, then the whole edit -- the build pin, the args, the image, the upstream label --
 * as hunks, with the carried fixes beside them. A conflict says why there is nothing.
 */
const FORK_SHA = 'ecca03b9b1b03f2aa6023ac34f5dc5dadbdbe4dd'
const FORK_FIXTURE = `services:
  grimmory:
    build:
      context: https://github.com/justmytwospence/grimmory.git#${FORK_SHA}
      args:
        APP_VERSION: v3.3.3-fork.ecca03b
    image: grimmory-fork:v3.3.3-ecca03b
    labels:
      shipshape.watch: "true"
      shipshape.fork.upstream: ghcr.io/grimmory-tools/grimmory:v3.3.3
`

function seedFork(): number {
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO images (stack, service, compose_file, image_ref, registry, repository, current_tag,
                         watched, fork_upstream, last_seen_at)
     VALUES ('books', 'grimmory', 'books/docker-compose.yaml', 'grimmory-fork:v3.3.3-ecca03b', 'ghcr.io',
             'grimmory-tools/grimmory', 'v3.3.3', 1, 'ghcr.io/grimmory-tools/grimmory:v3.3.3', ?)`,
  ).run(now)
  const info = db
    .prepare(
      `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state, detail, detected_at, updated_at)
       VALUES ('books', 'grimmory', 'ghcr.io/grimmory-tools/grimmory:v3.3.3', 'v3.3.3', 'v3.5.1', 'minor', 'auto', 'detected', 'fork', ?, ?)`,
    )
    .run(now, now)
  return Number(info.lastInsertRowid)
}

test('a fork says what will happen until the replay exists, then shows the whole edit and the carried fixes', async () => {
  mkdirSync(join(REPO, 'books'), { recursive: true })
  writeFileSync(join(REPO, 'books', 'docker-compose.yaml'), FORK_FIXTURE)
  const id = seedFork()

  const before = buildUpdateDiff(id)
  assert.ok('error' in before)
  assert.match(before.error, /replays the fork's fixes onto v3\.5\.1/)

  const { recordForkPrepared, recordForkConflict } = await import('../src/forks.ts')
  const newSha = '9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d'
  recordForkPrepared('books', 'grimmory', {
    kind: 'bump',
    toTag: 'v3.5.1',
    fromSha: FORK_SHA,
    sha: newSha,
    tag: 'homelab/v3.5.1-9f1c2d3',
    forkUrl: 'https://github.com/justmytwospence/grimmory.git',
    upstreamRef: 'ghcr.io/grimmory-tools/grimmory:v3.5.1',
    carried: [{ sha: 'c'.repeat(40), short: 'ccccccc', subject: 'fix: x', author: 'me' }],
    dropped: [],
    waitsOn: [],
  })
  const r = buildUpdateDiff(id)
  assert.ok(!('error' in r), (r as { error?: string }).error)
  assert.equal(r.fork?.kind, 'bump')
  assert.equal(r.fork?.sha, newSha)
  assert.deepEqual(r.fork?.carried.map((c) => c.short), ['ccccccc'])
  const del = r.hunks.flatMap((h) => h.lines.filter((l) => l.kind === 'del').map((l) => l.text.trim()))
  const add = r.hunks.flatMap((h) => h.lines.filter((l) => l.kind === 'add').map((l) => l.text.trim()))
  assert.deepEqual(del, [
    `context: https://github.com/justmytwospence/grimmory.git#${FORK_SHA}`,
    'APP_VERSION: v3.3.3-fork.ecca03b',
    'image: grimmory-fork:v3.3.3-ecca03b',
    'shipshape.fork.upstream: ghcr.io/grimmory-tools/grimmory:v3.3.3',
  ])
  assert.deepEqual(add, [
    `context: https://github.com/justmytwospence/grimmory.git#${newSha}`,
    'APP_VERSION: v3.5.1-fork.9f1c2d3',
    'image: grimmory-fork:v3.5.1-9f1c2d3',
    'shipshape.fork.upstream: ghcr.io/grimmory-tools/grimmory:v3.5.1',
  ])
  // Old line numbers are the file's own.
  assert.equal(r.hunks[0]!.lines.find((l) => l.kind === 'del')?.no, 4)

  // A retire removes lines, which the line diff has to carry too.
  recordForkPrepared('books', 'grimmory', {
    kind: 'retire',
    toTag: 'v3.5.1',
    fromSha: FORK_SHA,
    sha: null,
    tag: null,
    forkUrl: 'https://github.com/justmytwospence/grimmory.git',
    upstreamRef: 'ghcr.io/grimmory-tools/grimmory:v3.5.1',
    carried: [],
    dropped: [],
    waitsOn: [],
  })
  const retire = buildUpdateDiff(id)
  assert.ok(!('error' in retire))
  const gone = retire.hunks.flatMap((h) => h.lines.filter((l) => l.kind === 'del').map((l) => l.text.trim()))
  assert.ok(gone.includes('build:'))
  assert.ok(gone.includes('APP_VERSION: v3.3.3-fork.ecca03b'))
  assert.ok(gone.includes('shipshape.fork.upstream: ghcr.io/grimmory-tools/grimmory:v3.3.3'))
  assert.deepEqual(
    retire.hunks.flatMap((h) => h.lines.filter((l) => l.kind === 'add').map((l) => l.text.trim())),
    ['image: ghcr.io/grimmory-tools/grimmory:v3.5.1'],
  )

  // A conflict for this target explains itself instead.
  await recordForkConflict('books', 'grimmory', {
    toTag: 'v3.5.1',
    sha: FORK_SHA,
    commit: 'c'.repeat(40),
    subject: 'fix: x',
    files: ['a.txt'],
    detail: 'ccccccc "fix: x" conflicts with upstream v3.5.1 in a.txt',
  })
  const stuck = buildUpdateDiff(id)
  assert.ok('error' in stuck)
  assert.match(stuck.error, /could not be replayed onto v3\.5\.1: ccccccc "fix: x" conflicts/)
})
