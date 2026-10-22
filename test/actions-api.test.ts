import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The machine-only actions listener: what a tap on an alert card can make happen. Only a
 * bearer gets in, only the stack verbs exist, and a verb lands on the stack's newest
 * deploy only when `actionsFor` allows it there -- otherwise the refusal sentence comes
 * back for the card.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-actions-api-'))
process.env.DATA_DIR = dir
process.env.ACTIONS_TOKEN = 'tok'
delete process.env.REPO_DIR

const { getDb } = await import('../src/db.ts')
const { createActionsApp } = await import('../src/web/actions-api.ts')
const { linkDeployUpdates } = await import('../src/deploy/queue.ts')
const { latestDeployUpdates } = await import('../src/updates/stack-verbs.ts')
const { deployActions } = await import('../src/notify/index.ts')

after(() => rmSync(dir, { recursive: true, force: true }))

const now = () => new Date().toISOString()
const app = createActionsApp('tok')
const call = (path: string, token = 'tok') =>
  app.fetch(new Request(`http://shipshape${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }))

function seedDeploy(stack: string, state: string): { updateId: number; deployId: number } {
  const db = getDb()
  const updateId = Number(
    db
      .prepare(
        `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state, detail, detected_at, updated_at)
         VALUES (?, 'app', 'example/app', '1.0.0', ?, 'minor', 'auto', ?, NULL, ?, ?)`,
      )
      .run(stack, `1.${Math.floor(Math.random() * 1e6)}.0`, state, now(), now()).lastInsertRowid,
  )
  const deployId = Number(
    db
      .prepare(
        `INSERT INTO deploys (pr_number, pr_id, stack, services, strategy, ok, healthy, status, attempts, created_at, trigger)
         VALUES (NULL, NULL, ?, 'app', 'up', 0, 0, 'failed', 1, ?, 'merge')`,
      )
      .run(stack, now()).lastInsertRowid,
  )
  linkDeployUpdates(deployId, null, [updateId])
  return { updateId, deployId }
}

beforeEach(() => {
  const db = getDb()
  for (const t of ['deploy_updates', 'deploys', 'pr_updates', 'prs', 'updates']) db.prepare(`DELETE FROM ${t}`).run()
})

test('no bearer, no action', async () => {
  const r = await call('/actions/stacks/app/retry', 'wrong')
  assert.equal(r.status, 401)
})

test('only the stack verbs exist', async () => {
  for (const verb of ['merge-deploy', 'skip', 'deploy']) {
    const r = await call(`/actions/stacks/app/${verb}`)
    assert.equal(r.status, 404, verb)
  }
  assert.equal((await call('/actions/stacks/..%2Fetc/retry')).status, 400)
})

test('a stack with no deploy says so', async () => {
  const r = await call('/actions/stacks/nothing/retry')
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { ok: false, message: 'there is no deploy of nothing to retry' })
})

test('a verb the newest deploy does not allow comes back as the refusal, and changes nothing', async () => {
  const { updateId } = seedDeploy('app', 'pr_open')
  const r = await (await call('/actions/stacks/app/rollback')).json()
  assert.equal(r.ok, false)
  assert.ok(r.message.length > 0)
  const row = getDb().prepare(`SELECT state FROM updates WHERE id = ?`).get(updateId) as { state: string }
  assert.equal(row.state, 'pr_open')
})

test('the newest deploy is the one addressed', () => {
  const a = seedDeploy('app', 'failed')
  const b = seedDeploy('app', 'failed')
  assert.deepEqual(latestDeployUpdates('app'), [b.updateId])
  assert.notEqual(a.updateId, b.updateId)
})

test('deploy incidents carry retry and roll back; others carry nothing', () => {
  const actions = deployActions('shipshape:deploy:paseo')!
  assert.deepEqual(actions.map((a) => [a.emoji, a.do.verb, a.do.stack]), [
    ['🔁', 'retry', 'paseo'],
    ['⏪', 'rollback', 'paseo'],
  ])
  assert.equal(deployActions('shipshape:sync'), undefined)
})

test('update verbs: only the listed ones, and actionsFor still decides', async () => {
  const { updateId } = seedDeploy('app', 'pr_open')
  assert.equal((await call(`/actions/updates/${updateId}/retry`)).status, 404)
  assert.equal((await call(`/actions/updates/abc/skip`)).status, 400)
  const r = await (await call(`/actions/updates/${updateId}/deploy`)).json()
  assert.equal(r.ok, false)
  const missing = await (await call(`/actions/updates/999999/skip`)).json()
  assert.deepEqual(missing, { ok: false, message: 'that update no longer exists' })
})
