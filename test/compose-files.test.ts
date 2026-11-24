import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeFileOfStack, discoverCompose, overrideFor } from '../src/compose/files.ts'
import { findComposeFiles, includedStacks, scanComposeFile } from '../src/compose/scan.ts'
import { projectName } from '../src/compose/topology.ts'

/** Which file is a stack's compose file, the way Compose decides. */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-compose-files-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const SVC = (name: string) => `services:\n  ${name}:\n    image: example/${name}:1.0.0\n`

function repo(files: Record<string, string>): string {
  const r = mkdtempSync(join(dir, 'r-'))
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(r, p, '..'), { recursive: true })
    writeFileSync(join(r, p), body)
  }
  return r
}

test('all four compose file names are found, one per stack directory', () => {
  const r = repo({
    'a/compose.yaml': SVC('a'),
    'b/compose.yml': SVC('b'),
    'c/docker-compose.yml': SVC('c'),
    'd/docker-compose.yaml': SVC('d'),
  })
  const files = findComposeFiles(r)
  assert.equal(files.length, 4)
  const s = scanComposeFile(r, join(r, 'a/compose.yaml'))
  assert.equal(s[0]!.composeFile, 'a/compose.yaml')
  assert.equal(s[0]!.stack, 'a')
})

test('a root compose.yml is the root stack', () => {
  const r = repo({ 'compose.yml': SVC('x') })
  assert.equal(scanComposeFile(r, findComposeFiles(r)[0]!)[0]!.stack, 'root')
})

test("when a directory has several, Compose's first wins and the rest are reported", () => {
  const r = repo({ 'a/compose.yaml': SVC('a'), 'a/docker-compose.yml': SVC('a'), 'b/docker-compose.yml': SVC('b'), 'b/docker-compose.yaml': SVC('b') })
  const d = discoverCompose(r)
  assert.deepEqual(d.shadowed, [
    { dir: 'a', kept: 'compose.yaml', ignored: ['docker-compose.yml'] },
    { dir: 'b', kept: 'docker-compose.yml', ignored: ['docker-compose.yaml'] },
  ])
})

test('overrideFor follows Compose: the first of the four override names, whatever the base is called', () => {
  const r = repo({ 'a/compose.yaml': SVC('a'), 'a/docker-compose.override.yaml': 'x', 'b/compose.yaml': SVC('b'), 'b/compose.override.yml': 'x', 'b/compose.override.yaml': 'x' })
  assert.equal(overrideFor(r, 'a/compose.yaml'), 'a/docker-compose.override.yaml')
  assert.equal(overrideFor(r, 'b/compose.yaml'), 'b/compose.override.yml')
  assert.equal(overrideFor(r, 'c/compose.yaml'), null)
  assert.equal(overrideFor('', 'a/compose.yaml'), null)
})

test('composeFileOfStack falls back to docker-compose.yaml when nothing is on disk or there is no checkout', () => {
  const r = repo({ 'a/compose.yaml': SVC('a') })
  assert.equal(composeFileOfStack(r, 'a'), 'a/compose.yaml')
  assert.equal(composeFileOfStack(r, 'gone'), 'gone/docker-compose.yaml')
  assert.equal(composeFileOfStack('', 'a'), 'a/docker-compose.yaml')
})

test('includedStacks reads a root compose.yaml and an include written ./stack/compose.yaml', () => {
  const r = repo({ 'compose.yaml': 'include:\n  - ./traefik/compose.yaml\n', 'traefik/compose.yaml': SVC('traefik') })
  assert.deepEqual([...includedStacks(r)], ['traefik'])
})

test('projectName reads a declared name from a compose.yml', () => {
  const r = repo({ 'media/compose.yml': `name: jellyfin\n${SVC('app')}` })
  assert.equal(projectName('media', r), 'jellyfin')
})

test('override and skip directories are not stacks', () => {
  const r = repo({ 'a/compose.override.yaml': 'x', '.git/compose.yaml': SVC('x'), 'node_modules/compose.yaml': SVC('x') })
  assert.deepEqual(findComposeFiles(r), [])
})
