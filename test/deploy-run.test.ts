import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'shipshape-deploy-run-'))
process.env.DATA_DIR = dir
delete process.env.REPO_DIR

const { deploy, nextStep } = await import('../src/deploy/run.ts')
const { composeCalls, fakeIo } = await import('./helpers/deploy-io.ts')
type RecordedPlan = import('../src/deploy/runstate.ts').RecordedPlan
type DeployTarget = import('../src/deploy/run.ts').DeployTarget

after(() => rmSync(dir, { recursive: true, force: true }))

/**
 * What a deploy runs on the host, against a docker that writes down what it was asked.
 *
 * The rule is that an update never changes whether a service is running, and the evidence
 * for a rule like that is an absence: no compose command for a stopped service, nothing
 * run before the plan is recorded, nothing at all when docker could not be asked.
 */

const bitwarden: DeployTarget = { stack: 'bitwarden', services: ['bitwarden'], strategy: 'up' }
const pinnedBitwarden = () => new Map([['bitwarden', 'vaultwarden/server:1.37.3']])

test('nothing running means no compose at all', async () => {
  const io = fakeIo(
    { bitwarden: { state: 'exited', imageRef: 'vaultwarden/server:1.37.2' } },
    { pinned: pinnedBitwarden },
  )
  const out = await deploy(bitwarden, { io })
  assert.ok(out.ok)
  assert.equal(out.healthy, false)
  assert.deepEqual(out.up, [])
  assert.deepEqual(composeCalls(io.calls), [], 'no create, pull, start or rm')
  assert.ok(!io.calls.some((c) => c.startsWith('verify')), 'nothing came up, so nothing is verified')
  assert.equal(
    out.detail,
    'bitwarden left stopped (exited) — compose brings it up on 1.37.3; docker start would resume 1.37.2',
  )
})

test('no container, or a paused one, is left the same way', async () => {
  const absent = await deploy(bitwarden, { io: fakeIo({ bitwarden: 'absent' }, { pinned: pinnedBitwarden }) })
  assert.ok(absent.ok)
  assert.equal(absent.detail, 'bitwarden left stopped (no container) — compose brings it up on 1.37.3')

  const io = fakeIo({ bitwarden: { state: 'paused', imageRef: 'vaultwarden/server:1.37.2' } }, { pinned: pinnedBitwarden })
  const paused = await deploy(bitwarden, { io })
  assert.ok(paused.ok)
  assert.equal(paused.detail, 'bitwarden left paused — compose brings it up on 1.37.3; unpausing resumes 1.37.2')
  assert.deepEqual(composeCalls(io.calls), [])
})

test('a docker that cannot be asked touches nothing and fails loudly', async () => {
  const io = fakeIo({ bitwarden: 'unreadable' })
  let recorded = false
  const out = await deploy(bitwarden, { io, record: () => (recorded = true) })
  assert.equal(out.ok, false)
  assert.ok(!out.ok)
  assert.equal(out.phase, 'inspect')
  assert.match(out.reason, /could not ask docker whether bitwarden is running: permission denied/)
  assert.deepEqual(composeCalls(io.calls), [])
  assert.equal(recorded, false, 'a guess is not a plan')
  assert.equal(out.plan, undefined)
})

const immich: DeployTarget = {
  stack: 'immich',
  services: ['immich-server', 'immich-machine-learning'],
  strategy: 'rm-first',
}
const immichStates = { 'immich-server': 'running', 'immich-machine-learning': 'exited' }

test('only the running half is removed, brought up and verified', async () => {
  const io = fakeIo(immichStates)
  const out = await deploy(immich, { io })
  assert.deepEqual(composeCalls(io.calls), [
    'compose -f immich/docker-compose.yaml rm -sf immich-server',
    'compose -f immich/docker-compose.yaml up -d --no-deps immich-server',
  ])
  assert.equal(io.calls.at(-1), 'verify immich-server')
  assert.ok(out.ok)
  assert.equal(out.healthy, true)
  assert.deepEqual(out.up, ['immich-server'])
  assert.deepEqual(out.left.map((l) => l.service), ['immich-machine-learning'])
  assert.match(out.detail, /^immich-server up in \d+s; immich-machine-learning left stopped \(exited\)/)
})

