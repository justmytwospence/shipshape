import { test } from 'node:test'
import assert from 'node:assert/strict'
import { missing, type ServiceObservation } from '../src/deploy/probe.ts'
import {
  countsAsRunning,
  leftClause,
  observeSet,
  ownerFrom,
  planRun,
  readRecordedPlan,
  recheckServices,
  restoredClause,
  versionOf,
  visiblyStopped,
  type LeftService,
  type RecordedPlan,
} from '../src/deploy/runstate.ts'

/**
 * Whether a deploy may start anything, decided from what docker said and nothing else.
 *
 * The rule is one sentence -- an update never changes whether a service is running -- and
 * everything below is the table that sentence becomes once docker's states, shipshape's
 * own failed attempts and shared network namespaces are all in the room.
 */

const obs = (over: Partial<ServiceObservation> = {}): ServiceObservation => ({
  service: 'svc',
  found: true,
  id: 'c1',
  state: 'running',
  exitCode: null,
  restartCount: 0,
  restartPolicy: 'unless-stopped',
  health: 'none',
  healthLog: [],
  imageRef: 'app:2.0',
  imageId: 'sha256:new',
  startedAt: null,
  ips: {},
  ...over,
})

/** An observation for `service` in `state`; `absent` is docker listing no container. */
const as = (service: string, state: string, over: Partial<ServiceObservation> = {}): ServiceObservation =>
  state === 'absent' ? missing(service) : obs({ service, state, ...over })

const seen = (...list: ServiceObservation[]) => new Map(list.map((o) => [o.service, o]))
const noOwners = () => null
const nothingCarried = new Set<string>()

const plan = (services: string[], observed: ServiceObservation[], carried: ReadonlySet<string> = nothingCarried, ownerOf: (s: string) => string | null = noOwners) =>
  planRun({ services, seen: seen(...observed), ownerOf, carried })

// ---------------------------------------------------------------- docker's states

test('each docker state decides once', () => {
  for (const state of ['running', 'restarting']) {
    const p = plan(['svc'], [as('svc', state)])
    assert.deepEqual(p.up, ['svc'], state)
    assert.deepEqual(p.left, [], state)
    assert.ok(countsAsRunning(state))
  }
  for (const state of ['paused', 'created', 'exited', 'dead', 'removing', 'absent']) {
    const p = plan(['svc'], [as('svc', state)])
    assert.deepEqual(p.up, [], `${state} is not brought up`)
    assert.equal(p.left.length, 1, state)
    assert.equal(p.left[0]!.why, 'not-running', state)
    assert.equal(p.left[0]!.state, state)
    assert.ok(!countsAsRunning(state))
  }
})

test('a service nobody observed reads as having no container', () => {
  const p = planRun({ services: ['svc'], seen: new Map(), ownerOf: noOwners, carried: nothingCarried })
  assert.equal(p.left[0]!.state, 'absent')
})

test('a left service keeps what its old container was', () => {
  const p = plan(['bitwarden'], [as('bitwarden', 'exited', { imageRef: 'vaultwarden/server:1.37.2', restartPolicy: 'always' })])
  assert.deepEqual(p.left, [
    { service: 'bitwarden', state: 'exited', why: 'not-running', restartPolicy: 'always', oldRef: 'vaultwarden/server:1.37.2' },
  ])
})

// ---------------------------------------------------------------- carry

test("a service shipshape's last attempt took down comes back up", () => {
  const carried = new Set(['svc'])
  const back: [string, Partial<ServiceObservation>][] = [
    ['absent', {}],
    ['created', {}],
    ['exited', { restartPolicy: 'no' }],
    ['exited', { restartPolicy: '' }],
    ['exited', { restartPolicy: 'on-failure' }],
    ['dead', {}],
  ]
  for (const [state, over] of back) {
    const p = plan(['svc'], [as('svc', state, over)], carried)
    assert.deepEqual(p.up, ['svc'], `${state} ${over.restartPolicy ?? ''}`)
    assert.deepEqual(p.restored, ['svc'])
  }

  // Stopped in a way only a person produces: under always and unless-stopped a crash reads
  // restarting, so exited there was somebody's decision, made after shipshape's attempt.
  const stopped: [string, Partial<ServiceObservation>][] = [
    ['exited', { restartPolicy: 'unless-stopped' }],
    ['exited', { restartPolicy: 'always' }],
    ['paused', {}],
    ['removing', {}],
  ]
  for (const [state, over] of stopped) {
    const o = as('svc', state, over)
    assert.ok(visiblyStopped(o), state)
    const p = plan(['svc'], [o], carried)
    assert.deepEqual(p.up, [], `${state} ${over.restartPolicy ?? ''}`)
    assert.deepEqual(p.restored, [])
    assert.equal(p.left[0]!.why, 'stopped-since')
  }
})

test('a carried service that is running is simply up, not restored', () => {
  const p = plan(['svc'], [as('svc', 'running')], new Set(['svc']))
  assert.deepEqual(p.up, ['svc'])
  assert.deepEqual(p.restored, [])
})

