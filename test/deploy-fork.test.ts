import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Deploying a fork (FORKS.md): its image is a local build, so the deploy builds it first,
 * never asks a registry for it, and a rollback puts the previous build back without
 * building anything.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-deploy-fork-'))
process.env.DATA_DIR = join(dir, 'data')
const repo = join(dir, 'repo')
process.env.REPO_DIR = repo
mkdirSync(join(repo, 'books'), { recursive: true })
writeFileSync(
  join(repo, 'books', 'docker-compose.yaml'),
  `services:
  grimmory:
    build:
      context: https://github.com/justmytwospence/grimmory.git#ecca03b9b1b03f2aa6023ac34f5dc5dadbdbe4dd
    image: grimmory-fork:v3.3.3-ecca03b
    labels:
      shipshape.watch: "true"
      shipshape.fork.upstream: ghcr.io/grimmory-tools/grimmory:v3.3.3@sha256:${'f'.repeat(64)}
  mariadb:
    image: lscr.io/linuxserver/mariadb:11.4.5
  tool:
    build: ./tool
    image: tool:local
`,
)
// A rollback reverts in the live checkout, so the fixture has to be a repository.
const q = { cwd: repo, stdio: 'ignore' as const }
execFileSync('git', ['init', '-q'], q)
execFileSync('git', ['add', '-A'], q)
execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture'], q)
const merge = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()

after(() => rmSync(dir, { recursive: true, force: true }))

const { buildableServices, deploy, deployForPr, failureState, manualCommand, pullArgs } = await import('../src/deploy/run.ts')
const { performRollback } = await import('../src/deploy/rollback.ts')
const { PolicySchema } = await import('../src/config.ts')
const { composeCalls, fakeIo } = await import('./helpers/deploy-io.ts')
type DeployTarget = import('../src/deploy/run.ts').DeployTarget

const policy = PolicySchema.parse({})
const target: DeployTarget = { stack: 'books', services: ['grimmory', 'mariadb'], strategy: 'up' }

test('the compose file says which services are built: the forks, not every build:', () => {
  assert.deepEqual(buildableServices('books', ['grimmory', 'mariadb', 'tool'], policy), ['grimmory'])
  assert.deepEqual(buildableServices('books', ['mariadb'], policy), [])
})

test('the pasted command builds the fork first and never pulls its local image', () => {
  const t = { ...target, build: ['grimmory'] }
  assert.equal(
    manualCommand(t),
    'docker compose -f books/docker-compose.yaml build grimmory\n' +
      'docker compose -f books/docker-compose.yaml up -d --no-deps grimmory mariadb',
  )
  assert.deepEqual(pullArgs({ ...t, pull: true }).args, [
    'compose', '-f', 'books/docker-compose.yaml', 'pull', '--ignore-buildable', 'grimmory', 'mariadb',
  ])
  assert.equal(
    manualCommand({ ...t, pull: true, strategy: 'rm-first' }),
    'docker compose -f books/docker-compose.yaml pull --ignore-buildable grimmory mariadb\n' +
      'docker compose -f books/docker-compose.yaml build grimmory\n' +
      'docker compose -f books/docker-compose.yaml rm -sf grimmory mariadb\n' +
      'docker compose -f books/docker-compose.yaml up -d --no-deps grimmory mariadb',
  )
  // Without a fork nothing changes.
  assert.equal(manualCommand(target), 'docker compose -f books/docker-compose.yaml up -d --no-deps grimmory mariadb')
  assert.ok(!pullArgs({ ...target, pull: true }).args.includes('--ignore-buildable'))
})

test('a merge deploy reads the build set from the file, builds before up, and only the running fork', async () => {
  const io = fakeIo({ grimmory: 'running', mariadb: 'running' }, { buildable: (s, svcs) => buildableServices(s, svcs, policy) })
  const out = await deployForPr(7, target, undefined, { io })
  assert.ok(out.ok)
  assert.deepEqual(composeCalls(io.calls), [
    'compose -f books/docker-compose.yaml build grimmory',
    'compose -f books/docker-compose.yaml up -d --no-deps grimmory mariadb',
  ])

  // A fork that is not running is left stopped and not built either.
  const stopped = fakeIo({ grimmory: 'exited', mariadb: 'running' }, { buildable: () => ['grimmory'] })
  const left = await deployForPr(7, target, undefined, { io: stopped })
  assert.ok(left.ok)
  assert.deepEqual(composeCalls(stopped.calls), ['compose -f books/docker-compose.yaml up -d --no-deps mariadb'])
})

test('a failed build is a deploy failure that touched nothing', async () => {
  let recorded = false
  const io = fakeIo(
    { grimmory: 'running' },
    { exitCode: (c) => (c.includes(' build ') ? 1 : 0) },
  )
  const out = await deploy({ stack: 'books', services: ['grimmory'], strategy: 'rm-first', build: ['grimmory'] }, { io, record: () => { recorded = true } })
  assert.equal(out.ok, false)
  if (out.ok) return
  assert.equal(out.phase, 'build')
  assert.equal(out.reason, 'could not build the image')
  assert.deepEqual(out.up, ['grimmory'])
  assert.deepEqual(composeCalls(io.calls), ['compose -f books/docker-compose.yaml build grimmory'], 'no rm, no up')
  assert.equal(recorded, false, 'nothing was recorded, because nothing was about to change')
  assert.match(failureState(out, 'rm-first'), /build failed before anything was removed/)
})

test('a rollback recreates the previous build without building', async () => {
  const io = fakeIo({ grimmory: 'running' }, { buildable: () => ['grimmory'] })
  const r = await performRollback({ stack: 'books', services: ['grimmory'], strategy: 'up', build: ['grimmory'] }, merge, 'squash', { io })
  assert.ok(r.ok, r.detail)
  assert.deepEqual(composeCalls(io.calls), ['compose -f books/docker-compose.yaml up -d --no-deps grimmory'])
})
