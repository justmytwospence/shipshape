import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Verifier, DEFAULT_VERIFY, type VerifyConfig } from '../src/deploy/verify.ts'
import { parseInspect, projectName, missing } from '../src/deploy/probe.ts'
import { expectedRef } from '../src/deploy/run.ts'
import type { ServiceObservation, ServiceSnapshot } from '../src/deploy/probe.ts'

/**
 * The decision table, driven by scripted observations.
 *
 * The point of keeping `Verifier` pure is exactly this: every rule below is asserted
 * without a docker daemon, so the behaviour that decides whether to roll back a
 * production service is testable rather than merely observed in the wild.
 */

const cfg: VerifyConfig = { ...DEFAULT_VERIFY, windowS: 120 }

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

const snap = (over: Partial<ServiceSnapshot> = {}): ServiceSnapshot[] => [
  {
    service: 'svc',
    imageRef: 'app:1.0',
    imageId: 'sha256:old',
    restartCount: 0,
    hadHealthcheck: false,
    running: true,
    ...over,
  },
]

const v = (snapshot = snap()) => new Verifier(['svc'], snapshot, cfg)

// ---------------------------------------------------------------- the dwell rule

test('a service with no healthcheck does not pass on its first sample', () => {
  // This is the whole bug: `running` one second after compose returned is also what a
  // container about to crash looks like.
  assert.equal(v().push([{ obs: obs() }], 0), null)
})

test('a service with no healthcheck passes once it has stayed up', () => {
  const ver = v()
  assert.equal(ver.push([{ obs: obs() }], 0), null)
  assert.equal(ver.push([{ obs: obs() }], 20_000), null)
  assert.equal(ver.push([{ obs: obs() }], 31_000)?.kind, 'passed')
})

test('the dwell clock restarts if the service stops being up', () => {
  const ver = v()
  ver.push([{ obs: obs() }], 0)
  ver.push([{ obs: obs({ state: 'created' }) }], 10_000)
  assert.equal(ver.push([{ obs: obs() }], 25_000), null, 'not 25s of continuous running')
})

// ------------------------------------------------------------------- healthchecks

test('a healthchecked service needs consecutive good samples', () => {
  const ver = v()
  assert.equal(ver.push([{ obs: obs({ health: 'healthy' }) }], 0), null)
  assert.equal(ver.push([{ obs: obs({ health: 'healthy' }) }], 5000)?.kind, 'passed')
})

test('unhealthy fails at once — docker already applied the retries', () => {
  assert.equal(v().push([{ obs: obs({ health: 'unhealthy' }) }], 5000)?.kind, 'failed')
})

test('starting is neither pass nor fail', () => {
  assert.equal(v().push([{ obs: obs({ health: 'starting' }) }], 5000), null)
})

test('a new image that dropped its healthcheck warns but does not fail', () => {
  const ver = v(snap({ hadHealthcheck: true }))
  ver.push([{ obs: obs() }], 0)
  const out = ver.push([{ obs: obs() }], 31_000)
  assert.equal(out?.kind, 'degraded')
  assert.match(JSON.stringify(out), /healthcheck-gone/)
})

// -------------------------------------------------------------------- crash loops

test('restarts since the deploy are a crash loop', () => {
  const ver = v()
  ver.push([{ obs: obs({ restartCount: 4 }) }], 0)
  assert.equal(ver.push([{ obs: obs({ restartCount: 6 }) }], 5000)?.kind, 'failed')
})

test('a restart count that was already high is not a crash loop', () => {
  // The baseline is the count at deploy time, not zero: a container that has restarted
  // fifty times over six months is not failing now.
  const ver = v()
  ver.push([{ obs: obs({ restartCount: 50 }) }], 0)
  assert.equal(ver.push([{ obs: obs({ restartCount: 50 }) }], 5000), null)
})

test('restarting twice running is a crash loop', () => {
  const ver = v()
  ver.push([{ obs: obs({ state: 'restarting' }) }], 0)
  assert.equal(ver.push([{ obs: obs({ state: 'restarting' }) }], 5000)?.kind, 'failed')
})

test('a container replaced mid-verify fails', () => {
  const ver = v()
  ver.push([{ obs: obs({ id: 'c1' }) }], 0)
  assert.equal(ver.push([{ obs: obs({ id: 'c2' }) }], 5000)?.kind, 'failed')
})

// ------------------------------------------------------------------------ exits

test('a one-shot that finished cleanly is a success', () => {
  // Restart policy distinguishes it, which beats the hard-coded service list kept
  // elsewhere in this repo.
  const out = v().push(
    [{ obs: obs({ state: 'exited', exitCode: 0, restartPolicy: 'no' }) }],
    5000,
  )
  assert.equal(out?.kind, 'passed')
})

test('a service that exited non-zero fails', () => {
  const out = v().push(
    [{ obs: obs({ state: 'exited', exitCode: 1, restartPolicy: 'no' }) }],
    5000,
  )
  assert.equal(out?.kind, 'failed')
})

test('a long-running service that exited zero still fails', () => {
  // unless-stopped means it was meant to keep running; a clean exit is still gone.
  const out = v().push(
    [{ obs: obs({ state: 'exited', exitCode: 0, restartPolicy: 'unless-stopped' }) }],
    5000,
  )
  assert.equal(out?.kind, 'failed')
})

// -------------------------------------------------------------- the image check

