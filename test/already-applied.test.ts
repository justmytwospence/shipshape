import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bumpImage } from '../src/gitops/editor.ts'

/**
 * Telling "already done" apart from "something is wrong".
 *
 * Both arrive as a refusal to edit, and they deserve opposite responses. A file that has
 * moved *past* the update means the work happened -- someone merged it, or a deploy
 * landed while the pass was queued -- and reconsidering it every minute until the next
 * scan is pure noise. Any other mismatch means something unexpected edited the file and
 * a person should look.
 */

function repoWith(imageLine: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'shipshape-edit-'))
  mkdirSync(join(dir, 'demo'))
  writeFileSync(
    join(dir, 'demo', 'docker-compose.yaml'),
    `services:\n  app:\n    image: ${imageLine}\n`,
  )
  // The editor proves its own edit with `git diff`, so the fixture has to be a repo.
  const q = { cwd: dir, stdio: 'ignore' as const }
  execFileSync('git', ['init', '-q'], q)
  execFileSync('git', ['add', '-A'], q)
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture'],
    q,
  )
  return dir
}

test('a file that already carries the bump reports it as applied', async () => {
  const repoDir = repoWith('nginx:2.0')
  const r = await bumpImage({
    repoDir,
    composeFile: 'demo/docker-compose.yaml',
    service: 'app',
    expectedOldRef: 'nginx:1.0',
    newRef: 'nginx:2.0',
  })
  assert.equal(r.ok, false)
  assert.equal((r as { alreadyApplied?: boolean }).alreadyApplied, true)
  assert.match((r as { reason: string }).reason, /already pins/)
})

test('an unexpected version is not treated as applied', async () => {
  // Something else edited this file. That is a person's problem, not a no-op.
  const repoDir = repoWith('nginx:9.9')
  const r = await bumpImage({
    repoDir,
    composeFile: 'demo/docker-compose.yaml',
    service: 'app',
    expectedOldRef: 'nginx:1.0',
    newRef: 'nginx:2.0',
  })
  assert.equal(r.ok, false)
  assert.notEqual((r as { alreadyApplied?: boolean }).alreadyApplied, true)
  assert.match((r as { reason: string }).reason, /expected/)
})

test('the ordinary case still edits', async () => {
  const repoDir = repoWith('nginx:1.0')
  const r = await bumpImage({
    repoDir,
    composeFile: 'demo/docker-compose.yaml',
    service: 'app',
    expectedOldRef: 'nginx:1.0',
    newRef: 'nginx:2.0',
  })
  assert.equal(r.ok, true)
})
