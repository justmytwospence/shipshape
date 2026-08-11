import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { includedStacks } from '../src/compose/scan.ts'
import { isRootStack, composeArgs } from '../src/deploy/run.ts'
import { projectName } from '../src/deploy/probe.ts'

/**
 * Stacks the root compose project pulls in with `include:`.
 *
 * Their services are part of the ROOT project, not one named after the stack, and their
 * networks are defined in the root file. Two things break if that is not known, and both
 * break completely rather than subtly: scoping to the stack's own file fails with
 * "refers to undefined network", and looking for the containers under a project named
 * after the stack finds nothing — so a perfectly healthy service verifies as absent.
 *
 * This lab includes four such stacks, and they are the four whose failure would cut the
 * path to fixing them: traefik, pihole, ddclient, wireguard.
 */

function repo(rootYaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'shipshape-incl-'))
  writeFileSync(join(dir, 'docker-compose.yaml'), rootYaml)
  mkdirSync(join(dir, 'pihole'))
  return dir
}

const WITH_INCLUDES = `include:
  - path: traefik/docker-compose.yaml
  - path: pihole/docker-compose.yaml
services:
  something:
    image: x:1
`

test('included paths are read off the root compose file', () => {
  assert.deepEqual([...includedStacks(repo(WITH_INCLUDES))].sort(), ['pihole', 'traefik'])
})

test('a repo with no includes has none', () => {
  assert.equal(includedStacks(repo('services:\n  a:\n    image: x:1\n')).size, 0)
})

test('an unreadable or unparseable root file is not fatal', () => {
  // Better to treat every stack as ordinary than to throw inside a deploy.
  assert.equal(includedStacks('/nonexistent-path-here').size, 0)
  assert.equal(includedStacks(repo('this: [is: not: valid: yaml')).size, 0)
})

test('an included stack is addressed from the repository root', () => {
  const dir = repo(WITH_INCLUDES)
  assert.equal(isRootStack('pihole', dir), true)
  assert.equal(isRootStack('root', dir), true)
  assert.equal(isRootStack('jellyfin', dir), false)
})

test('an included stack gets no -f, because that invocation fails outright', () => {
  const dir = repo(WITH_INCLUDES)
  const args = composeArgs({ stack: 'pihole', services: ['pihole'], strategy: 'up' }, dir)
  assert.ok(!args.args.includes('-f'), 'scoping to its own file loses the root networks')
  assert.deepEqual(args.args, ['compose', 'up', '-d', 'pihole'])
})

test('an ordinary stack still gets its own file', () => {
  const dir = repo(WITH_INCLUDES)
  const args = composeArgs({ stack: 'jellyfin', services: ['jellyfin'], strategy: 'up' }, dir)
  assert.ok(args.args.includes('-f'))
})

test('an included stack verifies under the root project name', () => {
  // Its containers carry com.docker.compose.project=<repo dir>, so looking under
  // "pihole" would report a running service as absent and fail the deploy.
  const dir = repo(WITH_INCLUDES)
  assert.equal(projectName('pihole', dir), projectName('root', dir))
  assert.notEqual(projectName('jellyfin', dir), projectName('root', dir))
})