test('a deploy that did not change the image fails', () => {
  // The paperless-tika shape: compose reports success, the container was never
  // recreated, and nothing noticed until its next restart broke it.
  const out = v().push([{ obs: obs({ imageRef: 'app:1.0' }), expectedImageRef: 'app:2.0' }], 1000)
  assert.equal(out?.kind, 'failed')
  assert.match(JSON.stringify(out), /image-mismatch/)
})

test('a matching image is not a finding', () => {
  assert.equal(
    v().push([{ obs: obs({ imageRef: 'app:2.0' }), expectedImageRef: 'app:2.0' }], 1000),
    null,
  )
})

/**
 * Where `expectedImageRef` comes from, which is what made the check above fire on every
 * healthy deploy.
 *
 * The verifier was correct; it was being handed the wrong number. `images.image_ref` is
 * written by the scan, which runs once a day, and a deploy lands seconds after a merge --
 * so the row still held the pre-bump tag and every unattended deploy "failed" and rolled
 * back a change that had worked. Invisible until the day auto-merge was switched on.
 */
test('the expected ref comes from the file, not from the daily scan snapshot', () => {
  const file = new Map([['app', 'app:2.0']])
  const db = new Map([['app', 'app:1.0']]) // yesterday's scan
  assert.equal(expectedRef('app', file, db), 'app:2.0')
})

test('the database is a fallback, not a tie-breaker', () => {
  // Only when the file read could not see the service at all.
  assert.equal(expectedRef('app', new Map(), new Map([['app', 'app:1.0']])), 'app:1.0')
  assert.equal(expectedRef('app', new Map(), new Map()), null)
  // A service the file knows about but cannot pin (a `build:` service) is null, not the
  // stale row -- there is genuinely nothing to compare against.
  assert.equal(expectedRef('app', new Map([['app', null]]), new Map([['app', 'app:1.0']])), 'app:1.0')
})

// -------------------------------------------------------------------- the probe

test('a probe that cannot connect never decides anything', () => {
  // Argo's consecutiveErrorLimit distinction: a broken instrument is not a broken
  // service, and rolling back on one would be acting on ignorance.
  const ver = v()
  for (const t of [0, 5000, 10_000, 15_000, 20_000, 25_000]) {
    ver.push([{ obs: obs(), probe: { error: 'ECONNREFUSED' } }], t)
  }
  assert.equal(ver.push([{ obs: obs(), probe: { error: 'ECONNREFUSED' } }], 31_000)?.kind, 'passed')
})

test('sustained 5xx degrades but does not fail', () => {
  const ver = v()
  for (const t of [0, 5000, 10_000]) ver.push([{ obs: obs(), probe: { status: 503 } }], t)
  const out = ver.push([{ obs: obs(), probe: { status: 503 } }], 31_000)
  assert.equal(out?.kind, 'degraded')
})

test('a 302 or 401 is a service that answered', () => {
  const ver = v()
  ver.push([{ obs: obs(), probe: { status: 302 } }], 0)
  assert.equal(ver.push([{ obs: obs(), probe: { status: 401 } }], 31_000)?.kind, 'passed')
})

// ------------------------------------------------------------------ absence, blindness

test('a container missing briefly is tolerated, then is not', () => {
  const ver = v()
  assert.equal(ver.push([{ obs: missing('svc') }], 2000), null, 'compose may still be creating it')
  assert.equal(ver.push([{ obs: missing('svc') }], 15_000)?.kind, 'failed')
})

test('three blind rounds is an error, not a failure', () => {
  // The distinction matters: an error must never trigger a rollback.
  const ver = v()
  assert.equal(ver.push([], 0), null)
  assert.equal(ver.push([], 5000), null)
  assert.equal(ver.push([], 10_000)?.kind, 'error')
})

test('the deadline is a failure, not a default pass', () => {
  const ver = v()
  ver.push([{ obs: obs({ health: 'starting' }) }], 0)
  const out = ver.timeout()
  assert.equal(out.kind, 'failed')
  assert.match(JSON.stringify(out), /timeout/)
})

// ------------------------------------------------------------------------ probe.ts

test('the compose project scopes the lookup, and root is the repo directory', () => {
  assert.equal(projectName('jellyfin'), 'jellyfin')
  assert.equal(projectName('root', '/home/spencer/homelab'), 'homelab')
})

test('inspect output becomes the fields the verifier reads', () => {
  const parsed = parseInspect('app', {
    Id: 'abc',
    State: {
      Status: 'running',
      ExitCode: 0,
      Health: { Status: 'unhealthy', Log: [{ Output: 'connection refused\n' }] },
    },
    Config: { Image: 'nginx:1.2.3' },
    Image: 'sha256:deadbeef',
    RestartCount: 3,
    HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
    NetworkSettings: { Networks: { traefik: { IPAddress: '172.18.0.5' } } },
  })
  assert.equal(parsed.health, 'unhealthy')
  assert.equal(parsed.restartCount, 3)
  assert.equal(parsed.imageRef, 'nginx:1.2.3')
  assert.equal(parsed.ips['traefik'], '172.18.0.5')
  assert.deepEqual(parsed.healthLog, ['connection refused'])
})

test('a container with no healthcheck reports none, never unhealthy', () => {
  // "No signal" is not "bad signal" -- 60% of this lab would roll back on that mistake.
  const parsed = parseInspect('app', { State: { Status: 'running' }, Config: { Image: 'x:1' } })
  assert.equal(parsed.health, 'none')
})
