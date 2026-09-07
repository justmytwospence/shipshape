import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reviseScope, SCOPES, boundaryFor, canWrite } from '../src/propose/paths.ts'
import { PolicySchema } from '../src/config.ts'

/**
 * How far a comment-driven edit reaches, and why it is not "the wider of the two".
 */

test('no label at all takes the policy floor', () => {
  for (const label of [null, undefined, '', '   ']) {
    assert.equal(reviseScope(label, 'compose-dir'), 'compose-dir', JSON.stringify(label))
  }
})

test('an explicit label wins outright, in both directions', () => {
  // Widening is the easy half.
  assert.equal(reviseScope('repo', 'compose-dir'), 'repo')
  // Narrowing is the half a "wider of the two" rule would get wrong: scopeFor folds
  // *absent* and an explicit `service` into the same answer, so such a rule would
  // silently promote a pin somebody wrote on purpose up to the policy default.
  assert.equal(reviseScope('service', 'compose-dir'), 'service')
  assert.equal(reviseScope('compose-file', 'repo'), 'compose-file')
})

test('an opt-out stays an opt-out whatever the floor says', () => {
  for (const floor of SCOPES) {
    assert.equal(reviseScope('none', floor), 'none', floor)
    assert.equal(reviseScope('off', floor), 'none', floor)
  }
})

test('a typo narrows to service, never to the floor', () => {
  // Same rule as scopeFor's own: an unrecognised value must never grant reach, and
  // falling back to the floor would be exactly that when the floor is wide.
  assert.equal(reviseScope('compose-dirr', 'repo'), 'service')
  assert.equal(reviseScope('everything', 'repo'), 'service')
})

test('the policy accepts every rung the ladder has, and nothing else', () => {
  // Two places naming the same rungs will drift. Asserted through the schema's behaviour
  // rather than its internals, so this keeps working across zod versions.
  for (const scope of SCOPES) {
    const parsed = PolicySchema.parse({ revise: { scope } }) as { revise: { scope: string } }
    assert.equal(parsed.revise.scope, scope)
  }
  assert.throws(() => PolicySchema.parse({ revise: { scope: 'compose-dirr' } }))
  // ...and the shipped default is one of them.
  const fresh = PolicySchema.parse({}) as { revise: { scope: string } }
  assert.ok(SCOPES.includes(fresh.revise.scope as (typeof SCOPES)[number]))
  assert.equal(fresh.revise.mode, 'off')
})

test('the floor reaches a sibling config file but nothing that runs', () => {
  // The end-to-end shape of the default: compose-dir, config types only.
  const b = boundaryFor(reviseScope(null, 'compose-dir'), 'paperless/docker-compose.yaml', 'config')
  assert.equal(canWrite('paperless/litellm-config.yaml', b, 'shipshape').ok, true)
  assert.equal(canWrite('paperless/docker-compose.yaml', b, 'shipshape').ok, true)
  for (const f of [
    'paperless/entrypoint.sh',
    'paperless/../shipshape/config/policy.yaml',
    'paperless/bin/run.sh',
    'n8n/docker-compose.yaml',
    '.github/workflows/ci.yaml',
  ]) {
    assert.equal(canWrite(f, b, 'shipshape').ok, false, f)
  }
})
