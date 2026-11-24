import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupSteps, type SetupInput } from '../src/web/onboarding.ts'

/** The getting-started checklist: what a new install still needs, in order. */

const base: SetupInput = {
  missing: [],
  repoDir: '/srv/compose',
  composeFiles: null,
  services: 0,
  stacks: 0,
  watched: 0,
  lastScanAt: null,
  schedule: 'Every day at 03:00',
  reviewOff: null,
  reader: 'claude-sonnet-5-5',
  paused: true,
  wouldShip: 0,
}
const step = (s: ReturnType<typeof setupSteps>, key: string) => s.steps.find((x) => x.key === key)!

test('a fresh install is three required steps, none done', () => {
  const s = setupSteps(base)
  assert.equal(s.complete, false)
  assert.equal(s.done, 0)
  assert.equal(s.required, 3)
  assert.match(step(s, 'repo').body, /^The first scan reads/)
  assert.match(step(s, 'scan').body, /Scans run every day at 03:00/)
})

test('missing settings are named', () => {
  const s = setupSteps({
    ...base,
    missing: [
      { name: 'REPO_DIR', why: '' },
      { name: 'GITHUB_REPO or GIT_REMOTE_URL', why: '' },
    ],
  })
  assert.equal(
    step(s, 'repo').body,
    'Set REPO_DIR; GITHUB_REPO or GIT_REMOTE_URL on the shipshape container and restart it.',
  )
  assert.deepEqual(step(s, 'repo').action, {
    kind: 'link',
    href: 'https://justmytwospence.github.io/shipshape/start/quick-start/',
    label: 'Setup guide',
  })
})

test('no compose files says where it looked', () => {
  assert.match(
    step(setupSteps({ ...base, composeFiles: 0 }), 'repo').body,
    /No compose files were found in \/srv\/compose\./,
  )
})

test('nothing watched points at the Not watched filter', () => {
  const a = step(setupSteps({ ...base, services: 4, stacks: 2 }), 'watch').action
  assert.deepEqual(a, { kind: 'link', href: '/services?filter=unwatched', label: 'Choose services' })
})

test('review and pause never keep the checklist open', () => {
  const s = setupSteps({
    ...base,
    services: 4,
    stacks: 2,
    watched: 1,
    lastScanAt: new Date().toISOString(),
    reviewOff: 'no model provider is set',
    paused: true,
  })
  assert.equal(s.complete, true)
  assert.equal(s.done, 3)
})

test('pause counts what is waiting only on it', () => {
  assert.match(step(setupSteps({ ...base, wouldShip: 1 }), 'pause').body, /1 update is waiting only on Pause\.$/)
  assert.match(step(setupSteps({ ...base, wouldShip: 2 }), 'pause').body, /2 updates are waiting only on Pause\.$/)
})