// ---------------------------------------------------------------- namespaces

const deluge = ownerFrom([
  { service: 'deluge-gluetun', network_mode: null },
  { service: 'deluge', network_mode: 'service:deluge-gluetun' },
])

test('owner and follower both running come up together', () => {
  const p = plan(['deluge-gluetun', 'deluge'], [as('deluge-gluetun', 'running'), as('deluge', 'running')], nothingCarried, deluge)
  assert.deepEqual(p.up, ['deluge-gluetun', 'deluge'])
  assert.deepEqual(p.left, [])
})

test('a follower whose owner is recreated is flagged stranded', () => {
  const p = plan(['deluge-gluetun', 'deluge'], [as('deluge-gluetun', 'running'), as('deluge', 'exited')], nothingCarried, deluge)
  assert.deepEqual(p.up, ['deluge-gluetun'])
  assert.equal(p.left.length, 1)
  assert.equal(p.left[0]!.service, 'deluge')
  assert.equal(p.left[0]!.stranded, true)
  assert.equal(p.left[0]!.owner, 'deluge-gluetun')
})

test('a follower of a stopped owner is left as it was', () => {
  // `up --no-deps deluge` with its owner stopped destroys deluge and leaves it in created.
  const p = plan(['deluge-gluetun', 'deluge'], [as('deluge-gluetun', 'exited'), as('deluge', 'running')], nothingCarried, deluge)
  assert.deepEqual(p.up, [])
  assert.deepEqual(
    p.left.map((l) => [l.service, l.why]),
    [
      ['deluge-gluetun', 'not-running'],
      ['deluge', 'owner-down'],
    ],
  )
  assert.equal(p.left[1]!.owner, 'deluge-gluetun')
})

test('a follower-only deploy checks the owner outside the target', () => {
  const up = plan(['deluge'], [as('deluge', 'running'), as('deluge-gluetun', 'running')], nothingCarried, deluge)
  assert.deepEqual(up.up, ['deluge'])

  const down = plan(['deluge'], [as('deluge', 'running'), as('deluge-gluetun', 'exited')], nothingCarried, deluge)
  assert.deepEqual(down.up, [])
  assert.equal(down.left[0]!.why, 'owner-down')

  // Never observed is no container, which is not running either.
  const unseen = plan(['deluge'], [as('deluge', 'running')], nothingCarried, deluge)
  assert.equal(unseen.left[0]!.why, 'owner-down')
})

test('a carried follower of a stopped owner is not restored', () => {
  const p = plan(['deluge-gluetun', 'deluge'], [as('deluge-gluetun', 'exited'), as('deluge', 'absent')], new Set(['deluge']), deluge)
  assert.deepEqual(p.up, [])
  assert.deepEqual(p.restored, [])
  assert.equal(p.left[1]!.why, 'owner-down')
})

test('an absent follower is not stranded', () => {
  // No container means no pinned id to lose: compose creates it next time, and there is
  // nothing for docker start to fail on.
  const p = plan(['deluge-gluetun', 'deluge'], [as('deluge-gluetun', 'running'), as('deluge', 'absent')], nothingCarried, deluge)
  assert.deepEqual(p.up, ['deluge-gluetun'])
  assert.equal(p.left[0]!.stranded, undefined)
  assert.equal(p.left[0]!.owner, undefined)
})

test('order follows the target, once each', () => {
  const p = plan(['b', 'a', 'b'], [as('a', 'running'), as('b', 'running')])
  assert.deepEqual(p.up, ['b', 'a'])
})

test('observeSet adds owners after the target', () => {
  assert.deepEqual(observeSet(['deluge', 'x', 'deluge'], deluge), ['deluge', 'x', 'deluge-gluetun'])
  assert.deepEqual(observeSet(['deluge-gluetun', 'deluge'], deluge), ['deluge-gluetun', 'deluge'])
})

// ---------------------------------------------------------------- what it says

const left = (over: Partial<LeftService> = {}): LeftService => ({
  service: 'bitwarden',
  state: 'exited',
  why: 'not-running',
  restartPolicy: 'unless-stopped',
  oldRef: 'vaultwarden/server:1.37.2',
  ...over,
})
const pinned = 'vaultwarden/server:1.37.3'

