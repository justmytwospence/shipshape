import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyOps, type Op } from '../src/propose/apply.ts'

/**
 * Comments in these fixtures are load-bearing: real compose files explain themselves,
 * and an edit that quietly drops that commentary is a bad edit even when the YAML is
 * correct.
 */
const MAP_STYLE = `services:

  # The application. This comment must survive every operation below.
  app:
    container_name: demo_app
    image: ghcr.io/example/app:v1.18.1
    restart: unless-stopped
    environment:
      # Authentication, configured against the old scheme.
      OIDC_ADMIN_CLAIM: groups
      OIDC_ADMIN_VALUE: admins
      APP_URL: "https://app.example.com"
      SECRET: \${APP_SECRET}
    labels:
      shipshape.watch: "true"
      shipshape.pattern: v-semver

  other:
    image: postgres:16
`

const SEQ_STYLE = `services:
  app:
    image: ghcr.io/example/app:v1.0.0
    environment:
      # list form, which compose also accepts
      - OIDC_ADMIN_CLAIM=groups
      - APP_URL=https://app.example.com
`

const ok = (r: ReturnType<typeof applyOps>) => {
  assert.ok(r.ok, r.ok ? '' : `expected success, got: ${r.reason}`)
  return r as Extract<typeof r, { ok: true }>
}

test('set_image rewrites only the image value', () => {
  const r = ok(applyOps(MAP_STYLE, 'app', [{ op: 'set_image', image: 'ghcr.io/example/manager:v2.6.0' }]))
  assert.ok(r.text.includes('image: ghcr.io/example/manager:v2.6.0'))
  // The sibling service on the same image family is untouched.
  assert.ok(r.text.includes('    image: postgres:16'))
  assert.ok(r.text.includes('# The application. This comment must survive'))
})

test('rename_env keeps the value bytes exactly', () => {
  // Re-emitting the value from the parsed model would drop the quoting and the ${VAR}
  // spelling; only the key may change.
  const r = ok(
    applyOps(MAP_STYLE, 'app', [
      { op: 'rename_env', from: 'OIDC_ADMIN_CLAIM', to: 'OIDC_GROUPS_CLAIM' },
      { op: 'rename_env', from: 'SECRET', to: 'APP_SECRET_REF' },
    ]),
  )
  assert.ok(r.text.includes('OIDC_GROUPS_CLAIM: groups'))
  assert.ok(!r.text.includes('OIDC_ADMIN_CLAIM'))
  assert.ok(r.text.includes('APP_SECRET_REF: ${APP_SECRET}'), 'interpolation must survive verbatim')
})

test('set_env overwrites an existing key and appends a new one at the right indent', () => {
  const r = ok(
    applyOps(MAP_STYLE, 'app', [
      { op: 'set_env', key: 'APP_URL', value: '"https://new.example.com"' },
      { op: 'set_env', key: 'TRUSTED_PROXIES', value: '172.16.0.0/12' },
    ]),
  )
  assert.ok(r.text.includes('APP_URL: "https://new.example.com"'))
  const added = r.text.split('\n').find((l) => l.includes('TRUSTED_PROXIES'))!
  assert.equal(added.match(/^\s*/)![0].length, 6, 'must match the sibling entries’ indent')
})

test('remove_env deletes exactly one line', () => {
  const before = MAP_STYLE.split('\n').length
  const r = ok(applyOps(MAP_STYLE, 'app', [{ op: 'remove_env', key: 'OIDC_ADMIN_VALUE' }]))
  assert.ok(!r.text.includes('OIDC_ADMIN_VALUE'))
  assert.equal(r.text.split('\n').length, before - 1)
  assert.ok(r.text.includes('# Authentication, configured against the old scheme.'))
})

test('list-form environment blocks are handled in their own style', () => {
  const r = ok(
    applyOps(SEQ_STYLE, 'app', [
      { op: 'rename_env', from: 'OIDC_ADMIN_CLAIM', to: 'OIDC_GROUPS_CLAIM' },
      { op: 'set_env', key: 'NEW_KEY', value: 'value' },
    ]),
  )
  assert.ok(r.text.includes('- OIDC_GROUPS_CLAIM=groups'))
  assert.ok(r.text.includes('- NEW_KEY=value'), 'must stay in list form, not become a map')
  assert.ok(r.text.includes('# list form, which compose also accepts'))
})

