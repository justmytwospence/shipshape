import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanRepo } from '../src/compose/scan.ts'

/**
 * Disabled and standby stacks are watched (so a revival is not a blind jump across
 * releases) and flagged dormant, which tierFor turns into `held`.
 */

const repo = mkdtempSync(join(tmpdir(), 'shipshape-dormant-'))
after(() => rmSync(repo, { recursive: true, force: true }))

mkdirSync(join(repo, 'app'))
writeFileSync(
  join(repo, 'app', 'docker-compose.yaml'),
  `services:
  live:
    image: nginx:1.27.0
    labels:
      shipshape.watch: "true"
  parked:
    profiles: ["disabled"]
    image: redis:7.2.4
    labels:
      shipshape.watch: "true"
  spare:
    profiles: ["standby"]
    image: postgres:16.3
    labels:
      shipshape.watch: "true"
`,
)

test('disabled and standby services are watched and dormant; others are not dormant', () => {
  const byName = Object.fromEntries(scanRepo(repo).map((s) => [s.service, s]))
  for (const n of ['parked', 'spare']) {
    assert.equal(byName[n]!.watched, true, n)
    assert.equal(byName[n]!.unwatchable, null, n)
    assert.equal(byName[n]!.dormant, true, n)
  }
  assert.equal(byName.live!.watched, true)
  assert.equal(byName.live!.dormant, false)
})
