import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { socketBindings, TEST_ORIGIN, TEST_PROXY, TEST_USER } from '../helpers/trusted-proxy.ts'

/**
 * The demo world (examples/demo plus src/bin/seed-demo.ts), served: every page a person
 * or a screenshot meets has something on it, and the seeded rows read as the states they
 * were written to be.
 */

let app: { request: (path: string, init?: RequestInit) => Promise<Response> }
let seedDemo: (now?: number) => { updates: number; events: number }
let dir: string

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shipshape-demo-'))
  const repo = join(dir, 'repo')
  cpSync(join(process.cwd(), 'examples', 'demo'), repo, { recursive: true })
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  git(['init', '-q', '-b', 'main'])
  git(['add', '-A'])
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'chore: demo'])
  process.env.DATA_DIR = join(dir, 'data')
  process.env.REPO_DIR = repo
  process.env.GITHUB_REPO = 'you/compose-repo'
  process.env.TZ = 'UTC'
  for (const k of [
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'LLM_BASE_URL',
    'GITHUB_TOKEN',
    'POLICY_FILE',
    'SHIPSHAPE_PASSWORD',
    'SHIPSHAPE_PASSWORD_FILE',
  ]) {
    delete process.env[k]
  }
  process.env.SHIPSHAPE_TRUSTED_PROXY = TEST_PROXY
  process.env.SHIPSHAPE_ALLOWED_USER = TEST_USER
  process.env.SHIPSHAPE_ALLOWED_ORIGIN = TEST_ORIGIN
  ;({ seedDemo } = await import('../../src/bin/seed-demo.ts'))
  seedDemo()
  const { createApp } = await import('../../src/web/server.ts')
  const server = createApp()
  app = {
    request: async (path, init) => {
      const headers = new Headers(init?.headers)
      headers.set('Remote-User', TEST_USER)
      headers.set('Origin', TEST_ORIGIN)
      return server.request(path, { ...init, headers }, socketBindings(TEST_PROXY))
    },
  }
})

after(() => rmSync(dir, { recursive: true, force: true }))

const page = async (path: string) => {
  const res = await app.request(path)
  assert.equal(res.status, 200, path)
  return res.text()
}
const rows = (html: string) => (html.match(/data-row/g) ?? []).length

test('the seed refuses a database that already has history', () => {
  assert.throws(() => seedDemo(), /already has history/)
})

test('the inbox has every group a person meets', async () => {
  const html = await page('/')
  assert.match(html, /Waiting on you/)
  assert.match(html, /Broken/)
  assert.match(html, /Rolling tag moved/)
  assert.doesNotMatch(html, /Getting started/)
  assert.ok(rows(html) >= 5, `${rows(html)} rows`)
})

test('the hero decision explains itself', async () => {
  const html = await page('/updates/2?list=inbox')
  assert.match(html, /Breaking changes/)
  assert.match(html, /Needs action/)
  assert.match(html, /Mount the model cache|VectorChord/)
  assert.match(html, /id="confirm-ship-2"/)
})

test('every list page has rows', async () => {
  assert.ok(rows(await page('/updates?stage=all')) >= 14)
  assert.equal(rows(await page('/services')), 15)
  const unwatched = await page('/services?filter=unwatched')
  assert.equal(rows(unwatched), 1)
  assert.match(unwatched, /Watch all 1/)
  assert.match(await page('/updates?stage=releases'), /id="rel-/)
  assert.match(await page('/activity'), /deploy failed: rolled back/)
})

test('status shows deploys, spend and the incident', async () => {
  const html = await page('/status')
  assert.match(html, /Recent deploys/)
  assert.match(html, /libexpat/)
  assert.match(html, /\$0\.31 of \$15\.00/)
  assert.match(html, /1 image still to read/)
})

test('settings shows the rule in words', async () => {
  assert.match(await page('/settings'), /every service running docker\.io\/louislam\/uptime-kuma, waiving ask/)
})

test('every page renders whole', async () => {
  for (const path of [
    '/',
    '/updates',
    '/updates?stage=all&q=x',
    '/services',
    '/services?group=stack',
    '/activity',
    '/settings',
    '/status',
  ]) {
    assert.match(await page(path), /^<!DOCTYPE html>|^<html lang="en"/, path)
  }
})
