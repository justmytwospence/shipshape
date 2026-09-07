import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normaliseRevision, hasSkipToken } from '../src/revise/revise.ts'
import { normaliseOps } from '../src/propose/propose.ts'
import type { Policy } from '../src/config.ts'

/**
 * What the model asked for, narrowed to what it is allowed to have.
 *
 * This is the whole containment for the revision path. The boundary in paths.ts decides
 * which files an operation may touch; this decides whether there are any operations at
 * all, and whether an action the model named is one it may take.
 */

const policy = (mode: 'off' | 'reply' | 'act') =>
  ({ revise: { mode, authors: [], scope: 'compose-dir', web: false } }) as unknown as Policy

const input = (instruction = 'drop that env var') => ({ mayEdit: true, instruction })

const OPS = [{ op: 'remove_env', key: 'PAPERLESS_HOST' }]

test('a reply is required; nothing is worse than a silent instruction', () => {
  for (const raw of [{ action: 'answer' }, { action: 'answer', reply: '  ' }, {}]) {
    const r = normaliseRevision(raw, policy('act'), input())
    assert.ok('error' in r, JSON.stringify(raw))
  }
})

test('operations are dropped unless the action is edit', () => {
  for (const action of ['answer', 'hold', 'rerun-review']) {
    const r = normaliseRevision({ reply: 'ok', action, ops: OPS }, policy('act'), input())
    assert.ok(!('error' in r))
    assert.deepEqual(r.ops, [], action)
  }
  const edit = normaliseRevision({ reply: 'done', action: 'edit', ops: OPS }, policy('act'), input())
  assert.ok(!('error' in edit))
  assert.equal(edit.ops.length, 1)
})

test('reply mode answers but never writes, and says which switch to flip', () => {
  const r = normaliseRevision({ reply: 'done', action: 'edit', ops: OPS }, policy('reply'), input())
  assert.ok(!('error' in r))
  assert.equal(r.action, 'answer')
  assert.deepEqual(r.ops, [])
  assert.match(r.degraded ?? '', /revise\.mode/)
})

test('a service that may not be changed is refused even in act mode', () => {
  const r = normaliseRevision(
    { reply: 'done', action: 'edit', ops: OPS },
    policy('act'),
    { mayEdit: false, instruction: 'change it' },
  )
  assert.ok(!('error' in r))
  assert.equal(r.action, 'answer')
  assert.deepEqual(r.ops, [])
})

test('an unrecognised action narrows to answer, never to edit or skip', () => {
  // The same rule as scopeFor and tierFor. Note `merge` and `deploy` in particular:
  // they are not in the enum, and a model naming one gets a reply and nothing else.
  for (const action of ['merge', 'deploy', 'rollback', 'DELETE', '', undefined, 42]) {
    const r = normaliseRevision({ reply: 'ok', action, ops: OPS }, policy('act'), input())
    assert.ok(!('error' in r))
    assert.equal(r.action, 'answer', String(action))
    assert.deepEqual(r.ops, [], String(action))
  }
})

test('a skip needs the literal token, not the model reading a sentence', () => {
  // "don't skip this" and "skip this" differ by one word, and the outcome is a tombstone
  // the scan will not offer again. So prose never decides it.
  const inferred = normaliseRevision(
    { reply: 'skipping', action: 'skip' },
    policy('act'),
    input('I do not think we want this version'),
  )
  assert.ok(!('error' in inferred))
  assert.equal(inferred.action, 'answer')
  assert.match(inferred.degraded ?? '', /\/skip/)

  const asked = normaliseRevision(
    { reply: 'skipping', action: 'skip' },
    policy('act'),
    input('/skip — upstream pulled this release'),
  )
  assert.ok(!('error' in asked))
  assert.equal(asked.action, 'skip')
})

test('the skip token is a token, not a substring', () => {
  assert.equal(hasSkipToken('/skip'), true)
  assert.equal(hasSkipToken('please /skip this one'), true)
  assert.equal(hasSkipToken('/skip\nand say why'), true)
  assert.equal(hasSkipToken('do not skip this'), false)
  assert.equal(hasSkipToken('see https://x.test/skipping'), false)
  assert.equal(hasSkipToken('the /skipped flag'), false)
  // A comment quoting an earlier /skip is discussing it, not issuing it.
  assert.equal(hasSkipToken('> /skip\n\nwhy did you do that?'), false)
})

test('both tools parse operations with the same function', () => {
  // Not a copy. A second parser that was subtly more forgiving would be a second, weaker
  // boundary wearing the same name.
  const raw = [
    { op: 'remove_env', key: 'A' },
    { op: 'set_env', key: 'B' }, // no value -- malformed, dropped
    { op: 'nonsense', key: 'C' }, // unknown -- dropped
    { op: 'replace_text', find: 'x', replace: 'y' },
  ]
  const viaRevision = normaliseRevision({ reply: 'r', action: 'edit', ops: raw }, policy('act'), input())
  assert.ok(!('error' in viaRevision))
  assert.deepEqual(viaRevision.ops, normaliseOps(raw))
  assert.equal(viaRevision.ops.length, 2)
})
