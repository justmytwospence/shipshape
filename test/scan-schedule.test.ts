import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The scan schedule is read from the policy file, so a bad one must not be able to take
 * scanning down: it is refused where the file is validated, and a schedule that is already
 * running is only ever replaced by one that was built.
 */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-schedule-'))
const repo = join(dir, 'repo')
mkdirSync(repo, { recursive: true })
process.env.DATA_DIR = join(dir, 'data')
process.env.REPO_DIR = repo
process.env.GITHUB_REPO = 'me/homelab'
process.env.GITHUB_TOKEN = 'x'
process.env.POLICY_FILE = join(dir, 'policy.yaml')
process.env.TZ = 'UTC'

const { validatePolicyText } = await import('../src/config.ts')
const { startScheduler, stopScheduler, rescheduleScan, scheduleInfo } = await import('../src/scheduler.ts')

after(() => {
  stopScheduler()
  rmSync(dir, { recursive: true, force: true })
})

test('an invalid scan.cron makes the policy invalid and names the key', () => {
  const r = validatePolicyText('scan:\n  cron: "0 61 3 * * *"\n')
  assert.equal(r.ok, false)
  assert.match(r.ok ? '' : r.error, /is not a schedule shipshape can run: CronPattern: Invalid value for minute: 61/)
})

test('a five-field cron is accepted', () => {
  assert.deepEqual(validatePolicyText('scan:\n  cron: "30 4 * * *"\n'), { ok: true })
})

test('a bad schedule keeps the one that is running', () => {
  writeFileSync(process.env.POLICY_FILE!, 'scan:\n  cron: "0 0 4 * * *"\n')
  startScheduler()
  const before = scheduleInfo().scan
  assert.equal(before.cron, '0 0 4 * * *')
  assert.ok(before.nextAt)

  writeFileSync(process.env.POLICY_FILE!, 'scan:\n  cron: "nonsense"\n')
  rescheduleScan()
  const after = scheduleInfo().scan
  assert.equal(after.cron, '0 0 4 * * *', 'the last policy that loaded still applies')
  assert.equal(after.nextAt, before.nextAt)
})
