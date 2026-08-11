import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withNamespacePeers } from '../src/deploy/run.ts'

/**
 * Deploying a container whose network other containers are living inside.
 *
 * `network_mode: service:vpn` is not a reference to a service, it is a pin to a container
 * *id* — the daemon writes `container:<id>` into the dependent's host config at start.
 * Recreate the owner and that id is gone, leaving the dependent running, listed as up,
 * and with no network whatsoever. Every liveness check still passes, which is what makes
 * it worth a test: nothing downstream would have caught it.
 */

const peers = (rows: [string, string | null][]) => () =>
  rows.map(([service, network_mode]) => ({ service, network_mode }))

test('a VPN sidecar brings its followers with it', () => {
  // The real shape in this lab: deluge and qbittorrent each live inside a gluetun
  // container, and only the gluetun image is what an update ever bumps.
  const out = withNamespacePeers(
    'deluge',
    ['deluge-gluetun'],
    peers([
      ['deluge-gluetun', null],
      ['deluge', 'service:deluge-gluetun'],
    ]),
  )
  assert.deepEqual(out, ['deluge-gluetun', 'deluge'])
})

test('a service nobody is living inside is deployed alone', () => {
  const out = withNamespacePeers(
    'jellyfin',
    ['jellyfin'],
    peers([
      ['jellyfin', null],
      ['other', 'service:something-else'],
    ]),
  )
  assert.deepEqual(out, ['jellyfin'])
})

test('several followers all come along', () => {
  const out = withNamespacePeers(
    'vpn',
    ['gluetun'],
    peers([
      ['gluetun', null],
      ['a', 'service:gluetun'],
      ['b', 'service:gluetun'],
    ]),
  )
  assert.deepEqual(out, ['gluetun', 'a', 'b'])
})

test('a follower already in the target is not repeated', () => {
  const out = withNamespacePeers(
    'deluge',
    ['deluge-gluetun', 'deluge'],
    peers([
      ['deluge-gluetun', null],
      ['deluge', 'service:deluge-gluetun'],
    ]),
  )
  assert.deepEqual(out, ['deluge-gluetun', 'deluge'])
})

test('deploying only the follower does not drag in its owner', () => {
  // Recreating the guest is harmless: the host's namespace is untouched, and pulling the
  // VPN down to update the client would be a strictly worse outage.
  const out = withNamespacePeers(
    'deluge',
    ['deluge'],
    peers([
      ['deluge-gluetun', null],
      ['deluge', 'service:deluge-gluetun'],
    ]),
  )
  assert.deepEqual(out, ['deluge'])
})

test('other network modes are not treated as namespace sharing', () => {
  // `host`, `bridge`, `none` and `container:<id>` are not service pins.
  const out = withNamespacePeers(
    'x',
    ['app'],
    peers([
      ['app', null],
      ['h', 'host'],
      ['n', 'none'],
      ['c', 'container:abc123'],
    ]),
  )
  assert.deepEqual(out, ['app'])
})
