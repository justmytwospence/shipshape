import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { UpdateGroup } from '../src/groups.ts'
import type { PrepareForkInput, PrepareForkResult } from '../src/forks/rebase.ts'

/**
 * A fork's pull request: the branch `buildBranch` writes for one, what its body says, and
 * what it refuses. The replay itself is handed in (src/forks/rebase.ts has its own tests
 * against real repositories), so this is about the compose edit, the commit and the
 * records the pass leaves behind.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-pr-fork-'))
process.env.DATA_DIR = join(dir, 'data')
process.env.GITHUB_REPO = 'me/homelab'
delete process.env.REPO_DIR
delete process.env.NOTIFY_URL
after(() => rmSync(dir, { recursive: true, force: true }))

const { getDb } = await import('../src/db.ts')
const { buildBranch, prTitle, upstreamRefAt } = await import('../src/gitops/pr.ts')
const { prBody, carriedFixesSection } = await import('../src/gitops/body.ts')
const { forkConflictFor, forkPreparedFor } = await import('../src/forks.ts')
const { PolicySchema } = await import('../src/config.ts')

const OLD_SHA = 'ecca03b9b1b03f2aa6023ac34f5dc5dadbdbe4dd'
const NEW_SHA = '9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d'
const OLD_DIGEST = 'sha256:' + 'f'.repeat(64)
const NEW_DIGEST = 'sha256:' + '0123456789abcdef'.repeat(4)
const UPSTREAM = `ghcr.io/grimmory-tools/grimmory:v3.3.3@${OLD_DIGEST}`

const COMPOSE = `services:
  grimmory:
    # FORK (FORKS.md): v3.3.3 plus the Kobo fix (grimmory-tools/grimmory#2952).
    build:
      context: https://github.com/justmytwospence/grimmory.git#${OLD_SHA}
      args:
        APP_VERSION: v3.3.3-fork.ecca03b
        APP_REVISION: ${OLD_SHA}
    image: grimmory-fork:v3.3.3-ecca03b
    labels:
      shipshape.watch: "true"
      shipshape.fork.upstream: ${UPSTREAM}
      shipshape.fork.waits-on: grimmory-tools/grimmory#2952
      shipshape.pattern: v-semver
  mariadb:
    image: lscr.io/linuxserver/mariadb:11.4.5
`

/** A work clone: one commit on main, mirrored as origin/main, which is what buildBranch cuts from. */
function workRepo(): string {
  const repo = mkdtempSync(join(dir, 'work-'))
  mkdirSync(join(repo, 'books'))
  writeFileSync(join(repo, 'books', 'docker-compose.yaml'), COMPOSE)
  const q = { cwd: repo, stdio: 'ignore' as const }
  execFileSync('git', ['init', '-q', '-b', 'main'], q)
  execFileSync('git', ['add', '-A'], q)
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture'], q)
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], q)
  return repo
}

const sh = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

beforeEach(() => {
  getDb().exec(`DELETE FROM images; DELETE FROM fork_refs; DELETE FROM updates; DELETE FROM events; DELETE FROM incidents`)
  getDb()
    .prepare(
      `INSERT INTO images (stack, service, compose_file, image_ref, registry, repository, current_tag, current_digest,
                           watched, fork_upstream, fork_waits_on, last_seen_at)
       VALUES ('books', 'grimmory', 'books/docker-compose.yaml', 'grimmory-fork:v3.3.3-ecca03b', 'ghcr.io',
               'grimmory-tools/grimmory', 'v3.3.3', ?, 1, ?, '["grimmory-tools/grimmory#2952"]', 'now')`,
    )
    .run(OLD_DIGEST, UPSTREAM)
  getDb()
    .prepare(
      `INSERT INTO fork_refs (stack, service, ref, state, fix_sha, released_in, compared_to, detail, checked_at)
       VALUES ('books', 'grimmory', 'grimmory-tools/grimmory#2952', 'merged-unreleased', 'abc', NULL, 'v3.5.1', 'merged', 'now')`,
    )
    .run()
})