test('labels are edited the same way as environment', () => {
  const r = ok(
    applyOps(MAP_STYLE, 'app', [
      { op: 'set_label', key: 'com.example.tier', value: 'web' },
      { op: 'set_label', key: 'com.example.gone', value: 'x' },
      { op: 'remove_label', key: 'com.example.gone' },
    ]),
  )
  assert.ok(r.text.includes('com.example.tier: web'))
  assert.ok(!r.text.includes('com.example.gone'))
  // A draft never writes shipshape's own labels (test/propose-scope.test.ts).
  assert.ok(r.text.includes('shipshape.watch'))
})

test('a missing block is created rather than refused', () => {
  const r = ok(applyOps(MAP_STYLE, 'other', [{ op: 'set_env', key: 'PGDATA', value: '/data' }]))
  assert.ok(r.text.includes('environment:'))
  assert.ok(r.text.includes('PGDATA: /data'))
  // ...and the neighbouring service keeps its own environment intact.
  assert.ok(r.text.includes('OIDC_ADMIN_CLAIM: groups'))
})

test('operations naming something absent are refused by name', () => {
  const missing = applyOps(MAP_STYLE, 'app', [{ op: 'remove_env', key: 'NOT_THERE' }])
  assert.equal(missing.ok, false)
  assert.match(missing.ok === false ? missing.reason : '', /no environment entry "NOT_THERE"/)

  const noService = applyOps(MAP_STYLE, 'ghost', [{ op: 'set_image', image: 'x:1' }])
  assert.equal(noService.ok, false)
  assert.match(noService.ok === false ? noService.reason : '', /no service "ghost"/)

  const noBlock = applyOps(MAP_STYLE, 'other', [{ op: 'remove_env', key: 'ANY' }])
  assert.equal(noBlock.ok, false)
  assert.match(noBlock.ok === false ? noBlock.reason : '', /no environment block/)
})

test('several operations compose into one coherent result', () => {
  // The arcane shape: the image renames AND the auth scheme changes together.
  const ops: Op[] = [
    { op: 'set_image', image: 'ghcr.io/example/manager:v2.6.0' },
    { op: 'rename_env', from: 'OIDC_ADMIN_CLAIM', to: 'OIDC_GROUPS_CLAIM' },
    { op: 'remove_env', key: 'OIDC_ADMIN_VALUE' },
    { op: 'set_env', key: 'OIDC_ROLE_MAPPINGS', value: 'admins:Admin' },
  ]
  const r = ok(applyOps(MAP_STYLE, 'app', ops))
  assert.ok(r.text.includes('image: ghcr.io/example/manager:v2.6.0'))
  assert.ok(r.text.includes('OIDC_GROUPS_CLAIM: groups'))
  assert.ok(r.text.includes('OIDC_ROLE_MAPPINGS: admins:Admin'))
  assert.ok(!r.text.includes('OIDC_ADMIN_VALUE'))
  assert.equal(r.changed.length, 4)
  // Untouched service and all commentary intact.
  assert.ok(r.text.includes('    image: postgres:16'))
  assert.ok(r.text.includes('# The application.'))
})

test('an empty op list is a no-op, not an edit', () => {
  const r = ok(applyOps(MAP_STYLE, 'app', []))
  assert.equal(r.text, MAP_STYLE)
  assert.deepEqual(r.changed, [])
})

test('every line outside the touched entries is byte-identical', () => {
  const r = ok(applyOps(MAP_STYLE, 'app', [{ op: 'set_env', key: 'APP_URL', value: 'changed' }]))
  const a = MAP_STYLE.split('\n').filter((l) => !l.includes('APP_URL'))
  const b = r.text.split('\n').filter((l) => !l.includes('APP_URL'))
  assert.deepEqual(b, a)
})
