import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classFor, foldGroupClass, foldGroupMagnitude, normaliseClass, repositoryOf, shortRepository } from '../src/policy.ts'

/**
 * Classes replaced the v1 ladder. The label is `shipshape.class`; a leftover v1 label is
 * not read for meaning but holds the service to `ask`, and an unrecognised value narrows
 * to `ask` too: a typo must never grant reach.
 */

const c = (classLabel: string | null = null, legacy = false, dormant = false) => classFor({ classLabel, legacy, dormant })

test('classFor: no label is a normal service', () => {
  assert.equal(c(), 'normal')
})

test('classFor: every v2 class reads as itself', () => {
  for (const cls of ['normal', 'stateful', 'ask', 'lifeline', 'frozen', 'skip'] as const) assert.equal(c(cls), cls)
  assert.equal(c(' Stateful '), 'stateful', 'spelled loosely')
})

test('classFor: shipshape.class: skip is not tracked, even on a dormant stack', () => {
  assert.equal(c('skip'), 'skip')
  assert.equal(c('skip', false, true), 'skip')
})

test('classFor: an unrecognised class narrows to ask', () => {
  assert.equal(c('statefull'), 'ask')
  assert.equal(c('auto'), 'ask', 'the v1 word is not a v2 class')
})

test('classFor: a leftover v1 label holds a service to ask', () => {
  assert.equal(c(null, true), 'ask')
  assert.equal(c('normal', true), 'ask')
  assert.equal(c('lifeline', true), 'lifeline')
  assert.equal(c('frozen', true), 'frozen')
})

test('classFor: skip beats everything, and a dormant stack is frozen whatever else applies', () => {
  assert.equal(c('skip', true), 'skip')
  assert.equal(c('normal', false, true), 'frozen')
})

test('normaliseClass: v2 words read as themselves, anything else as ask', () => {
  for (const cls of ['normal', 'stateful', 'ask', 'lifeline', 'frozen', 'skip']) assert.equal(normaliseClass(cls), cls)
  assert.equal(normaliseClass('auto'), 'ask')
  assert.equal(normaliseClass('manual'), 'ask')
  assert.equal(normaliseClass(''), 'ask')
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
