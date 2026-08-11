import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { botIdentity as authorArgs } from '../src/config.ts'

/**
 * Every git command that writes a commit must carry an identity.
 *
 * The container runs as the host user with no ~/.gitconfig and no global user.name, so
 * git refuses with "Committer identity unknown" rather than inventing one. Each path
 * that commits passes `authorArgs()` for this reason -- except, for a while, the rebase,
 * where the omission was invisible because divergence is rare: shipshape publishes main
 * every cycle, so the fast-forward branch handles almost everything. The first time a
 * local commit and a merge on origin crossed, sync broke, and a broken sync blocks
 * deploys and pull requests both.
 *
 * Asserted against the source because the failure is in how the process is invoked, not
 * in any value a unit test could inspect.
 */

const SYNC = readFileSync(new URL('../src/gitops/sync.ts', import.meta.url), 'utf8')

test('the identity flags name a committer git will accept', () => {
  const args = authorArgs()
  assert.ok(args.some((a) => a.startsWith('user.name=')))
  assert.ok(args.some((a) => a.startsWith('user.email=')))
})

test('the rebase carries the bot identity', () => {
  const line = SYNC.split('\n').find((l) => l.includes("'rebase', '--autostash'"))
  assert.ok(line, 'the rebase invocation moved; this test needs updating with it')
  assert.match(line!, /authorArgs\(\)/)
})

test('no commit-writing git call in sync.ts is missing an identity', () => {
  // The general form of the bug, so a future path that commits cannot reintroduce it.
  const writes = /'(commit|rebase|revert|merge|cherry-pick|am)'/
  for (const [i, line] of SYNC.split('\n').entries()) {
    if (!line.includes('git(HOMELAB()')) continue
    if (!writes.test(line)) continue
    // These write no commit: --ff-only only moves the ref, --abort/--continue only
    // unwind or resume one already in flight.
    if (/--ff-only|--abort|--continue|--skip/.test(line)) continue
    assert.match(line, /authorArgs\(\)/, `sync.ts:${i + 1} commits without an identity`)
  }
})
