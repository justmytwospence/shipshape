import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * What the push says when a deploy goes wrong, captured at the wire.
 *
 * An alert is read at 3am by someone deciding whether to get up, so every sentence in it is
 * a claim about the host: DOWN or not, which services, which button, which command. These
 * pin the claims against a docker that records what it was asked.
 */

const root = mkdtempSync(join(tmpdir(), 'shipshape-deploy-alerts-'))
const data = join(root, 'data')
// Not a git checkout, so a rollback reached from here fails at its first git command
// rather than reverting anything.
const repo = join(root, 'repo')
const bin = join(root, 'bin')
for (const d of [data, repo, bin]) mkdirSync(d)
// Anything that reaches past the fake io -- log collection, say -- meets a docker that refuses.
writeFileSync(join(bin, 'docker'), '#!/bin/sh\necho "test docker: refused" >&2\nexit 1\n')
chmodSync(join(bin, 'docker'), 0o755)
process.env.PATH = `${bin}:${process.env.PATH}`
process.env.DATA_DIR = data
process.env.REPO_DIR = repo
process.env.GITHUB_REPO = 'you/repo'
process.env.NTFY_URL = 'http://ntfy.invalid'
process.env.NTFY_TOKEN = 'test'
delete process.env.POLICY_FILE
delete process.env.SMTP_URL

const sent: { title: string; body: string; priority: string }[] = []
globalThis.fetch = (async (_url: unknown, init: { headers: Record<string, string>; body: unknown }) => {
  sent.push({ title: init.headers.title!, body: String(init.body), priority: init.headers.priority! })
  return new Response('ok', { status: 200 })
}) as unknown as typeof fetch

const { getDb } = await import('../src/db.ts')
const { deployForPr } = await import('../src/deploy/run.ts')
const { claimJob, enqueueDeploy, linkDeployUpdates, runDeployJob } = await import('../src/deploy/queue.ts')
const { contextFor } = await import('../src/updates/verbs.ts')
const { actionsFor } = await import('../src/updates/actions.ts')
const { composeCalls, fakeIo } = await import('./helpers/deploy-io.ts')
type DeployTarget = import('../src/deploy/run.ts').DeployTarget

after(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  getDb().exec(
    `DELETE FROM deploy_updates; DELETE FROM deploys; DELETE FROM pr_updates; DELETE FROM prs;
     DELETE FROM updates; DELETE FROM digest_items; DELETE FROM events;`,
  )
  sent.length = 0
})

/** The block an operator would paste, one command per line. */
const retryLines = (body: string): string[] => body.split('Retry with:\n')[1]?.split('\n') ?? []

// ---------------------------------------------------------------- a pull that fails

const actual: DeployTarget = { stack: 'actual', services: ['actual', 'actual-sync'], strategy: 'up', pull: true }
const pullFails = (c: string) => (c.includes(' pull ') ? 1 : 0)

test('a pull that fails under rm-first removed nothing and is not DOWN', async () => {
  const io = fakeIo({ actual: 'running' }, { exitCode: pullFails })
  const out = await deployForPr(0, { ...actual, services: ['actual'], strategy: 'rm-first' }, undefined, { io })

  assert.ok(!out.ok)
  assert.equal(out.phase, 'pull')
  assert.ok(!io.calls.some((c) => / rm -sf /.test(c)), io.calls.join('\n'))
  assert.equal(sent.length, 1)
  assert.doesNotMatch(sent[0]!.title, /DOWN/)
  assert.equal(sent[0]!.priority, '4')
  assert.doesNotMatch(sent[0]!.body, /DOWN/)
  assert.match(sent[0]!.body, /Nothing was removed or recreated/)
})

