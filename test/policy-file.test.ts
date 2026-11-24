import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/** The policy file: where it is looked for, what it starts as, and who creates it. */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-policy-file-'))
const repo = join(dir, 'repo')
mkdirSync(repo)
process.env.DATA_DIR = join(dir, 'data')
process.env.REPO_DIR = repo
process.env.SELF_STACK = 'shipshape'
process.env.GITHUB_REPO = 'you/repo'
delete process.env.POLICY_FILE
delete process.env.ANTHROPIC_API_KEY
delete process.env.OPENROUTER_API_KEY
after(() => rmSync(dir, { recursive: true, force: true }))

const g = (args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim()
g(['init', '-q', '-b', 'main'])
g(['commit', '-q', '--allow-empty', '-m', 'chore: fixture'])
const ROOT = g(['rev-parse', 'HEAD'])

const { loadPolicy } = await import('../src/config.ts')
const { PolicySchema } = await import('../src/policy-schema.ts')
const { resolvePolicyPath } = await import('../src/env.ts')
const { POLICY_STARTER } = await import('../src/policy-starter.ts')
const { applySettings } = await import('../src/settings/apply.ts')
const { SETTINGS, currentValue } = await import('../src/settings/defs.ts')
const { appendRule } = await import('../src/rules.ts')
const { overridePath } = await import('../src/prompts/index.ts')

const file = join(repo, 'shipshape.yaml')
beforeEach(() => {
  g(['reset', '-q', '--hard', ROOT])
  rmSync(file, { force: true })
})

test('resolvePolicyPath: POLICY_FILE wins, then shipshape.yaml, then the older layout, else shipshape.yaml', () => {
  assert.equal(resolvePolicyPath('/r', 's', '/etc/p.yaml'), '/etc/p.yaml')
  assert.equal(resolvePolicyPath('/r', 's', 'x.yaml'), '/r/x.yaml')
  assert.equal(
    resolvePolicyPath('/r', 's', undefined, () => true),
    '/r/shipshape.yaml',
  )
  assert.equal(
    resolvePolicyPath('/r', 's', undefined, (p) => p === '/r/s/config/policy.yaml'),
    '/r/s/config/policy.yaml',
  )
  assert.equal(
    resolvePolicyPath('/r', 's', undefined, () => false),
    '/r/shipshape.yaml',
  )
})

test('the starter parses, is paused, and matches the Settings defaults', () => {
  const policy = PolicySchema.parse(parseYaml(POLICY_STARTER))
  assert.equal(policy.paused, true)
  for (const def of SETTINGS) {
    if (def.kind === 'model' || def.locked) continue
    assert.equal(currentValue(policy, def.path), def.defaultValue, def.path)
  }
})

test('with no file, loadPolicy reports missing and no error, and defaults hold', () => {
  const r = loadPolicy()
  assert.equal(r.missing, true)
  assert.equal(r.error, undefined)
  assert.equal(r.policy.paused, true)
})

test('the first Settings save creates shipshape.yaml and commits it', async () => {
  const res = await applySettings({ paused: 'false' })
  assert.equal(res.ok, true, res.ok ? '' : res.errors.join())
  const text = readFileSync(file, 'utf8')
  assert.match(text, /^paused: false/m)
  assert.match(text, /# shipshape policy\./)
  assert.equal(g(['log', '-1', '--format=%s']), 'chore(shipshape): settings: paused')
  assert.equal(g(['status', '--porcelain']), '')
})

test('saving nothing creates nothing', async () => {
  const res = await applySettings({})
  assert.equal(res.ok, true)
  assert.equal(existsSync(file), false)
  await applySettings({ paused: 'true' })
  assert.equal(existsSync(file), false, 'a value equal to the starter is no change')
})

test('a failed commit leaves no file behind', async () => {
  mkdirSync(join(repo, '.githooks'), { recursive: true })
  writeFileSync(join(repo, '.githooks', 'pre-commit'), '#!/bin/sh\nexit 1\n')
  execFileSync('chmod', ['+x', join(repo, '.githooks', 'pre-commit')])
  g(['config', 'core.hooksPath', '.githooks'])
  try {
    const res = await applySettings({ paused: 'false' })
    assert.equal(res.ok, false)
    assert.equal(existsSync(file), false)
    assert.equal(g(['diff', '--cached', '--name-only']), '')
  } finally {
    g(['config', '--unset', 'core.hooksPath'])
    rmSync(join(repo, '.githooks'), { recursive: true, force: true })
  }
})

test('the first Always ship creates the file and appends the rule', async () => {
  await appendRule({ id: 'r1', match: { stack: 'a', service: 'b' }, waive: ['ask'], because: 'test' })
  const policy = PolicySchema.parse(parseYaml(readFileSync(file, 'utf8')))
  assert.equal(policy.rules[0]!.id, 'r1')
  assert.match(g(['log', '-1', '--format=%s']), /rule r1/)
})

test('prompt overrides beside a root shipshape.yaml live in shipshape-prompts/', () => {
  assert.equal(overridePath('verdict'), join(repo, 'shipshape-prompts', 'verdict.md'))
})

test('a monthly budget of 0 is refused with a reason', async () => {
  const res = await applySettings({ 'review.monthly_budget_usd': '0' })
  assert.equal(res.ok, false)
  assert.match(res.ok ? '' : res.errors.join(), /at least 0\.01/)
  assert.equal(existsSync(file), false)
})

test('a staged hand-edit and a rebase in progress both refuse a browser save', async () => {
  await applySettings({ paused: 'false' })
  writeFileSync(file, readFileSync(file, 'utf8') + '# staged by hand\n')
  g(['add', '--', 'shipshape.yaml'])
  const staged = await applySettings({ 'sync.poll_idle_s': '300' })
  assert.equal(staged.ok, false)
  assert.match(staged.ok ? '' : staged.errors.join(), /uncommitted changes/)
  g(['reset', '-q', '--hard', 'HEAD'])

  mkdirSync(join(repo, '.git', 'rebase-merge'), { recursive: true })
  try {
    const busy = await applySettings({ 'sync.poll_idle_s': '300' })
    assert.equal(busy.ok, false)
    assert.match(busy.ok ? '' : busy.errors.join(), /rebase is in progress/)
  } finally {
    rmSync(join(repo, '.git', 'rebase-merge'), { recursive: true, force: true })
  }
})