test('the plan is written down before anything is touched', async () => {
  const io = fakeIo(immichStates)
  let plan: RecordedPlan | undefined
  const out = await deploy(immich, {
    io,
    record: (p) => {
      io.calls.push('record')
      plan = p
    },
  })
  const recordedAt = io.calls.indexOf('record')
  const firstCompose = io.calls.findIndex((c) => c.startsWith('compose'))
  assert.ok(recordedAt !== -1 && recordedAt < firstCompose, io.calls.join('\n'))
  assert.deepEqual(plan!.up, ['immich-server'])
  assert.equal(plan!.v, 1)
  assert.deepEqual(
    plan!.seen.map((s) => [s.service, s.state]),
    [
      ['immich-server', 'running'],
      ['immich-machine-learning', 'exited'],
    ],
  )
  assert.ok(out.ok)
  assert.deepEqual(out.plan, plan)
})

test('a plan that brings nothing up is still written down', async () => {
  let plan: RecordedPlan | undefined
  await deploy(bitwarden, { io: fakeIo({ bitwarden: 'exited' }), record: (p) => (plan = p) })
  assert.deepEqual(plan?.up, [])
  assert.deepEqual(plan?.left.map((l) => l.service), ['bitwarden'])
})

test('the verifier is shown only what came up', async () => {
  let shown: string[] = []
  const io = fakeIo(immichStates, {
    verify: async (target, _project, snapshot) => {
      shown = [...target.services, ...snapshot.map((s) => `snapshot ${s.service}`)]
      return { kind: 'passed', detail: 'settled' }
    },
  })
  await deploy(immich, { io })
  assert.deepEqual(shown, ['immich-server', 'snapshot immich-server'])
})

test('a compose failure after the plan carries the plan', async () => {
  const io = fakeIo(immichStates, { exitCode: (c) => (c.includes(' up ') ? 1 : 0) })
  const out = await deploy(immich, { io })
  assert.ok(!out.ok)
  assert.equal(out.phase, 'up')
  assert.deepEqual(out.plan?.up, ['immich-server'])
})

test('a plain up that fails reads what compose left behind', async () => {
  // Compose recreates before it starts, so a start-time failure has already destroyed the
  // old container: on the real host the only container left was `created`.
  const io = fakeIo({ bitwarden: ['running', 'created'] }, { exitCode: (c) => (c.includes(' up ') ? 1 : 0) })
  const out = await deploy(bitwarden, { io })
  assert.ok(!out.ok)
  assert.equal(out.phase, 'up')
  assert.deepEqual(out.after, [{ service: 'bitwarden', state: 'created' }])
  assert.equal(io.calls.filter((c) => c === 'observe bitwarden').length, 2, 'once to plan, once after the failure')

  const blind = await deploy(bitwarden, {
    io: fakeIo({ bitwarden: ['running', 'unreadable'] }, { exitCode: (c) => (c.includes(' up ') ? 1 : 0) }),
  })
  assert.ok(!blind.ok)
  assert.deepEqual(blind.after, [{ service: 'bitwarden', state: 'unknown' }], 'a read that fails is not a guess')
})

test('refusals still come before docker is asked', async () => {
  const io = fakeIo({ shipshape: 'running' })
  const out = await deploy({ stack: 'shipshape', services: ['shipshape'], strategy: 'up' }, { io })
  assert.ok(!out.ok)
  assert.equal(out.phase, 'refused')
  assert.deepEqual(io.calls, [])
})

test('a container from another project stops the deploy', async () => {
  const io = fakeIo({ bitwarden: 'absent' }, { foreign: async () => 'compose project "bw-old" (bitwarden)' })
  const out = await deploy(bitwarden, { io })
  assert.ok(!out.ok)
  assert.equal(out.phase, 'inspect')
  assert.equal(
    out.reason,
    'bitwarden has a container from compose project "bw-old" (bitwarden), so shipshape cannot tell whether it is this service',
  )
  assert.deepEqual(composeCalls(io.calls), [])

  // Docker answered, so waiting for it to answer is the wrong thing to tell anyone.
  assert.equal(out.cause, 'orphan')
  assert.equal(out.container, 'bitwarden')
  const next = nextStep(out, bitwarden)
  assert.doesNotMatch(next, /once docker answers/)
  assert.equal(
    next,
    'Remove that container (docker rm -f bitwarden) or bring it up from its own compose project, then press Try again on the update.',
  )
})

test('only a service with no container is checked for an orphan', async () => {
  const io = fakeIo(immichStates)
  await deploy(immich, { io })
  assert.ok(!io.calls.some((c) => c.startsWith('foreign')), 'a found container is its own answer')

  const absent = fakeIo({ bitwarden: 'absent' })
  await deploy(bitwarden, { io: absent })
  assert.ok(absent.calls.includes('foreign bitwarden'))
})

