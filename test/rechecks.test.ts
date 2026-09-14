import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'shipshape-rechecks-'))
process.env.DATA_DIR = dir
delete process.env.REPO_DIR
// No channel configured, so a regression that alerts has nobody to reach.
delete process.env.NTFY_URL
delete process.env.SMTP_URL

const { getDb } = await import('../src/db.ts')
const { runRechecks } = await import('../src/deploy/queue.ts')
const { DockerUnreadable, missing } = await import('../src/deploy/probe.ts')

after(() => rmSync(dir, { recursive: true, force: true }))

/**
 * The soak's second look, when docker cannot be asked.
 *
 * It used to read a socket error as every service gone: the deploy went `degraded` and
 * the operator was told a healthy service had stopped being healthy. A soak that cannot
 * see has not seen anything wrong, so it leaves the deploy as it was and looks again.
 */

beforeEach(() => {
  getDb().exec(
    `DELETE FROM deploy_updates; DELETE FROM deploys; DELETE FROM pr_updates; DELETE FROM prs; DELETE FROM updates;`,
  )
})

/** A deploy that passed its window and whose soak came due a minute ago. */
function soaking(): number {
  const now = new Date().toISOString()
  const info = getDb()
    .prepare(
      `INSERT INTO deploys (pr_number, stack, services, strategy, ok, healthy, detail, status,
                            recheck_at, created_at)
       VALUES (5, 'jellyfin', 'jellyfin', 'up', 1, 1, 'jellyfin up in 40s', 'deployed', ?, ?)`,
    )
    .run(new Date(Date.now() - 60_000).toISOString(), now)
  return Number(info.lastInsertRowid)
}

const deployRow = (id: number) =>
  getDb().prepare(`SELECT status, recheck_at FROM deploys WHERE id = ?`).get(id) as {
    status: string
    recheck_at: string | null
  }

test('a soak that cannot ask docker looks again later and calls nothing degraded', async () => {
  const id = soaking()
  await runRechecks({
    observe: async () => {
      throw new DockerUnreadable('permission denied')
    },
  })

  const row = deployRow(id)
  assert.equal(row.status, 'deployed')
  assert.ok(row.recheck_at, 'still due a look')
  assert.ok(Date.parse(row.recheck_at!) > Date.now() + 4 * 60_000, 'postponed, not retried at once')

  const event = getDb()
    .prepare(`SELECT level, message, detail FROM events WHERE kind = 'deploy' ORDER BY id DESC LIMIT 1`)
    .get() as { level: string; message: string; detail: string }
  assert.equal(event.level, 'warn')
  assert.equal(event.message, 'could not ask docker about jellyfin; looking again in 5 minutes')
  assert.equal(event.detail, 'permission denied')
})

test('an old row without a plan is rechecked as before', async () => {
  // Rows written before plans were recorded soak every service they name.
  const id = soaking()
  const looked: string[] = []
  await runRechecks({
    observe: async (_project, service) => {
      looked.push(service)
      return { ...missing(service), found: true, id: 'c1', state: 'running', restartPolicy: 'unless-stopped' }
    },
  })
  assert.deepEqual(looked, ['jellyfin'])
  assert.equal(deployRow(id).status, 'verified')
})

test('a soak that can ask still verifies', async () => {
  const id = soaking()
  await runRechecks({
    observe: async (_project, service) => ({
      ...missing(service),
      found: true,
      id: 'c1',
      state: 'running',
      restartPolicy: 'unless-stopped',
    }),
  })
  assert.equal(deployRow(id).status, 'verified')
})
