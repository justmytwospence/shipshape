import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * What a retry / roll back tap on a deploy card can make happen (through the MCP's
 * stack_action): a verb lands on the stack's newest
 * deploy only when `actionsFor` allows it there -- otherwise the refusal sentence comes
 * back for the card.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-stack-verbs-'))
process.env.DATA_DIR = dir
process.env.MCP_PORT = '8082'
delete process.env.REPO_DIR

const { getDb } = await import('../src/db.ts')
const { runStackVerb } = await import('../src/updates/stack-verbs.ts')
const { linkDeployUpdates } = await import('../src/deploy/queue.ts')
const { latestDeployUpdates } = await import('../src/updates/stack-verbs.ts')
const { deployActions } = await import('../src/notify/index.ts')

after(() => rmSync(dir, { recursive: true, force: true }))

const now = () => new Date().toISOString()

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

test('a stack with no deploy says so', async () => {
  assert.deepEqual(await runStackVerb('nothing', 'retry'), { ok: false, message: 'there is no deploy of nothing to retry' })
})

test('a verb the newest deploy does not allow comes back as the refusal, and changes nothing', async () => {
  const { updateId } = seedDeploy('app', 'pr_open')
  const r = await runStackVerb('app', 'rollback')
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