const actual: DeployTarget = { stack: 'actual', services: ['actual', 'actual-sync'], strategy: 'up', pull: true }

test('a rolling redeploy pulls only what it will bring up, then looks again', async () => {
  const io = fakeIo({ actual: 'running', 'actual-sync': ['exited', 'running'] })
  const out = await deploy(actual, { io })
  assert.deepEqual(composeCalls(io.calls), [
    'compose -f actual/docker-compose.yaml pull actual',
    'compose -f actual/docker-compose.yaml pull actual-sync',
    'compose -f actual/docker-compose.yaml up -d --no-deps actual actual-sync',
  ])
  assert.ok(out.ok)
  assert.deepEqual(out.up, ['actual', 'actual-sync'])
})

test('a service stopped during the pull is not brought up', async () => {
  const io = fakeIo({ actual: ['running', 'exited'] })
  const out = await deploy({ ...actual, services: ['actual'] }, { io })
  assert.deepEqual(composeCalls(io.calls), ['compose -f actual/docker-compose.yaml pull actual'])
  assert.ok(out.ok)
  assert.deepEqual(out.up, [])
})

test('a stopped rolling service is not even pulled', async () => {
  const io = fakeIo({ actual: 'exited' })
  await deploy({ ...actual, services: ['actual'] }, { io })
  assert.deepEqual(composeCalls(io.calls), [])
})

const minuspod: DeployTarget = { stack: 'minuspod', services: ['minuspod'], strategy: 'rm-first' }

test('a carried absent service comes back up', async () => {
  const io = fakeIo({ minuspod: 'absent' })
  const out = await deploy(minuspod, { io, carried: new Set(['minuspod']) })
  // rm-first still runs its rm, which finds nothing to remove; the up creates it.
  assert.deepEqual(composeCalls(io.calls), [
    'compose -f minuspod/docker-compose.yaml rm -sf minuspod',
    'compose -f minuspod/docker-compose.yaml up -d --no-deps minuspod',
  ])
  assert.ok(out.ok)
  assert.deepEqual(out.restored, ['minuspod'])
  assert.match(out.detail, /^minuspod up in \d+s; minuspod brought back up — shipshape's last attempt left it down$/)
})

test('a carried service someone has since stopped stays stopped', async () => {
  const io = fakeIo({ minuspod: { state: 'exited', restartPolicy: 'unless-stopped' } })
  const out = await deploy(minuspod, { io, carried: new Set(['minuspod']) })
  assert.deepEqual(composeCalls(io.calls), [])
  assert.ok(out.ok)
  assert.equal(out.detail, "minuspod left stopped (exited) — it was stopped after shipshape's last attempt on it")
})

const delugePeers = () => [
  { service: 'deluge-gluetun', network_mode: null },
  { service: 'deluge', network_mode: 'service:deluge-gluetun' },
]

test('a follower of a stopped owner is left as it was', async () => {
  const io = fakeIo({ deluge: 'running', 'deluge-gluetun': 'exited' }, { peers: delugePeers })
  const out = await deploy({ stack: 'deluge', services: ['deluge'], strategy: 'up' }, { io })
  assert.ok(io.calls.includes('observe deluge-gluetun'), 'the owner is read even outside the target')
  assert.deepEqual(composeCalls(io.calls), [])
  assert.ok(out.ok)
  assert.equal(out.left[0]!.why, 'owner-down')
  assert.equal(
    out.detail,
    "deluge left as it was — it lives in deluge-gluetun's network, and deluge-gluetun is not running",
  )
})

test('a follower left stopped while its owner is recreated says how to bring it back', async () => {
  const io = fakeIo({ 'deluge-gluetun': 'running', deluge: 'exited' }, { peers: delugePeers })
  const out = await deploy({ stack: 'deluge', services: ['deluge-gluetun', 'deluge'], strategy: 'up' }, { io })
  assert.deepEqual(composeCalls(io.calls), ['compose -f deluge/docker-compose.yaml up -d --no-deps deluge-gluetun'])
  assert.ok(out.ok)
  assert.match(
    out.detail,
    /^deluge-gluetun up in \d+s; deluge left stopped \(exited\) — deluge-gluetun was recreated, so bring deluge up with compose; docker start would fail$/,
  )
})
