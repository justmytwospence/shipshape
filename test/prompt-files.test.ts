import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A prompt override is a file in the watched repository, beside policy.yaml. It used to
 * be a database row edited from a textarea: configuration outside git, unreviewable, and
 * gone with the volume.
 */

const repo = mkdtempSync(join(tmpdir(), 'shipshape-prompts-'))
process.env.REPO_DIR = repo
process.env.SELF_STACK = 'shipshape'
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'shipshape-prompts-data-'))
delete process.env.POLICY_FILE

const { prompt, defaultPrompt, isCustomised, overridePath } = await import('../src/prompts/index.ts')

test('with no override, the shipped prompt is used', () => {
  rmSync(join(repo, 'shipshape'), { recursive: true, force: true })
  assert.equal(prompt('verdict'), defaultPrompt('verdict'))
  assert.equal(isCustomised('verdict'), false)
})

test('an override beside policy.yaml wins, and deleting it is the reset', () => {
  assert.equal(overridePath('verdict'), join(repo, 'shipshape', 'config', 'prompts', 'verdict.md'))
  mkdirSync(join(repo, 'shipshape', 'config', 'prompts'), { recursive: true })
  writeFileSync(overridePath('verdict'), 'Read the changelog carefully.\n')
  assert.equal(prompt('verdict'), 'Read the changelog carefully.')
  assert.equal(isCustomised('verdict'), true)
  rmSync(overridePath('verdict'))
  assert.equal(prompt('verdict'), defaultPrompt('verdict'))
})

test('an empty override file is no override', () => {
  mkdirSync(join(repo, 'shipshape', 'config', 'prompts'), { recursive: true })
  writeFileSync(overridePath('proposal'), '   \n')
  assert.equal(prompt('proposal'), defaultPrompt('proposal'))
})
