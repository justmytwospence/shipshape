import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * "Always ship" turns one answer into a standing rule written to policy.yaml. The model
 * picks the scope when it can, and a narrow deterministic default stands in when it cannot
 * -- which is every test here, since no key is set.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-rules-'))
const repo = join(dir, 'repo')
process.env.DATA_DIR = join(dir, 'data')
process.env.REPO_DIR = repo
process.env.POLICY_FILE = 'policy.yaml'
delete process.env.ANTHROPIC_API_KEY
delete process.env.OPENROUTER_API_KEY
delete process.env.GITHUB_REPO
after(() => rmSync(dir, { recursive: true, force: true }))

const { getDb } = await import('../src/db.ts')
const { appendRule, describeRule, fallbackRule, inferRule, nextRuleId, validateDraft } = await import('../src/rules.ts')
const { PolicySchema } = await import('../src/config.ts')
const { ruleMatches } = await import('../src/policy.ts')

const g = (args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim()
const POLICY = `# policy\npaused: false  # the switch\n\nship:\n  cooldown_days: 7\n`
const file = join(repo, 'policy.yaml')

beforeEach(() => {
  rmSync(repo, { recursive: true, force: true })
  mkdirSync(repo, { recursive: true })
  writeFileSync(file, POLICY)
  g(['init', '-q', '-b', 'main'])
  g(['add', '-A'])
  g(['commit', '-qm', 'fixture'])
  const db = getDb()
  db.exec(`DELETE FROM updates; DELETE FROM images; DELETE FROM events`)
})

const rule = (id = 'r1') => ({
  id,
  match: { image: 'ghcr.io/agentgateway/agentgateway' },
  waive: ['ask' as const],
  because: '2026-11-11, agentgateway v1.7.0 card: always ship',
})

test('a rule is appended to policy.yaml as a commit, and the file still parses', () => {
  const { sha } = appendRule(rule())
  const text = readFileSync(file, 'utf8')
  assert.match(text, /# policy/, 'comments survive')
  assert.match(text, /# the switch/)
  assert.match(text, /rules:/)
  const parsed = PolicySchema.parse(JSON.parse(JSON.stringify(require_yaml(text))))
  assert.deepEqual(parsed.rules, [rule()])
  assert.match(g(['log', '-1', '--format=%s']), /^chore\(shipshape\): rule r1: always ship every service running ghcr\.io\/agentgateway\/agentgateway, waiving ask$/)
  assert.equal(g(['log', '-1', '--format=%h']), sha)
  assert.equal(g(['status', '--porcelain']), '')
})

import { parse } from 'yaml'
const require_yaml = (t: string) => parse(t)

test('a second rule is added beside the first', () => {
  appendRule(rule('r1'))
  appendRule({ ...rule('r2'), match: { stack: 'books', service: 'shelfmark' }, waive: ['no-evidence', 'ask'] })
  const parsed = PolicySchema.parse(parse(readFileSync(file, 'utf8')))
  assert.deepEqual(parsed.rules.map((r) => r.id), ['r1', 'r2'])
  assert.equal(nextRuleId(parsed.rules), 'r3')
})

test('a file with uncommitted edits is refused with nothing written', () => {
  writeFileSync(file, POLICY + '# a hand edit in flight\n')
  assert.throws(() => appendRule(rule()), /uncommitted changes/)
  assert.equal(readFileSync(file, 'utf8'), POLICY + '# a hand edit in flight\n')
  assert.equal(g(['rev-list', '--count', 'HEAD']), '1')
})

test('a failed commit puts the bytes back', () => {
  mkdirSync(join(repo, '.githooks'))
  writeFileSync(join(repo, '.githooks', 'pre-commit'), '#!/bin/sh\nexit 1\n')
  execFileSync('chmod', ['+x', join(repo, '.githooks', 'pre-commit')])
  g(['config', 'core.hooksPath', '.githooks'])
  assert.throws(() => appendRule(rule()), /could not commit the rule/)
  assert.equal(readFileSync(file, 'utf8'), POLICY)
})

test('nextRuleId counts from the highest id, not the length', () => {
  assert.equal(nextRuleId([]), 'r1')
  assert.equal(nextRuleId([{ id: 'r4' }, { id: 'r2' }]), 'r5')
})

test('describeRule says the scope and what it waives, in words', () => {
  assert.equal(describeRule(rule()), 'every service running ghcr.io/agentgateway/agentgateway, waiving ask')
  assert.equal(describeRule({ match: { stack: 'books', service: 'shelfmark' }, waive: ['no-evidence'] }), 'books/shelfmark, waiving no-evidence')
  assert.equal(describeRule({ match: { base_build: true }, waive: ['ask'] }), 'our own builds, waiving ask')
})

// ------------------------------------------------------------------ the fallback scope

const member = (stack: string, service: string, image = 'ghcr.io/agentgateway/agentgateway:v1.6.0', baseBuild = false) => ({ image, stack, service, baseBuild })

test('the fallback is the shared image when several services run it', () => {
  const r = fallbackRule([member('a', 'a-auth'), member('b', 'b-auth')], ['ask'], 'v1.7.0', '2026-11-11')
  assert.deepEqual(r.match, { image: 'ghcr.io/agentgateway/agentgateway' })
  assert.deepEqual(r.waive, ['ask'])
  assert.equal(r.because, '2026-11-11, agentgateway v1.7.0 card: always ship')
})

test('the fallback is one service when it stands alone, and notes our own builds', () => {
  assert.deepEqual(fallbackRule([member('books', 'shelfmark')], ['ask'], 'x').match, { stack: 'books', service: 'shelfmark' })
  assert.deepEqual(fallbackRule([member('obs', 'sync', 'node:22-slim', true)], ['ask'], 'x').match, { stack: 'obs', service: 'sync', base_build: true })
})

test('every fallback covers every service it was asked about', () => {
  for (const ms of [[member('a', 'a-auth')], [member('a', 'a-auth'), member('b', 'b-auth'), member('c', 'c-auth')]]) {
    const r = fallbackRule(ms, ['ask'], 'x')
    for (const m of ms) assert.equal(ruleMatches({ id: 'r1', ...r }, m), true, `${m.stack}/${m.service}`)
  }
})

// ------------------------------------------------------------------ the model's answer

const ctx = { info: [member('a', 'a-auth'), member('b', 'b-auth')], waivable: ['ask', 'no-evidence'] as ('ask' | 'no-evidence')[] }

test('a model answer is used only if it is well-formed, waives only what the card had, and covers every service', () => {
  const good = { match: { image: 'ghcr.io/agentgateway/agentgateway' }, waive: ['ask'], because: 'x' }
  assert.deepEqual(validateDraft(good, ctx), good)
  assert.equal(validateDraft({ ...good, waive: ['irreversible'] }, ctx), null, 'a hold the card did not have')
  assert.equal(validateDraft({ ...good, waive: ['lifeline'] }, ctx), null, 'not waivable at all')
  assert.equal(validateDraft({ ...good, match: {} }, ctx), null, 'matches nothing')
  assert.equal(validateDraft({ ...good, match: { stack: 'a', service: 'a-auth' } }, ctx), null, 'would leave b asking')
  assert.equal(validateDraft('nonsense', ctx), null)
})

// ------------------------------------------------------------------ inferRule end to end

function seed(stack: string, service: string, tier: string, image = 'ghcr.io/agentgateway/agentgateway:v1.6.0') {
  const db = getDb()
  db.prepare(
    `INSERT INTO images (stack, service, compose_file, image_ref, registry, repository, watched, last_seen_at)
     VALUES (?, ?, 'x', ?, 'ghcr.io', 'agentgateway/agentgateway', 1, 'now')`,
  ).run(stack, service, image)
  return Number(
    db
      .prepare(
        `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state, detected_at, updated_at)
         VALUES (?, ?, ?, 'v1.6.0', 'v1.7.0', 'minor', ?, 'detected', 'now', 'now')`,
      )
      .run(stack, service, image, tier).lastInsertRowid,
  )
}

test('inferRule without a model gives the shared image for one decision across stacks', async () => {
  const a = seed('a-mcp', 'a-mcp-auth', 'ask')
  seed('b-mcp', 'b-mcp-auth', 'ask')
  const r = await inferRule(a, '2026-11-11')
  assert.deepEqual(r, { id: 'r1', match: { image: 'ghcr.io/agentgateway/agentgateway' }, waive: ['ask'], because: '2026-11-11, agentgateway v1.7.0 card: always ship' })
})

test('inferRule refuses what no rule may waive', async () => {
  const id = seed('traefik', 'traefik', 'lifeline')
  await assert.rejects(inferRule(id), /cannot be waived/)
})

test('inferRule refuses when nothing is holding the update', async () => {
  const id = seed('web', 'web', 'normal')
  await assert.rejects(inferRule(id), /nothing is holding/)
})