const group = (toTag = 'v3.5.1'): UpdateGroup => ({
  key: null,
  branchKey: null,
  members: [
    {
      id: 1,
      stack: 'books',
      service: 'grimmory',
      image: UPSTREAM,
      from_tag: 'v3.3.3',
      to_tag: toTag,
      magnitude: 'minor',
      tier: 'auto',
    },
  ],
})

const carried = [{ sha: 'c'.repeat(40), short: 'ccccccc', subject: 'fix: keep the reading statistics (#2952)', author: 'Spencer' }]

function deps(result: PrepareForkResult, over: Partial<{ digest: string | null; inputs: PrepareForkInput[] }> = {}) {
  const inputs: PrepareForkInput[] = over.inputs ?? []
  return {
    inputs,
    deps: {
      prepareFork: async (input: PrepareForkInput) => {
        inputs.push(input)
        return result
      },
      digestFor: async () => (over.digest === undefined ? NEW_DIGEST : over.digest),
      sourceRepoFor: async () => 'grimmory-tools/grimmory',
    },
  }
}

const bump: PrepareForkResult = {
  kind: 'bump',
  sha: NEW_SHA,
  short: NEW_SHA.slice(0, 7),
  tag: `homelab/v3.5.1-${NEW_SHA.slice(0, 7)}`,
  upstreamTag: 'v3.5.1',
  carried,
  dropped: [],
  alreadyPushed: false,
}

