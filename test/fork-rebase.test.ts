import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Replaying a fork's fixes onto a new upstream release, against two repositories built
 * here: an upstream with tags, and a bare fork carrying one fix on `homelab`. No network.
 */

const root = mkdtempSync(join(tmpdir(), 'shipshape-fork-rebase-'))
process.env.DATA_DIR = join(root, 'data')
after(() => rmSync(root, { recursive: true, force: true }))

const { prepareFork, forkWorkDir, matchTag, mentions, shippedRefs, upstreamUrlFor } = await import('../src/forks/rebase.ts')

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t']
function sh(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', [...ID, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z', ...env },
  }).trim()
}

interface World {
  upstream: string
  fork: string
  pinned: string
  fixSubject: string
}

/**
 * Upstream: `init` (app.txt, other.txt) tagged v1.0.0. Fork: a clone at v1.0.0 plus one
 * fix appending to app.txt, pushed to a bare repository as `homelab`. The caller then adds
 * whatever upstream release the case needs.
 */
function world(name: string, fixSubject = 'fix: keep the reading statistics (#7)'): World {
  const dir = join(root, name)
  mkdirSync(dir)
  const upstream = join(dir, 'upstream')
  mkdirSync(upstream)
  sh(upstream, ['init', '-q', '-b', 'main'])
  writeFileSync(join(upstream, 'app.txt'), 'line one\nline two\n')
  writeFileSync(join(upstream, 'other.txt'), 'other\n')
  sh(upstream, ['add', '-A'])
  sh(upstream, ['commit', '-qm', 'init'])
  sh(upstream, ['tag', 'v1.0.0'])

  const fork = join(dir, 'fork.git')
  sh(dir, ['init', '-q', '--bare', fork])
  const work = join(dir, 'fork-work')
  sh(dir, ['clone', '-q', upstream, work])
  sh(work, ['checkout', '-q', '-b', 'homelab', 'v1.0.0'])
  writeFileSync(join(work, 'app.txt'), 'line one\nline two\nthe fix\n')
  sh(work, ['commit', '-qam', fixSubject], { GIT_AUTHOR_DATE: '2026-02-02T00:00:00Z', GIT_COMMITTER_DATE: '2026-02-02T00:00:00Z' })
  const pinned = sh(work, ['rev-parse', 'HEAD'])
  sh(work, ['push', '-q', fork, 'homelab'])
  return { upstream, fork, pinned, fixSubject }
}

/** A new upstream release on top of main, editing one file. */
function release(w: World, tag: string, file: string, content: string, subject = `upstream ${tag}`): void {
  writeFileSync(join(w.upstream, file), content)
  sh(w.upstream, ['commit', '-qam', subject], { GIT_AUTHOR_DATE: '2026-03-03T00:00:00Z', GIT_COMMITTER_DATE: '2026-03-03T00:00:00Z' })
  sh(w.upstream, ['tag', tag])
}

const forkRefs = (w: World): string[] => sh(w.fork, ['for-each-ref', '--format=%(refname) %(objectname)']).split('\n').filter(Boolean)

const base = (w: World) => ({
  forkUrl: w.fork,
  upstreamUrl: w.upstream,
  pinnedSha: w.pinned,
  baseTag: 'v1.0.0',
  waitsOn: [],
  workDir: join(root, 'work', 'a'),
})