test('a pull that fails names only what it meant to bring up', async () => {
  const io = fakeIo({ actual: 'running', 'actual-sync': 'exited' }, { exitCode: pullFails })
  await deployForPr(0, actual, undefined, { io })

  assert.deepEqual(composeCalls(io.calls), ['compose -f actual/docker-compose.yaml pull actual'])
  assert.equal(sent.length, 1)
  assert.match(sent[0]!.body, /^#0 merged but actual did not deploy\./)
  const lines = retryLines(sent[0]!.body)
  assert.ok(lines.length > 0, sent[0]!.body)
  assert.ok(
    lines.every((l) => !l.includes('actual-sync')),
    `a pasted command must not start what the deploy left stopped:\n${lines.join('\n')}`,
  )
})

// ---------------------------------------------------------------- docker answered, unhelpfully

test('an orphan container says how to clear it, not to wait for docker', async () => {
  const io = fakeIo({ bitwarden: 'absent' }, { foreign: async () => 'compose project "bw-old" (bitwarden)' })
  await deployForPr(101, { stack: 'bitwarden', services: ['bitwarden'], strategy: 'up' }, undefined, { io })

  assert.equal(sent.length, 1)
  assert.doesNotMatch(sent[0]!.body, /once docker answers/)
  assert.match(
    sent[0]!.body,
    /\n\nRemove that container \(docker rm -f bitwarden\) or bring it up from its own compose project, then press Try again on the update\.$/,
  )
})

test('a Redeploy that could not ask docker names the button a rolling update offers', async () => {
  const db = getDb()
  const now = new Date().toISOString()
  const updateId = Number(
    db
      .prepare(
        `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state, detail, detected_at, updated_at)
         VALUES ('actual', 'actual', 'actualbudget/actual-server', 'latest@sha256:aaaa', 'latest@sha256:bbbb',
                 'digest', 'manual', 'detected', 'rolling', ?, ?)`,
      )
      .run(now, now).lastInsertRowid,
  )
  const deployId = Number(
    db
      .prepare(
        `INSERT INTO deploys (pr_number, pr_id, stack, services, strategy, ok, healthy, status, attempts, created_at, trigger)
         VALUES (NULL, NULL, 'actual', 'actual', 'up', 0, 0, 'pending', 0, ?, 'redeploy')`,
      )
      .run(now).lastInsertRowid,
  )
  linkDeployUpdates(deployId, null, [updateId])

  await runDeployJob(claimJob(deployId)!, { pull: true, io: fakeIo({ actual: 'unreadable' }) })

  assert.equal(sent.length, 1)
  assert.match(sent[0]!.body, /\n\nPress Redeploy on the update once docker answers\.$/)
  assert.doesNotMatch(sent[0]!.body, /Try again/)
  // And the button it names is really there.
  assert.ok(actionsFor(contextFor(updateId)!.ctx).includes('redeploy'))
  assert.ok(!actionsFor(contextFor(updateId)!.ctx).includes('retry'))
})

// ---------------------------------------------------------------- an up that fails

test('a plain up that fails after recreating pages that the service is DOWN', async () => {
  const io = fakeIo({ app: ['running', 'created'] }, { exitCode: (c) => (c.includes(' up ') ? 1 : 0) })
  await deployForPr(7, { stack: 'scratch', services: ['app'], strategy: 'up' }, undefined, { io })

  assert.equal(sent.length, 1)
  // Titles travel as HTTP headers, so the em dash arrives transliterated.
  assert.equal(sent[0]!.title, 'shipshape: scratch is DOWN - deploy failed')
  assert.equal(sent[0]!.priority, '5')
  assert.match(sent[0]!.body, /The old container was replaced and the new one did not start — the service is DOWN\./)
  assert.doesNotMatch(sent[0]!.body, /running whatever it was/)
})

test('a plain up that fails before recreating is not DOWN', async () => {
  const io = fakeIo({ app: 'running' }, { exitCode: (c) => (c.includes(' up ') ? 1 : 0) })
  await deployForPr(7, { stack: 'scratch', services: ['app'], strategy: 'up' }, undefined, { io })

  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.title, 'shipshape: deploy failed - scratch')
  assert.equal(sent[0]!.priority, '4')
  assert.match(sent[0]!.body, /running whatever it was/)
})

// ---------------------------------------------------------------- verification said no

test('a failed verdict alerts once, from the rollback, not also "roll back by hand"', async () => {
  const db = getDb()
  const now = new Date().toISOString()
  const prId = Number(
    db
      .prepare(
        `INSERT INTO prs (number, branch, head_sha_pushed, state, scope, created_at, merge_commit_sha)
         VALUES (44, 'b44', 'sha', 'merged', 'tag-only', ?, 'abc1234')`,
      )
      .run(now).lastInsertRowid,
  )
  const updateId = Number(
    db
      .prepare(
        `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state, detected_at, updated_at)
         VALUES ('scratch', 'app', 'img/app', '1.0.0', '1.0.1', 'patch', 'auto', 'merged', ?, ?)`,
      )
      .run(now, now).lastInsertRowid,
  )
  db.prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`).run(prId, updateId)
  enqueueDeploy({ prId, prNumber: 44, target: { stack: 'scratch', services: ['app'], strategy: 'up' }, now })
  const { id } = db.prepare(`SELECT MAX(id) id FROM deploys`).get() as { id: number }

  const io = fakeIo(
    { app: 'running' },
    { verify: async () => ({ kind: 'failed' as const, detail: 'app: exited', findings: [] }) },
  )
  await runDeployJob(claimJob(id)!, { io })

  // The checkout here is not a git repository, so the automatic rollback fails at its first
  // git command and says so. What matters is that it is the only thing said.
  assert.equal(sent.length, 1, sent.map((s) => s.title).join('\n'))
  assert.doesNotMatch(sent[0]!.title, /unhealthy after deploy/)
  assert.match(sent[0]!.title, /rollback failed/)
})

test('a verifier that could not see still alerts, because nothing else will', async () => {
  const io = fakeIo({ app: 'running' }, { verify: async () => ({ kind: 'error' as const, detail: 'could not see' }) })
  await deployForPr(45, { stack: 'scratch', services: ['app'], strategy: 'up' }, undefined, { io })

  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.title, 'shipshape: scratch unhealthy after deploy')
})
