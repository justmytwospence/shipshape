import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * setServiceLabel against a real scratch repository: what a clean edit commits, and --
 * the half that matters more -- what the refusal paths leave untouched. Every test
 * asserts on the file bytes and the git log, because "refused" is only true if nothing
 * moved.
 */

const data = mkdtempSync(join(tmpdir(), 'shipshape-labels-data-'))
const repo = mkdtempSync(join(tmpdir(), 'shipshape-labels-repo-'))
process.env.DATA_DIR = data
process.env.REPO_DIR = repo
// Unset, so the post-commit publish step has no origin to reach for: these tests must
// never open a network connection.
delete process.env.GITHUB_REPO
delete process.env.GITHUB_TOKEN

const { getDb } = await import('../src/db.ts')
const { setServiceLabel } = await import('../src/gitops/labels.ts')

after(() => {
  rmSync(data, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

const COMPOSE = `services:
  jellyfin:
    # the media server
    image: jellyfin/jellyfin:10.9.11
    labels:
      shipshape.watch: "true"
      shipshape.pr: on-request
`

const FILE = join(repo, 'media', 'docker-compose.yaml')

const g = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()

const hasDocker = (() => {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

function resetRepo(files: Record<string, string> = { 'media/docker-compose.yaml': COMPOSE }): void {
  rmSync(repo, { recursive: true, force: true })
  mkdirSync(repo, { recursive: true })
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(repo, rel, '..'), { recursive: true })
    writeFileSync(join(repo, rel), text)
  }
  g(['init', '-q'])
  // Normalise the branch name whatever this git's init.defaultBranch says: the
  // orchestrator refuses anything that is not `main`.
  g(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  g(['add', '-A'])
  g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture'])
}

function seedImage(composeFile = 'media/docker-compose.yaml'): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO images (stack, service, compose_file, image_ref, registry,
             repository, current_tag, watched, last_seen_at)
       VALUES ('media', 'jellyfin', ?, 'jellyfin/jellyfin:10.9.11', 'docker.io',
               'jellyfin/jellyfin', '10.9.11', 1, ?)`,
    )
    .run(composeFile, new Date().toISOString())
}

beforeEach(() => {
  const db = getDb()
  db.prepare(`DELETE FROM images`).run()
  db.prepare(`DELETE FROM events`).run()
  resetRepo()
  seedImage()
})

test('a clean file is edited, committed, and shipshape.pr goes with the policy', async () => {
  const r = await setServiceLabel({ stack: 'media', service: 'jellyfin', key: 'policy', value: 'manual' })
  assert.equal(r.ok, true, r.message)
  assert.ok(r.sha)

  const text = readFileSync(FILE, 'utf8')
  assert.ok(text.includes('      shipshape.policy: manual\n'))
  assert.ok(!text.includes('shipshape.pr'), 'the pr label would have kept the service held')
  assert.ok(text.includes('# the media server'), 'comments survive')
  assert.match(r.message, /shipshape\.pr/)

  assert.equal(g(['log', '-1', '--pretty=%s']), 'chore(shipshape): media/jellyfin: shipshape.policy=manual')
  assert.equal(g(['log', '-1', '--pretty=%an']), 'shipshape')
  assert.equal(g(['status', '--porcelain']), '', 'the working tree is clean after the commit')
})

test('a dirty target file is refused with nothing written', async () => {
  const dirtied = COMPOSE + '# a hand edit in flight\n'
  writeFileSync(FILE, dirtied)

  const r = await setServiceLabel({ stack: 'media', service: 'jellyfin', key: 'policy', value: 'manual' })
  assert.equal(r.ok, false)
  assert.match(r.message, /uncommitted changes/)
  assert.equal(readFileSync(FILE, 'utf8'), dirtied, 'the hand edit is untouched')
  assert.equal(g(['rev-list', '--count', 'HEAD']), '1', 'nothing was committed')
})

test('a staged-but-uncommitted edit counts as dirty too', async () => {
  writeFileSync(FILE, COMPOSE + '# staged\n')
  g(['add', '--', 'media/docker-compose.yaml'])

  const r = await setServiceLabel({ stack: 'media', service: 'jellyfin', key: 'watch', value: 'false' })
  assert.equal(r.ok, false)
  assert.match(r.message, /uncommitted changes/)
  assert.equal(g(['rev-list', '--count', 'HEAD']), '1')
})

test('a gate failure restores the original bytes', async () => {
  // A pre-commit hook that always refuses stands in for any late failure: the edit is
  // written and gated, the commit fails, and the file must come back byte-identical
  // with a clean tree -- not sit half-done waiting to be folded into someone's work.
  mkdirSync(join(repo, '.githooks'))
  writeFileSync(join(repo, '.githooks', 'pre-commit'), '#!/bin/sh\nexit 1\n')
  chmodSync(join(repo, '.githooks', 'pre-commit'), 0o755)
  g(['config', 'core.hooksPath', '.githooks'])

  const r = await setServiceLabel({ stack: 'media', service: 'jellyfin', key: 'policy', value: 'auto' })
  assert.equal(r.ok, false)
  assert.match(r.message, /commit/i)
  assert.equal(readFileSync(FILE, 'utf8'), COMPOSE, 'the original bytes are back')
  // Scoped to the target: the hook fixture itself is untracked by design.
  assert.equal(
    g(['status', '--porcelain', '--', 'media/docker-compose.yaml']),
    '',
    'nothing is left staged or modified',
  )
  assert.equal(g(['rev-list', '--count', 'HEAD']), '1')
})

test('a compose-config gate failure restores the original bytes', { skip: !hasDocker }, async () => {
  // The invalid attribute predates the edit, so setLabel succeeds and the failure is
  // compose's alone -- exactly the case the gate exists for.
  const bad = COMPOSE.replace('    image:', '    bogus_key: nope\n    image:')
  resetRepo({ 'media/docker-compose.yaml': bad })
  seedImage()

  const r = await setServiceLabel({ stack: 'media', service: 'jellyfin', key: 'policy', value: 'manual' })
  assert.equal(r.ok, false)
  assert.match(r.message, /[Cc]ompose rejected/)
  assert.equal(readFileSync(FILE, 'utf8'), bad, 'the original bytes are back')
  assert.equal(g(['status', '--porcelain']), '')
  assert.equal(g(['rev-list', '--count', 'HEAD']), '1')
})

test('the images row decides which compose file is edited', async () => {
  resetRepo({
    'media/docker-compose.yaml': COMPOSE,
    'alt/docker-compose.yaml': COMPOSE,
  })
  seedImage('alt/docker-compose.yaml')

  const r = await setServiceLabel({ stack: 'media', service: 'jellyfin', key: 'watch', value: 'false' })
  assert.equal(r.ok, true, r.message)
  assert.ok(readFileSync(join(repo, 'alt', 'docker-compose.yaml'), 'utf8').includes('"false"'))
  assert.equal(readFileSync(FILE, 'utf8'), COMPOSE, 'the other file is untouched')
})

test('off main, nothing happens', async () => {
  g(['checkout', '-qb', 'feature'])
  const r = await setServiceLabel({ stack: 'media', service: 'jellyfin', key: 'policy', value: 'skip' })
  assert.equal(r.ok, false)
  assert.match(r.message, /not main/)
  assert.equal(readFileSync(FILE, 'utf8'), COMPOSE)
})

test('an unknown policy value is refused before anything is read', async () => {
  const r = await setServiceLabel({ stack: 'media', service: 'jellyfin', key: 'policy', value: 'manaul' })
  assert.equal(r.ok, false)
  assert.match(r.message, /not a policy/)
  assert.equal(g(['rev-list', '--count', 'HEAD']), '1')
})

test('a service the scan has never recorded is refused', async () => {
  const r = await setServiceLabel({ stack: 'media', service: 'ghost', key: 'policy', value: 'manual' })
  assert.equal(r.ok, false)
  assert.match(r.message, /[Nn]o compose file is known/)
})

test('writing the value the file already has commits nothing', async () => {
  const r = await setServiceLabel({ stack: 'media', service: 'jellyfin', key: 'watch', value: 'true' })
  assert.equal(r.ok, true)
  assert.equal(r.sha, undefined)
  assert.match(r.message, /nothing to commit/)
  assert.equal(g(['rev-list', '--count', 'HEAD']), '1')
})
