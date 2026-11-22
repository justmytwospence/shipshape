import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkAndApply } from '../src/propose/commit.ts'
import { protectedPaths } from '../src/propose/paths.ts'

/** Where a drafted write really lands, after symbolic links. */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-propose-commit-'))
after(() => rmSync(dir, { recursive: true, force: true }))

function repo(): string {
  const r = mkdtempSync(join(dir, 'repo-'))
  mkdirSync(join(r, 'stack'), { recursive: true })
  mkdirSync(join(r, 'shipshape', 'config'), { recursive: true })
  writeFileSync(join(r, 'stack', 'docker-compose.yaml'), 'services:\n  app:\n    image: x:1\n')
  writeFileSync(join(r, 'shipshape', 'config', 'policy.yaml'), 'paused: true\n')
  return r
}

const req = (repoDir: string, file: string) => ({
  repoDir,
  composeFile: 'stack/docker-compose.yaml',
  service: 'app',
  boundary: { scope: 'repo' as const, composeFile: 'stack/docker-compose.yaml', root: null, types: 'any' as const },
  allowed: ['app'],
  selfStack: 'shipshape',
  never: [],
  ops: [{ op: 'set_path' as const, file, path: ['a'], value: '2' }],
})

test('a symbolic link that leaves the repository is refused', () => {
  const r = repo()
  writeFileSync(join(dir, 'outside.yml'), 'a: 1\n')
  symlinkSync(join(dir, 'outside.yml'), join(r, 'stack', 'link.yml'))
  const out = checkAndApply(req(r, 'stack/link.yml') as never)
  assert.equal(out.ok, false)
  assert.match(out.ok ? '' : out.reason, /leads outside the repository through a symbolic link/)
})

test('a symbolic link into a forbidden directory is refused', () => {
  const r = repo()
  symlinkSync('../shipshape/config/policy.yaml', join(r, 'stack', 'x.yml'))
  const out = checkAndApply(req(r, 'stack/x.yml') as never)
  assert.match(out.ok ? '' : out.reason, /never writable/)
})

test('the policy file and its prompts are never writable', () => {
  assert.deepEqual(protectedPaths('/r', '/r/shipshape.yaml'), ['shipshape.yaml', 'shipshape-prompts'])
  assert.deepEqual(protectedPaths('/r', '/r/shipshape/config/policy.yaml'), [
    'shipshape/config/policy.yaml',
    'shipshape/config/prompts',
  ])
  assert.deepEqual(protectedPaths('/r', '/etc/p.yaml'), [])
})
