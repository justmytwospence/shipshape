import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { socketBindings, TEST_ORIGIN, TEST_PROXY, TEST_USER } from '../helpers/trusted-proxy.ts'

/**
 * Authentication is one wildcard middleware, and Hono's router once skipped wildcard
 * middleware for paths ending in an encoded line terminator. No route may answer such a
 * path to a request that carries no identity.
 */

let dir = ''
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'shipshape-terminators-'))
  process.env.DATA_DIR = dir
  delete process.env.REPO_DIR
  process.env.SHIPSHAPE_TRUSTED_PROXY = TEST_PROXY
  process.env.SHIPSHAPE_ALLOWED_USER = TEST_USER
  process.env.SHIPSHAPE_ALLOWED_ORIGIN = TEST_ORIGIN
})
after(() => rmSync(dir, { recursive: true, force: true }))

test('no route answers an encoded line terminator without identity', async () => {
  const { createApp } = await import('../../src/web/server.ts')
  const app = createApp()
  const seen = new Set<string>()
  for (const r of app.routes) {
    let path = r.path.replace(/:[^/{]+(\{[^}]*\})?/g, '1').replace(/\*/g, 'x')
    if (!path.startsWith('/')) path = `/${path}`
    const method = r.method === 'ALL' ? 'GET' : r.method
    for (const suffix of ['%0a', '%0d', '%E2%80%A8', '%0a/x']) {
      const key = `${method} ${path}${suffix}`
      if (seen.has(key)) continue
      seen.add(key)
      const res = await app.request(path + suffix, { method, headers: { Origin: TEST_ORIGIN } }, socketBindings(TEST_PROXY))
      assert.ok([403, 404].includes(res.status), `${key} answered ${res.status}`)
    }
  }
  assert.ok(seen.size > 20)
})
