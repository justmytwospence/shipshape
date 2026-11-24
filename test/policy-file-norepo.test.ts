import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Without a repository configured, no policy file is ever created in the working directory. */

const dir = mkdtempSync(join(tmpdir(), 'shipshape-policy-norepo-'))
process.env.DATA_DIR = dir
delete process.env.REPO_DIR
delete process.env.POLICY_FILE
after(() => rmSync(dir, { recursive: true, force: true }))

const { applySettings } = await import('../src/settings/apply.ts')

test('without REPO_DIR nothing is ever created', async () => {
  const res = await applySettings({ paused: 'false' })
  assert.equal(res.ok, false)
  assert.match(res.ok ? '' : res.errors[0]!, /^cannot read policy\.yaml/)
  assert.equal(existsSync('shipshape.yaml'), false)
})
