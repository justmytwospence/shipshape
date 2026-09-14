import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composeArgs, pullArgs, refuseReason, type DeployTarget } from '../src/deploy/run.ts'

const target = (over: Partial<DeployTarget> = {}): DeployTarget => ({
  stack: 'jellyfin',
  services: ['jellyfin'],
  strategy: 'up',
  ...over,
})

const opts = (over: Partial<Parameters<typeof refuseReason>[1]> = {}) => ({
  selfStack: 'shipshape',
  excluded: [] as string[],
  blackout: false,
  ...over,
})

test('shipshape never deploys itself', () => {
  // `docker compose up -d shipshape` replaces the container running the deploy, so the
  // command dies mid-flight and nothing records why.
  const r = refuseReason(target({ stack: 'shipshape' }), opts())
  assert.match(r ?? '', /does not deploy itself/)
})

test('excluded stacks and blackout windows hold a deploy', () => {
  assert.match(refuseReason(target(), opts({ excluded: ['jellyfin'] })) ?? '', /excluded/)
  assert.match(refuseReason(target(), opts({ blackout: true })) ?? '', /blackout/)
  assert.match(refuseReason(target({ services: [] }), opts()) ?? '', /no services/)
})

test('an ordinary stack is allowed', () => {
  assert.equal(refuseReason(target(), opts()), null)
})

test('root-compose services come up from the repository root, without -f', () => {
  // Infra services depend on networks the root file defines; running their own
  // directory's compose fails with "refers to undefined network".
  const { args } = composeArgs(target({ stack: 'root', services: ['traefik', 'pihole'] }))
  assert.deepEqual(args, ['compose', 'up', '-d', '--no-deps', 'traefik', 'pihole'])
  assert.ok(!args.includes('-f'), 'a -f here would scope away the root networks')
})

test('an ordinary stack is addressed by its own compose file', () => {
  const { args } = composeArgs(target())
  assert.deepEqual(args, [
    'compose',
    '-f',
    'jellyfin/docker-compose.yaml',
    'up',
    '-d',
    '--no-deps',
    'jellyfin',
  ])
})

test('a deploy never starts a stopped dependency as a side effect', () => {
  // Without --no-deps, `up -d jellyfin` also starts any depends_on service that is
  // stopped and recreates running ones with unrelated pending edits. What a deploy means
  // is named explicitly; nothing else is reached through the dependency graph.
  const { args } = composeArgs(target())
  assert.equal(args.indexOf('--no-deps'), args.indexOf('-d') + 1)
  // The pull shares the head of the command, not the flag: pullArgs slices at `up`, so a
  // pull is never handed an option that belongs to `up`.
  assert.ok(!pullArgs(target()).args.includes('--no-deps'))
})

test('every service named is passed through to compose', () => {
  // A grouped PR touches several services in one stack; deploying only the first
  // would leave the rest on the old image with the new compose file.
  const { args } = composeArgs(target({ services: ['sonarr', 'radarr', 'prowlarr'] }))
  assert.ok(['sonarr', 'radarr', 'prowlarr'].every((s) => args.includes(s)))
})
