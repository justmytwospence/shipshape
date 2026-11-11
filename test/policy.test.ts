import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classFor, foldGroupClass, foldGroupMagnitude, normaliseClass, repositoryOf, shortRepository } from '../src/policy.ts'

/**
 * Classes replace the v1 ladder. The label is `shipshape.class`; the v1 labels are still
 * read and mapped, so no compose file breaks on the day the model changes, and an
 * unrecognised value narrows to `ask`: a typo must never grant reach.
 */

const c = (
  classLabel: string | null = null,
  policyLabel: string | null = null,
  prLabel: string | null = null,
  dormant = false,
) => classFor({ classLabel, policyLabel, prLabel, dormant })

test('classFor: no label is a normal service', () => {
  assert.equal(c(), 'normal')
})

test('classFor: every v2 class reads as itself', () => {
  for (const cls of ['normal', 'stateful', 'ask', 'lifeline', 'frozen'] as const) assert.equal(c(cls), cls)
  assert.equal(c(' Stateful '), 'stateful', 'spelled loosely')
})

test('classFor: an unrecognised class narrows to ask', () => {
  assert.equal(c('statefull'), 'ask')
  assert.equal(c('auto'), 'ask', 'the v1 word is not a v2 class')
})

test('classFor: the v1 policy labels are mapped', () => {
  assert.equal(c(null, 'auto'), 'normal')
  assert.equal(c(null, 'manual'), 'ask')
  assert.equal(c(null, 'gated'), 'ask')
  assert.equal(c(null, 'model'), 'ask')
  assert.equal(c(null, 'attended'), 'lifeline')
  assert.equal(c(null, 'on-request'), 'frozen')
  assert.equal(c(null, 'manaul'), 'ask', 'a typo narrows')
})

test('classFor: the v1 pr label still freezes a service', () => {
  assert.equal(c(null, null, 'on-request'), 'frozen')
  assert.equal(c(null, 'manual', 'on-request'), 'ask', 'a policy label is read before the pr label')
})

test('classFor: the class wins over the v1 labels it replaces', () => {
  assert.equal(c('normal', 'attended', 'on-request'), 'normal')
})

test('classFor: skip beats everything, and a dormant stack is frozen whatever else applies', () => {
  assert.equal(c('lifeline', 'skip'), 'skip')
  assert.equal(c('normal', null, null, true), 'frozen')
  assert.equal(c(null, 'skip', null, true), 'skip')
})

test('normaliseClass: rows written before v2 are read in the new words', () => {
  assert.equal(normaliseClass('auto'), 'normal')
  assert.equal(normaliseClass('manual'), 'ask')
  assert.equal(normaliseClass('attended'), 'lifeline')
  assert.equal(normaliseClass('held'), 'frozen')
  assert.equal(normaliseClass('stateful'), 'stateful')
  assert.equal(normaliseClass(null), 'ask')
})

test('foldGroupClass: a group is as careful as its most careful member', () => {
  assert.equal(foldGroupClass(['normal', 'normal']), 'normal')
  assert.equal(foldGroupClass(['normal', 'stateful']), 'stateful')
  assert.equal(foldGroupClass(['stateful', 'ask']), 'ask')
  assert.equal(foldGroupClass(['ask', 'lifeline', 'normal']), 'lifeline')
  assert.equal(foldGroupClass(['normal', 'frozen']), 'frozen')
  assert.equal(foldGroupClass(['skip', 'normal']), 'normal', 'skip members never drag a group down')
})

test('foldGroupMagnitude: a group is labelled with its largest jump', () => {
  assert.equal(foldGroupMagnitude(['patch', 'major']), 'major')
  assert.equal(foldGroupMagnitude(['patch', 'minor']), 'minor')
  assert.equal(foldGroupMagnitude(['digest', 'patch']), 'patch')
})

test('repositoryOf names the registry and repository, never the tag or digest', () => {
  assert.equal(repositoryOf('ghcr.io/agentgateway/agentgateway:v1.6.0'), 'ghcr.io/agentgateway/agentgateway')
  assert.equal(repositoryOf('postgres:17'), 'docker.io/library/postgres')
  assert.equal(repositoryOf('python:3.13-slim@sha256:' + 'a'.repeat(64)), 'docker.io/library/python')
  assert.equal(shortRepository('ghcr.io/agentgateway/agentgateway:v1.6.0'), 'agentgateway')
})
