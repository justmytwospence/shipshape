import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Any https git host: where the compose repository lives, which credential it gets, and
 * how its changes are linked. This file's environment is a Gitea-style remote.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-git-remote-'))
process.env.DATA_DIR = join(dir, 'data')
process.env.REPO_DIR = dir
process.env.GIT_REMOTE_URL = 'https://git.example.test:3000/me/compose.git'
process.env.GIT_TOKEN = 't'
process.env.GIT_USERNAME = 'u'
process.env.GITHUB_TOKEN = 'gh'
delete process.env.GITHUB_REPO
delete process.env.GIT_BRANCH
after(() => rmSync(dir, { recursive: true, force: true }))

const cfg = await import('../src/env.ts')
const { parseRemote, resolveGitCredentials, credentialProblem, missingSettings, resolveBranch, validBranch, env } = cfg
const { credentialArgs } = await import('../src/gitops/credentials.ts')
const { getDb } = await import('../src/db.ts')
const { changeUrl } = await import('../src/gitops/change.ts')

test('parseRemote: github default from owner/repo', () => {
  assert.deepEqual(parseRemote('', 'me/compose'), {
    url: 'https://github.com/me/compose.git',
    kind: 'https',
    host: 'github.com',
    webUrl: 'https://github.com/me/compose',
  })
})

test('parseRemote: an explicit gitea URL gives host and webUrl, without credentials or .git', () => {
  const r = parseRemote('https://u:p@git.example.test:3000/me/compose.git', '')
  assert.equal(r.host, 'git.example.test')
  assert.equal(r.webUrl, 'https://git.example.test:3000/me/compose')
})

test('parseRemote: ssh is unsupported, paths are local, nothing is none', () => {
  assert.equal(parseRemote('ssh://git@host/x.git', '').kind, 'unsupported')
  assert.equal(parseRemote('git@host:x.git', '').kind, 'unsupported')
  assert.equal(parseRemote('/srv/origin.git', '').kind, 'local')
  assert.equal(parseRemote('file:///srv/origin.git', '').kind, 'local')
  assert.equal(parseRemote('', '').kind, 'none')
})

test('resolveGitCredentials: GITHUB_TOKEN is the default on github.com only', () => {
  const gh = parseRemote('', 'me/c')
  assert.deepEqual(resolveGitCredentials(gh, { GITHUB_TOKEN: 'g' }), { token: 'g', username: 'x-access-token' })
  assert.deepEqual(resolveGitCredentials(gh, { GITHUB_TOKEN: 'g', GIT_TOKEN: 'x' }), { token: 'x', username: 'x-access-token' })
  const other = parseRemote('https://git.example.test/me/c.git', '')
  assert.deepEqual(resolveGitCredentials(other, { GITHUB_TOKEN: 'g' }), { token: '', username: '' })
  assert.deepEqual(resolveGitCredentials(other, { GIT_TOKEN: 'x', GIT_USERNAME: 'me' }), { token: 'x', username: 'me' })
  assert.deepEqual(resolveGitCredentials(parseRemote('/r', ''), { GIT_TOKEN: 'x' }), { token: '', username: '' })
})

test('credentialProblem names the variable to fix', () => {
  const gh = parseRemote('', 'me/c')
  const other = parseRemote('https://git.example.test/me/c.git', '')
  assert.equal(credentialProblem(gh, { token: '', username: 'x' }), 'GITHUB_TOKEN is not set')
  assert.equal(credentialProblem(other, { token: '', username: '' }), 'GIT_TOKEN is not set')
  assert.equal(credentialProblem(other, { token: 'x', username: '' }), 'GIT_USERNAME is not set')
  assert.equal(credentialProblem(other, { token: 'x', username: 'y' }), null)
  assert.equal(credentialProblem(parseRemote('/r', ''), { token: '', username: '' }), null)
})

test('missingSettings says what to set, in words', () => {
  const base = { repoDir: '/r', repoDirExists: true, rawGithubRepo: '', remote: parseRemote('', ''), branch: 'main' }
  assert.equal(missingSettings({ ...base, repoDir: '' })[0]!.name, 'REPO_DIR')
  assert.match(missingSettings({ ...base, repoDirExists: false })[0]!.why, /does not exist inside the container/)
  assert.equal(missingSettings(base)[0]!.name, 'GITHUB_REPO or GIT_REMOTE_URL')
  assert.equal(missingSettings({ ...base, rawGithubRepo: 'nope' })[0]!.why, '"nope" is not owner/repo')
  assert.equal(missingSettings({ ...base, remote: parseRemote('git@h:x', '') })[0]!.name, 'GIT_REMOTE_URL')
  assert.equal(missingSettings({ ...base, remote: parseRemote('', 'me/c'), branch: '-x' })[0]!.name, 'GIT_BRANCH')
  assert.deepEqual(missingSettings({ ...base, remote: parseRemote('', 'me/c') }), [])
})

test('credentialArgs scopes the compose credential to its origin, port included', () => {
  const args = credentialArgs('compose').join(' ')
  assert.match(args, /credential\.https:\/\/git\.example\.test:3000\.helper=/)
  assert.doesNotMatch(args, /github\.com/)
  assert.match(credentialArgs('github').join(' '), /credential\.https:\/\/github\.com\.helper=/)
})

test('this environment: the GIT_TOKEN is the compose credential, and no GitHub repo is claimed', () => {
  assert.equal(env.gitToken, 't')
  assert.equal(env.githubToken, 'gh')
  assert.equal(env.githubRepo, '')
  assert.equal(cfg.canPublish(), true)
  assert.equal(cfg.gitCredentialName(), 'GIT_TOKEN')
})

test('a change links to its merge commit on the remote', () => {
  const sha = 'a'.repeat(40)
  const id = Number(
    getDb()
      .prepare(`INSERT INTO prs (number, branch, head_sha_pushed, state, scope, merge_commit_sha, created_at) VALUES (0, 'b', 'x', 'merged', 'tag-only', ?, 'now')`)
      .run(sha).lastInsertRowid,
  )
  assert.equal(changeUrl(id), `https://git.example.test:3000/me/compose/commit/${sha}`)
})

test('resolveBranch: GIT_BRANCH wins, then origin/HEAD, then main', () => {
  assert.equal(resolveBranch('release', '/nowhere'), 'release')
  assert.equal(resolveBranch(undefined, ''), 'main')
  assert.equal(resolveBranch(undefined, join(dir, 'missing')), 'main')
  const repo = mkdtempSync(join(dir, 'r-'))
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' })
  g('init', '-q', '-b', 'master')
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'chore: fixture')
  g('update-ref', 'refs/remotes/origin/master', 'HEAD')
  g('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master')
  assert.equal(resolveBranch(undefined, repo), 'master')
})

test('validBranch', () => {
  for (const ok of ['main', 'release/1.x']) assert.equal(validBranch(ok), true, ok)
  for (const bad of ['-x', 'a..b', 'a/', 'x.lock', '']) assert.equal(validBranch(bad), false, bad)
})

test('a plain http remote is refused like ssh', () => {
  const remote = parseRemote('http://git.example/me/compose.git', '')
  assert.equal(remote.kind, 'unsupported')
  const missing = missingSettings({ repoDir: '/r', repoDirExists: true, rawGithubRepo: '', remote, branch: 'main' })
  assert.match(missing.find((m: { name: string }) => m.name === 'GIT_REMOTE_URL')?.why ?? '', /plain http/)
  assert.equal(resolveGitCredentials(remote, { GIT_TOKEN: 't' }).token, '')
})