test('leftClause says what compose and docker start would do', () => {
  assert.equal(
    leftClause(left(), pinned),
    'bitwarden left stopped (exited) — compose brings it up on 1.37.3; docker start would resume 1.37.2',
  )
  assert.equal(
    leftClause(left({ state: 'created' }), pinned),
    'bitwarden left stopped (created, never started) — compose brings it up on 1.37.3; docker start would resume 1.37.2',
  )
  assert.equal(
    leftClause(left({ oldRef: pinned }), pinned),
    'bitwarden left stopped (exited) — compose brings it up on 1.37.3',
    'nothing to warn about when the old container is already on it',
  )
  assert.equal(
    leftClause(left({ oldRef: null }), pinned),
    'bitwarden left stopped (exited) — compose brings it up on 1.37.3',
  )
  assert.ok(
    leftClause(left({ restartPolicy: 'always' }), pinned).endsWith(
      '; docker restarts it on 1.37.2 when the daemon restarts',
    ),
  )
  assert.equal(
    leftClause(left({ state: 'paused' }), pinned),
    'bitwarden left paused — compose brings it up on 1.37.3; unpausing resumes 1.37.2',
  )
  assert.equal(
    leftClause(left({ state: 'absent', oldRef: null, restartPolicy: '' }), pinned),
    'bitwarden left stopped (no container) — compose brings it up on 1.37.3',
  )
  assert.equal(
    leftClause(left({ state: 'removing' }), pinned),
    'bitwarden left stopped (no container) — compose brings it up on 1.37.3',
  )
  assert.equal(
    leftClause(left(), null),
    'bitwarden left stopped (exited) — compose brings it up on the version in the compose file',
  )
})

test('the namespace and carry clauses read as the operator examples do', () => {
  assert.equal(
    leftClause(left({ service: 'deluge', why: 'owner-down', owner: 'deluge-gluetun' }), null),
    "deluge left as it was — it lives in deluge-gluetun's network, and deluge-gluetun is not running",
  )
  assert.equal(
    leftClause(left({ service: 'deluge', owner: 'deluge-gluetun', stranded: true }), null),
    'deluge left stopped (exited) — deluge-gluetun was recreated, so bring deluge up with compose; docker start would fail',
  )
  assert.equal(
    leftClause(left({ service: 'minuspod', why: 'stopped-since' }), null),
    "minuspod left stopped (exited) — it was stopped after shipshape's last attempt on it",
  )
  assert.equal(
    leftClause(left({ service: 'minuspod', why: 'stopped-since', state: 'paused' }), null),
    "minuspod left paused — it was paused after shipshape's last attempt on it",
  )
  assert.equal(restoredClause('minuspod'), "minuspod brought back up — shipshape's last attempt left it down")
})

test('an owner stopped under a running follower reads as one sentence per service', () => {
  const p = plan(
    ['deluge-gluetun', 'deluge'],
    [
      as('deluge-gluetun', 'exited', { imageRef: 'qmcgaw/gluetun:v3.41.1' }),
      as('deluge', 'running', { imageRef: 'lscr.io/linuxserver/deluge:2.2.0-r1-ls1' }),
    ],
    nothingCarried,
    deluge,
  )
  const refs = new Map([['deluge-gluetun', 'qmcgaw/gluetun:v3.41.3']])
  assert.equal(
    p.left.map((l) => leftClause(l, refs.get(l.service) ?? null)).join('; '),
    "deluge-gluetun left stopped (exited) — compose brings it up on v3.41.3; docker start would resume v3.41.1; deluge left as it was — it lives in deluge-gluetun's network, and deluge-gluetun is not running",
  )
})

test('versionOf reads the tag, or a short digest pin', () => {
  assert.equal(versionOf('vaultwarden/server:1.37.3'), '1.37.3')
  assert.equal(
    versionOf('actual/actual:latest@sha256:cb4826a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d'),
    'latest@cb4826a1b2c3',
  )
  assert.equal(versionOf(null), null)
})

// ---------------------------------------------------------------- the record

const recorded: RecordedPlan = {
  v: 1,
  at: '2026-09-14T09:02:00.000Z',
  seen: [
    {
      service: 'n8n',
      imageRef: 'n8nio/n8n:2.38.5',
      imageId: 'sha256:old',
      restartCount: 0,
      hadHealthcheck: true,
      running: true,
      state: 'running',
      restartPolicy: 'unless-stopped',
    },
  ],
  up: ['n8n'],
  left: [left({ service: 'n8n-import', restartPolicy: 'no', oldRef: 'n8nio/n8n:2.38.5' })],
  restored: [],
}

test('readRecordedPlan tolerates what is not a plan', () => {
  assert.equal(readRecordedPlan(null), null)
  assert.equal(readRecordedPlan('not json'), null)
  assert.equal(readRecordedPlan(JSON.stringify({ ...recorded, v: 2 })), null)
  assert.equal(readRecordedPlan(JSON.stringify({ ...recorded, up: 'n8n' })), null)
  assert.equal(readRecordedPlan('[]'), null)
  assert.deepEqual(readRecordedPlan(JSON.stringify(recorded)), recorded)
})

test('recheckServices soaks what came up, or every service on an old row', () => {
  assert.deepEqual(recheckServices('n8n-import n8n', null), ['n8n-import', 'n8n'])
  assert.deepEqual(recheckServices('n8n-import n8n', JSON.stringify(recorded)), ['n8n'])
  assert.deepEqual(recheckServices('jellyfin', 'garbage'), ['jellyfin'])
})
