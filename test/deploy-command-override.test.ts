import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A stack's real compose file, and its override, reach every command a deploy runs or suggests. */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-deploy-override-'))
mkdirSync(join(dir, 'jellyfin'))
writeFileSync(join(dir, 'jellyfin', 'compose.yaml'), 'services:\n  jellyfin:\n    image: x:1\n')
writeFileSync(join(dir, 'jellyfin', 'compose.override.yaml'), 'services:\n  jellyfin:\n    environment:\n      A: 1\n')
writeFileSync(join(dir, 'compose.yaml'), 'services:\n  dns:\n    image: x:1\n')
writeFileSync(join(dir, 'compose.override.yaml'), 'services: {}\n')
process.env.REPO_DIR = dir
after(() => rmSync(dir, { recursive: true, force: true }))

const { composeArgs, pullArgs, buildArgs, manualCommand } = await import('../src/deploy/compose-cmd.ts')
const t = { stack: 'jellyfin', services: ['jellyfin'], strategy: 'up' as const }

test('a stack whose file is compose.yaml deploys with it, and with its override', () => {
  const files = ['-f', 'jellyfin/compose.yaml', '-f', 'jellyfin/compose.override.yaml']
  assert.deepEqual(composeArgs(t, dir).args, ['compose', ...files, 'up', '-d', '--no-deps', 'jellyfin'])
  assert.deepEqual(pullArgs(t, dir).args, ['compose', ...files, 'pull', 'jellyfin'])
  assert.deepEqual(buildArgs({ ...t, build: ['jellyfin'] }, dir)!.args, ['compose', ...files, 'build', 'jellyfin'])
  assert.equal(manualCommand(t), `docker compose ${files.join(' ')} up -d --no-deps jellyfin`)
})

test('the root stack gets no -f even when it has an override', () => {
  assert.deepEqual(composeArgs({ stack: 'root', services: ['dns'], strategy: 'up' }, dir).args, [
    'compose',
    'up',
    '-d',
    '--no-deps',
    'dns',
  ])
})