test('a clean replay pushes a new sha, tagged, and moves homelab with a lease', async () => {
  const w = world('clean')
  release(w, 'v1.1.0', 'other.txt', 'other, changed upstream\n')
  const r = await prepareFork({ ...base(w), targetTag: 'v1.1.0' })
  assert.equal(r.kind, 'bump', JSON.stringify(r))
  if (r.kind !== 'bump') return
  assert.equal(r.upstreamTag, 'v1.1.0')
  assert.equal(r.tag, `homelab/v1.1.0-${r.short}`)
  assert.equal(r.short, r.sha.slice(0, 7))
  assert.deepEqual(r.carried.map((c) => c.subject), [w.fixSubject])
  assert.deepEqual(r.dropped, [])
  assert.equal(r.alreadyPushed, false)

  const refs = forkRefs(w)
  assert.ok(refs.includes(`refs/tags/${r.tag} ${r.sha}`), refs.join('\n'))
  assert.ok(refs.includes(`refs/heads/homelab ${r.sha}`), refs.join('\n'))
  // The replayed commit sits on the new release and still carries the fix.
  const work = join(root, 'work', 'a')
  assert.equal(sh(work, ['rev-parse', `${r.sha}^`]), sh(w.upstream, ['rev-parse', 'v1.1.0^{commit}']))
  assert.equal(sh(work, ['show', `${r.sha}:app.txt`]), 'line one\nline two\nthe fix')
  assert.equal(sh(work, ['show', `${r.sha}:other.txt`]), 'other, changed upstream')

  // Reproducible: the same inputs give the same sha, and nothing new is pushed.
  const again = await prepareFork({ ...base(w), targetTag: 'v1.1.0' })
  assert.equal(again.kind, 'bump')
  if (again.kind !== 'bump') return
  assert.equal(again.sha, r.sha)
  assert.equal(again.alreadyPushed, true)
  assert.deepEqual(forkRefs(w).sort(), refs.sort())
})

test('the image tag spelling need not be the git tag spelling', async () => {
  const w = world('spelling')
  release(w, 'v1.1.0', 'other.txt', 'changed\n')
  const r = await prepareFork({ ...base(w), workDir: join(root, 'work', 'b'), baseTag: '1.0.0', targetTag: '1.1.0' })
  assert.equal(r.kind, 'bump', JSON.stringify(r))
  if (r.kind !== 'bump') return
  assert.equal(r.upstreamTag, 'v1.1.0')
  // The fork's tag follows the image spelling, which is what the compose file writes.
  assert.equal(r.tag, `homelab/1.1.0-${r.short}`)
})

test('a fix upstream already carries means the fork can retire', async () => {
  const w = world('retire')
  // Upstream takes the same change, as the same patch.
  sh(w.upstream, ['fetch', '-q', w.fork, 'homelab'])
  sh(w.upstream, ['cherry-pick', 'FETCH_HEAD'], { GIT_COMMITTER_DATE: '2026-03-03T00:00:00Z' })
  sh(w.upstream, ['tag', 'v1.1.0'])
  const r = await prepareFork({ ...base(w), workDir: join(root, 'work', 'c'), targetTag: 'v1.1.0' })
  assert.equal(r.kind, 'retire', JSON.stringify(r))
  if (r.kind !== 'retire') return
  assert.equal(r.upstreamTag, 'v1.1.0')
  assert.equal(r.dropped.length, 1)
  assert.match(r.dropped[0]!.reason, /carries the same change/)
  // Nothing was pushed to the fork.
  assert.deepEqual(
    forkRefs(w).map((l) => l.split(' ')[0]),
    ['refs/heads/homelab'],
  )
})