test('a fork group builds its branch through bumpFork, from the replay it was handed', async () => {
  const repo = workRepo()
  const { deps: d, inputs } = deps(bump)
  const r = await buildBranch(repo, group(), 'shipshape/books-grimmory', d)
  assert.ok(r.ok, (r as { reason?: string }).reason)

  // The replay was asked for exactly what the file pins, onto the update's target.
  assert.equal(inputs.length, 1)
  assert.deepEqual(
    { ...inputs[0]!, waitsOn: inputs[0]!.waitsOn },
    {
      forkUrl: 'https://github.com/justmytwospence/grimmory.git',
      upstreamUrl: 'https://github.com/grimmory-tools/grimmory.git',
      pinnedSha: OLD_SHA,
      baseTag: 'v3.3.3',
      targetTag: 'v3.5.1',
      waitsOn: [{ ref: 'grimmory-tools/grimmory#2952', state: 'merged-unreleased', releasedIn: null }],
      shortLength: 7,
    },
  )

  // The branch carries one commit with the fork's four pins moved, and the digest kept.
  assert.equal(sh(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'shipshape/books-grimmory')
  assert.equal(sh(repo, ['rev-parse', 'HEAD']), r.sha)
  assert.equal(sh(repo, ['log', '-1', '--format=%s']), 'chore(deps): books: bump grimmory v3.3.3 -> v3.5.1')
  const svc = parse(readFileSync(join(repo, 'books', 'docker-compose.yaml'), 'utf8')).services.grimmory
  assert.equal(svc.build.context, `https://github.com/justmytwospence/grimmory.git#${NEW_SHA}`)
  assert.equal(svc.build.args.APP_VERSION, 'v3.5.1-fork.9f1c2d3')
  assert.equal(svc.image, 'grimmory-fork:v3.5.1-9f1c2d3')
  assert.equal(svc.labels['shipshape.fork.upstream'], `ghcr.io/grimmory-tools/grimmory:v3.5.1@${NEW_DIGEST}`)

  // What the body and the update page read.
  const info = r.forks.get(1)!
  assert.equal(info.kind, 'bump')
  assert.equal(info.sha, NEW_SHA)
  assert.deepEqual(info.carried, carried)
  const prepared = forkPreparedFor('books', 'grimmory')
  assert.equal(prepared?.kind, 'bump')
  assert.equal(prepared?.toTag, 'v3.5.1')
  assert.equal(prepared?.tag, bump.tag)

  const body = prBody(group(), PolicySchema.parse({}), new Map([[1, 'grimmory-tools/grimmory']]), r.forks)
  assert.match(body, /### Carried fixes/)
  assert.match(body, /\[`9f1c2d3`\]|`homelab\/v3\.5\.1-9f1c2d3`/)
  assert.match(body, /\[`ccccccc`\]\(https:\/\/github\.com\/justmytwospence\/grimmory\/commit\/c{40}\) fix: keep the reading statistics \(#2952\) — Spencer/)
  assert.match(body, /grimmory-tools\/grimmory#2952\]\(https:\/\/github\.com\/grimmory-tools\/grimmory\/issues\/2952\): merged, not released/)
  // The verdict markers still bracket the analysis, so the review splices in as before.
  assert.ok(body.indexOf('### Carried fixes') < body.indexOf('<!-- shipshape:verdict:start -->'))
})

test('a retire group builds its branch through retireFork and says so in the title and body', async () => {
  const repo = workRepo()
  const retire: PrepareForkResult = {
    kind: 'retire',
    upstreamTag: 'v3.5.1',
    dropped: [{ ...carried[0]!, reason: 'upstream v3.5.1 carries the same change' }],
  }
  const r = await buildBranch(repo, group(), 'shipshape/books-grimmory', deps(retire).deps)
  assert.ok(r.ok, (r as { reason?: string }).reason)
  const svc = parse(readFileSync(join(repo, 'books', 'docker-compose.yaml'), 'utf8')).services.grimmory
  assert.equal(svc.build, undefined)
  assert.equal(svc.image, `ghcr.io/grimmory-tools/grimmory:v3.5.1@${NEW_DIGEST}`)
  assert.equal(svc.labels['shipshape.fork.upstream'], undefined)
  assert.equal(svc.labels['shipshape.fork.waits-on'], undefined)
  assert.equal(svc.labels['shipshape.pattern'], 'v-semver')
  assert.equal(
    sh(repo, ['log', '-1', '--format=%s']),
    'chore(deps): books: retire the grimmory fork, back to upstream v3.5.1',
  )
  assert.equal(prTitle(group(), r.forks), 'chore(deps): books: retire the grimmory fork, back to upstream v3.5.1')
  const section = carriedFixesSection(group(), r.forks)
  assert.match(section, /### Retiring the fork/)
  assert.match(section, /Tidy the comment block by hand/)
  assert.match(section, /ccccccc.*upstream v3\.5\.1 carries the same change/)
  assert.equal(forkPreparedFor('books', 'grimmory')?.kind, 'retire')
})

test('a conflict opens nothing: the branch is left at main, the conflict is recorded', async () => {
  const repo = workRepo()
  const conflict: PrepareForkResult = {
    kind: 'conflict',
    commit: carried[0]!,
    files: ['src/kobo.ts'],
    detail: 'ccccccc "fix: keep the reading statistics (#2952)" conflicts with upstream v3.5.1 in src/kobo.ts',
    carried,
    dropped: [],
  }
  const r = await buildBranch(repo, group(), 'shipshape/books-grimmory', deps(conflict).deps)
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.conflict, true)
  assert.match(r.reason, /conflicts with upstream v3\.5\.1 in src\/kobo\.ts/)
  assert.equal(sh(repo, ['rev-parse', 'HEAD']), sh(repo, ['rev-parse', 'origin/main']))
  assert.equal(sh(repo, ['status', '--porcelain']), '')
  const c = forkConflictFor('books', 'grimmory')
  assert.equal(c?.toTag, 'v3.5.1')
  assert.equal(c?.sha, OLD_SHA)
  assert.equal(c?.commit, 'c'.repeat(40))
  assert.deepEqual(c?.files, ['src/kobo.ts'])

  // A replay that later succeeds clears it.
  const ok = await buildBranch(repo, group(), 'shipshape/books-grimmory', deps(bump).deps)
  assert.ok(ok.ok)
  assert.equal(forkConflictFor('books', 'grimmory'), null)
})

test('a digest-pinned upstream keeps its pin, or the edit is refused', async () => {
  // The update's to_tag is bare (a v-semver pattern), so the new digest is looked up.
  const kept = await upstreamRefAt(UPSTREAM, 'v3.5.1', async () => NEW_DIGEST)
  assert.deepEqual(kept, { ok: true, ref: `ghcr.io/grimmory-tools/grimmory:v3.5.1@${NEW_DIGEST}` })
  // A to_tag that already carries one is used as it is.
  const given = await upstreamRefAt(UPSTREAM, `v3.5.1@${NEW_DIGEST}`, async () => null)
  assert.deepEqual(given, { ok: true, ref: `ghcr.io/grimmory-tools/grimmory:v3.5.1@${NEW_DIGEST}` })
  // An upstream with no pin gets none.
  const plain = await upstreamRefAt('ghcr.io/grimmory-tools/grimmory:v3.3.3', 'v3.5.1', async () => NEW_DIGEST)
  assert.deepEqual(plain, { ok: true, ref: 'ghcr.io/grimmory-tools/grimmory:v3.5.1' })
  // No answer from the registry: refused, never written without the pin.
  const lost = await upstreamRefAt(UPSTREAM, 'v3.5.1', async () => null)
  assert.equal(lost.ok, false)
  assert.match((lost as { reason: string }).reason, /digest pin would be lost/)

  const repo = workRepo()
  const { deps: d, inputs } = deps(bump, { digest: null })
  const r = await buildBranch(repo, group(), 'shipshape/books-grimmory', d)
  assert.equal(r.ok, false)
  assert.match((r as { reason: string }).reason, /could not resolve the digest of grimmory-tools\/grimmory:v3\.5\.1; the digest pin would be lost/)
  assert.equal(inputs.length, 0, 'nothing was replayed or pushed for an edit that could not be written')
  assert.equal(readFileSync(join(repo, 'books', 'docker-compose.yaml'), 'utf8'), COMPOSE)
})

test('an overtaken fork pull request is rebuilt from main onto the newer target', async () => {
  const repo = workRepo()
  const first = await buildBranch(repo, group('v3.5.0'), 'shipshape/books-grimmory', deps({ ...bump, tag: 'homelab/v3.5.0-9f1c2d3', upstreamTag: 'v3.5.0' }).deps)
  assert.ok(first.ok)
  const later = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
  const second = await buildBranch(
    repo,
    group('v3.5.1'),
    'shipshape/books-grimmory',
    deps({ ...bump, sha: later, short: later.slice(0, 7), tag: `homelab/v3.5.1-${later.slice(0, 7)}` }).deps,
  )
  assert.ok(second.ok, (second as { reason?: string }).reason)
  // One commit on top of main, not two: the retarget discards the previous target's.
  assert.equal(sh(repo, ['rev-list', '--count', 'origin/main..HEAD']), '1')
  const svc = parse(readFileSync(join(repo, 'books', 'docker-compose.yaml'), 'utf8')).services.grimmory
  assert.equal(svc.image, 'grimmory-fork:v3.5.1-a1b2c3d')
  assert.equal(svc.build.context, `https://github.com/justmytwospence/grimmory.git#${later}`)
  assert.equal(forkPreparedFor('books', 'grimmory')?.toTag, 'v3.5.1')
})

test('a fork the file already carries the bump for is already applied, not broken', async () => {
  const repo = workRepo()
  const once = await buildBranch(repo, group(), 'shipshape/books-grimmory', deps(bump).deps)
  assert.ok(once.ok)
  // Pretend main caught up: the bumped file is now origin/main.
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repo })
  const again = await buildBranch(repo, group(), 'shipshape/books-grimmory', deps(bump).deps)
  assert.equal(again.ok, false)
  assert.equal((again as { alreadyApplied?: boolean }).alreadyApplied, true)
})
