import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * The settings page writes policy.yaml by splicing lines, so a key it cannot place is a
 * save that fails at the last step. `paused` is the first top-level scalar the editor has
 * had to insert, and the file it must land in is one where every other key is nested.
 */

let dir: string
let repo: string
let settings: typeof import('../src/settings/apply.ts')
let config: typeof import('../src/config.ts')

const POLICY = `# shipshape policy -- the single place update semantics are declared.

sync:
  # Kill-switch.
  push_main: true

deploy:
  soak_s: 1800
`

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shipshape-paused-'))
  repo = join(dir, 'repo')
  mkdirSync(join(repo, 'shipshape', 'config'), { recursive: true })
  writeFileSync(join(repo, 'shipshape', 'config', 'policy.yaml'), POLICY)
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@localhost')
  git('config', 'user.name', 'test')
  git('add', '-A')
  git('commit', '-qm', 'policy')

  process.env.DATA_DIR = join(dir, 'data')
  process.env.REPO_DIR = repo
  process.env.GITHUB_REPO = 'you/repo'
  config = await import('../src/config.ts')
  settings = await import('../src/settings/apply.ts')
})

after(() => rmSync(dir, { recursive: true, force: true }))

test('a file that never says paused reads as paused', () => {
  assert.equal(config.loadPolicy().policy.paused, true)
})

test('the switch can be written into a file that has never carried it', async () => {
  const res = await settings.applySettings({ paused: 'false' })
  assert.equal(res.ok, true, res.ok ? '' : res.errors.join('; '))

  const text = readFileSync(join(repo, 'shipshape', 'config', 'policy.yaml'), 'utf8')
  assert.match(text, /^paused: false$/m, 'the key is written at the top level')
  assert.match(text, /# Kill-switch\./, 'the comments around it survive')
  assert.match(text, /^ {2}soak_s: 1800$/m)

  // And it is what the running policy now says, the written value wins.
  assert.equal(config.loadPolicy().policy.paused, false)
})

test('flipping it back rewrites the same line rather than adding another', async () => {
  const res = await settings.applySettings({ paused: 'true' })
  assert.equal(res.ok, true, res.ok ? '' : res.errors.join('; '))

  const text = readFileSync(join(repo, 'shipshape', 'config', 'policy.yaml'), 'utf8')
  assert.equal(text.match(/^paused:/gm)?.length, 1, 'one line, not two')
  assert.match(text, /^paused: true$/m)
  assert.equal(config.loadPolicy().policy.paused, true)
})

test('the save is committed, so a browser edit shows up in git log', () => {
  const log = execFileSync('git', ['-C', repo, 'log', '--oneline'], { encoding: 'utf8' })
  assert.match(log, /settings: paused/)
})