test('a waits-on reference released by the target drops the commit that names it', async () => {
  const w = world('waits-on')
  // Upstream fixed it differently (a different patch), so only the reference can say so.
  release(w, 'v1.1.0', 'app.txt', 'line one\nline two\nthe fix, upstream style\n', 'fix reading statistics')
  const r = await prepareFork({
    ...base(w),
    workDir: join(root, 'work', 'd'),
    targetTag: 'v1.1.0',
    waitsOn: [{ ref: 'o/r#7', state: 'released', releasedIn: 'v1.1.0' }],
  })
  assert.equal(r.kind, 'retire', JSON.stringify(r))
  if (r.kind !== 'retire') return
  assert.match(r.dropped[0]!.reason, /o\/r#7 was released in v1\.1\.0/)
})

test('a conflicting upstream change names the commit and the file, and pushes nothing', async () => {
  const w = world('conflict')
  release(w, 'v1.1.0', 'app.txt', 'line one\nline two\nsomething else on that line\n')
  const before = forkRefs(w)
  const r = await prepareFork({ ...base(w), workDir: join(root, 'work', 'e'), targetTag: 'v1.1.0' })
  assert.equal(r.kind, 'conflict', JSON.stringify(r))
  if (r.kind !== 'conflict') return
  assert.equal(r.commit.subject, w.fixSubject)
  assert.deepEqual(r.files, ['app.txt'])
  assert.match(r.detail, new RegExp(`^${r.commit.short} "fix: keep the reading statistics \\(#7\\)" conflicts with upstream v1\\.1\\.0 in app\\.txt$`))
  assert.deepEqual(forkRefs(w), before)
  // The work clone is left clean, so the next attempt starts fresh.
  const work = join(root, 'work', 'e')
  assert.equal(sh(work, ['status', '--porcelain']), '')
})

test('a fork the token cannot push to is a clear refusal, and the upstream tag must exist', async () => {
  const w = world('readonly')
  release(w, 'v1.1.0', 'other.txt', 'changed\n')
  mkdirSync(join(w.fork, 'hooks'), { recursive: true })
  const hook = join(w.fork, 'hooks', 'pre-receive')
  writeFileSync(hook, '#!/bin/sh\necho "Write access to repository not granted." >&2\nexit 1\n')
  chmodSync(hook, 0o755)
  const r = await prepareFork({ ...base(w), workDir: join(root, 'work', 'f'), targetTag: 'v1.1.0' })
  assert.equal(r.kind, 'refused', JSON.stringify(r))
  if (r.kind !== 'refused') return
  assert.equal(r.reason, `cannot push to ${w.fork}: grant the token contents:write on the fork repository`)

  const missing = await prepareFork({ ...base(w), workDir: join(root, 'work', 'f'), targetTag: 'v9.9.9' })
  assert.equal(missing.kind, 'refused')
  assert.match((missing as { reason: string }).reason, /no tag for v9\.9\.9/)

  // A dry run decides and replays, and touches the fork not at all.
  const dry = await prepareFork({ ...base(w), workDir: join(root, 'work', 'f'), targetTag: 'v1.1.0', dryRun: true })
  assert.equal(dry.kind, 'bump')
})

test('the helpers: work dir, upstream URL, tag matching, mentions, shipped refs', () => {
  assert.equal(forkWorkDir('https://github.com/justmytwospence/grimmory.git', '/data'), '/data/forks/justmytwospence-grimmory')
  assert.equal(forkWorkDir('https://github.com/o/r', '/data'), '/data/forks/o-r')
  assert.equal(upstreamUrlFor('grimmory-tools/grimmory', []), 'https://github.com/grimmory-tools/grimmory.git')
  assert.equal(upstreamUrlFor(null, ['o/r#1']), 'https://github.com/o/r.git')
  assert.equal(upstreamUrlFor(null, []), null)

  const tags = [
    { name: 'v1.1.0', sha: 'a' },
    { name: '1.1.0-rc1', sha: 'b' },
    { name: 'v1.2.0', sha: 'c' },
  ]
  assert.equal(matchTag(tags, 'v1.1.0')?.sha, 'a')
  assert.equal(matchTag(tags, '1.1.0')?.sha, 'a')
  assert.equal(matchTag(tags, '1.2.0')?.sha, 'c')
  assert.equal(matchTag(tags, 'v2.0.0'), null)

  assert.ok(mentions({ subject: 'fix: x (#7)', body: '' }, 'o/r#7'))
  assert.ok(mentions({ subject: 'fix: x', body: 'Upstream: o/r#7' }, 'o/r#7'))
  assert.ok(!mentions({ subject: 'fix: x (#70)', body: '' }, 'o/r#7'))
  assert.ok(!mentions({ subject: 'fix: x', body: '' }, 'o/r#7'))

  assert.deepEqual(
    shippedRefs(
      [
        { ref: 'o/r#1', state: 'released', releasedIn: 'v1.1.0' },
        { ref: 'o/r#2', state: 'released', releasedIn: 'v1.3.0' },
        { ref: 'o/r#3', state: 'merged-unreleased', releasedIn: null },
      ],
      'v1.2.0',
    ),
    [{ ref: 'o/r#1', releasedIn: 'v1.1.0' }],
  )
})
