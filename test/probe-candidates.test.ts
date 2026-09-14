import { test } from 'node:test'
import assert from 'node:assert/strict'
import { candidateTagsFor } from '../src/registry/probe.ts'

/**
 * Which image tags a release name could have been published as, for repositories too large
 * to list. Each guess costs one HEAD, so the list stays short -- but a guess that is never
 * made is a release the probe cannot see.
 */

test('both v spellings are probed, as before', () => {
  assert.deepEqual(candidateTagsFor('v1.2.3'), ['v1.2.3', '1.2.3'])
  assert.deepEqual(candidateTagsFor('1.2.3'), ['1.2.3', 'v1.2.3'])
})

test('a package-prefixed release is probed as its bare version', () => {
  assert.deepEqual(candidateTagsFor('n8n@2.39.0'), ['2.39.0', 'v2.39.0'])
})

test('a variant pin probes each release in its own flavour', () => {
  assert.deepEqual(candidateTagsFor('v2.96.22', '2.96.17-cpu'), ['v2.96.22', '2.96.22', 'v2.96.22-cpu', '2.96.22-cpu'])
  assert.deepEqual(candidateTagsFor('v1.2.4', '1.2.3'), ['v1.2.4', '1.2.4'], 'a plain pin adds nothing')
})
