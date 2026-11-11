import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Restore points: a dump taken before a stateful service is updated. The docker half is
 * faked -- these test what is recorded, pruned and refused, not that pg_dump works.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-restore-'))
process.env.DATA_DIR = dir
delete process.env.REPO_DIR
after(() => rmSync(dir, { recursive: true, force: true }))

const { getDb } = await import('../src/db.ts')
const { takeRestorePoint, stackHasSnapshot } = await import('../src/restore/index.ts')
const { runOffsite, offsiteJob } = await import('../src/restore/offsite.ts')
const { PolicySchema } = await import('../src/config.ts')

type Io = import('../src/restore/index.ts').RestoreIo

let tick = 0
function io(over: Partial<Io> = {}): Io & { dumps: string[] } {
  const dumps: string[] = []
  return {
    dumps,
    containerId: async (_stack, service) => `c-${service}`,
    dump: async (container, command, path) => {
      dumps.push(`${container}: ${command}`)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, 'dump')
      return { ok: true, bytes: 4 }
    },
    now: () => new Date(Date.UTC(2026, 10, 11, 12, 0, tick++)),
    ...over,
  }
}

const policy = (keep = 3, offsite: unknown = null) => PolicySchema.parse({ restore_points: { keep, offsite } })

function image(stack: string, service: string, snapshot: string | null, job: string | null = null) {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO images (stack, service, compose_file, image_ref, registry, repository, watched, snapshot_label, backup_job_label, last_seen_at)
       VALUES (?, ?, 'x', 'x:1', 'docker.io', 'x', 1, ?, ?, 'now')`,
    )
    .run(stack, service, snapshot, job)
}

beforeEach(() => {
  getDb().exec(`DELETE FROM restore_points; DELETE FROM images; DELETE FROM events`)
  tick = 0
})

test('a stack can be dumped only if one of its services says how', () => {
  image('n8n', 'n8n-db', 'pg_dump -U n8n n8n')
  image('n8n', 'n8n', null)
  image('media', 'plex', null)
  assert.equal(stackHasSnapshot('n8n'), true)
  assert.equal(stackHasSnapshot('media'), false)
})

test('the dump command runs in the running container and lands gzipped under the data dir', async () => {
  image('n8n', 'n8n-db', 'pg_dump -U n8n n8n')
  const fake = io()
  const r = await takeRestorePoint('n8n', undefined, fake, policy())
  assert.equal(r.ok, true)
  assert.deepEqual(fake.dumps, ['c-n8n-db: pg_dump -U n8n n8n'])
  if (!r.ok) return
  assert.match(r.points[0]!.path, /restore-points\/n8n\/n8n-db-20261111T120000Z\.gz$/)
  assert.ok(existsSync(r.points[0]!.path))
  const row = getDb().prepare(`SELECT stack, service, bytes FROM restore_points`).get() as Record<string, unknown>
  assert.deepEqual([row.stack, row.service, row.bytes], ['n8n', 'n8n-db', 4])
})

test('a service that is not running is skipped: there is nothing to dump and a deploy leaves it stopped', async () => {
  image('n8n', 'n8n-db', 'pg_dump')
  const r = await takeRestorePoint('n8n', undefined, io({ containerId: async () => null }), policy())
  assert.deepEqual(r, { ok: true, points: [] })
})

test('a failed dump fails the restore point, removes what it made, and says why', async () => {
  image('n8n', 'n8n-a', 'dump-a')
  image('n8n', 'n8n-b', 'dump-b')
  const fake = io({
    dump: async (c, command, path) => {
      if (command === 'dump-b') return { ok: false, reason: 'exit 1: no such database' }
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, 'x')
      return { ok: true, bytes: 1 }
    },
  })
  const r = await takeRestorePoint('n8n', undefined, fake, policy())
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.reason, /n8n-b failed: exit 1: no such database/)
  assert.equal((getDb().prepare(`SELECT COUNT(*) c FROM restore_points`).get() as { c: number }).c, 0, 'the first dump is not kept as a half-point')
})

test('only the newest few are kept per service, files and rows', async () => {
  image('n8n', 'n8n-db', 'pg_dump')
  const paths: string[] = []
  for (let i = 0; i < 5; i++) {
    const r = await takeRestorePoint('n8n', undefined, io(), policy(2))
    if (r.ok) paths.push(r.points[0]!.path)
  }
  const kept = getDb().prepare(`SELECT path FROM restore_points ORDER BY id`).all() as { path: string }[]
  assert.deepEqual(kept.map((k) => k.path), paths.slice(-2))
  assert.deepEqual(paths.map((p) => existsSync(p)), [false, false, false, true, true])
})

// ---------------------------------------------------------------------------- offsite

const cfg = { type: 'mcp' as const, url: 'http://backup-mcp:8000/mcp', tool: 'run_backup', job: '{stack}' }
const reply = (body: unknown, ok = true, sse = false) =>
  (async () => ({ ok, status: ok ? 200 : 500, text: async () => (sse ? `data: ${JSON.stringify(body)}\n\n` : JSON.stringify(body)) })) as never

test('the offsite job is the stack\'s own label, else the template', () => {
  assert.equal(offsiteJob('{stack}', 'n8n', null), 'n8n')
  assert.equal(offsiteJob('{stack}', 'n8n', 'n8n-nightly'), 'n8n-nightly')
  assert.equal(offsiteJob('backup-{stack}', 'n8n', null), 'backup-n8n')
})

test('offsite calls the tool with the job and reads either answer shape', async () => {
  let sent: any
  const ok = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ message: 'started' }) }] } }
  for (const sse of [false, true]) {
    const r = await runOffsite('n8n', null, cfg, async (url, init) => {
      sent = { url, body: JSON.parse(init.body) }
      return reply(ok, true, sse)()
    })
    assert.deepEqual(r, { status: 'ok', detail: 'n8n: started' })
  }
  assert.equal(sent.url, cfg.url)
  assert.deepEqual(sent.body.params, { name: 'run_backup', arguments: { job: 'n8n' } })
})

test('offsite reports a tool error or an outage and never throws', async () => {
  const bad = { jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ message: 'no such job' }) }] } }
  assert.deepEqual(await runOffsite('n8n', null, cfg, reply(bad)), { status: 'error', detail: 'n8n: no such job' })
  assert.equal((await runOffsite('n8n', null, cfg, reply({}, false))).status, 'error')
  const down = await runOffsite('n8n', null, cfg, async () => {
    throw new Error('connect ECONNREFUSED')
  })
  assert.deepEqual(down, { status: 'error', detail: 'n8n: connect ECONNREFUSED' })
})

test('an offsite failure is recorded but never fails the restore point', async () => {
  image('n8n', 'n8n-db', 'pg_dump', 'n8n-nightly')
  const fake = io({ fetch: reply({ jsonrpc: '2.0', id: 1, error: { message: 'boom' } }) as never })
  const r = await takeRestorePoint('n8n', undefined, fake, policy(3, cfg))
  assert.equal(r.ok, true, 'the local dump stands')
  const row = getDb().prepare(`SELECT offsite_status, offsite_detail FROM restore_points`).get() as Record<string, string>
  assert.equal(row.offsite_status, 'error')
  assert.match(row.offsite_detail!, /n8n-nightly/, 'the stack label named the job')
})
