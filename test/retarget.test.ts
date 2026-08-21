import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Type-only, so it is erased rather than loading the module before DATA_DIR is set.
import type { GroupMember, UpdateGroup } from '../src/groups.ts'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'shipshape-test-'))

const { getDb } = await import('../src/db.ts')
const { branchOwnership, partitionOvertaken, repointPr, resolveBranch, supersededPrs } =
  await import('../src/gitops/pr.ts')
const { branchFor } = await import('../src/groups.ts')
const { PolicySchema } = await import('../src/config.ts')
const { decide } = await import('../src/gitops/automerge.ts')

/**
 * Moving an overtaken pull request onto its successor instead of replacing it.
 *
 * The git and GitHub halves are not exercised here for the same reason `openPr` is not:
 * they need a work clone and a token. What is testable is everything that decides -- which
 * pull requests can move, which branch a group claims, whether a ref upstream is ours to
 * overwrite -- and the transaction that repoints one, which is where a mistake would be
 * both silent and permanent.
 */

function reset(): void {
  getDb().exec(
    `DELETE FROM prs; DELETE FROM updates; DELETE FROM pr_updates; DELETE FROM proposals;
     DELETE FROM events;`,
  )
}

function update(
  state: string,
  toTag: string,
  opts: { service?: string; magnitude?: string } = {},
): number {
  const now = new Date().toISOString()
  const info = getDb()
    .prepare(
      `INSERT INTO updates (stack, service, image, from_tag, to_tag, magnitude, tier, state,
                            detected_at, updated_at)
       VALUES ('demo', ?, 'nginx:1.0.0', '1.0.0', ?, ?, 'auto', ?, ?, ?)`,
    )
    .run(opts.service ?? 'svc', toTag, opts.magnitude ?? 'minor', state, now, now)
  return Number(info.lastInsertRowid)
}

function pr(
  number: number,
  branch: string,
  updateIds: number[],
  opts: { userOwned?: number; sha?: string; state?: string } = {},
): number {
  const info = getDb()
    .prepare(
      `INSERT INTO prs (number, branch, head_sha_pushed, state, user_owned, scope, scope_sha,
                        group_key, created_at)
       VALUES (?, ?, ?, ?, ?, 'tag-only', ?, NULL, datetime('now'))`,
    )
    .run(
      number,
      branch,
      opts.sha ?? 'sha-old',
      opts.state ?? 'open',
      opts.userOwned ?? 0,
      opts.sha ?? 'sha-old',
    )
  const id = Number(info.lastInsertRowid)
  for (const u of updateIds) {
    getDb().prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`).run(id, u)
  }
  return id
}

/** A group as `eligibleGroups` would hand it over: rows straight out of `updates`. */
function groupOf(ids: number[], key: string | null = null, branchKey: string | null = null): UpdateGroup {
  const members = ids.map(
    (id) =>
      getDb()
        .prepare(
          `SELECT id, stack, service, image, from_tag, to_tag, magnitude, tier FROM updates
            WHERE id = ?`,
        )
        .get(id) as GroupMember,
  )
  return { key, branchKey, members }
}

beforeEach(reset)

// ------------------------------------------------------------------ partition

test('an overtaken pull request whose branch a successor wants is moved, not retired', () => {
  const dead = update('superseded', '1.1.0')
  const id = pr(1, 'shipshape/demo--svc', [dead])
  const successor = groupOf([update('detected', '1.2.0')])
  // The branch name says (stack, service) and nothing about the version, which is what
  // makes this match possible at all.
  assert.equal(branchFor(successor), 'shipshape/demo--svc')

  const { move, retire } = partitionOvertaken(supersededPrs(), [successor])
  assert.deepEqual(retire, [])
  assert.equal(move.length, 1)
  assert.equal(move[0]!.pr.id, id)
  assert.equal(move[0]!.group, successor)
})

test('a branch someone has pushed to is retired, never rewritten', () => {
  pr(2, 'shipshape/demo--svc', [update('superseded', '1.1.0')], { userOwned: 1 })
  const successor = groupOf([update('detected', '1.2.0')])
  const { move, retire } = partitionOvertaken(supersededPrs(), [successor])
  assert.deepEqual(move, [])
  assert.deepEqual(
    retire.map((p) => p.number),
    [2],
  )
})

test('a pull request on a tag-suffixed branch retires once, which is the migration', () => {
  // Every pull request open before branch names dropped the target tag is on a name no
  // successor can ever ask for, so it takes the old path a final time and its replacement
  // opens on a reusable one.
  pr(3, 'shipshape/demo--svc--1.1.0', [update('superseded', '1.1.0')])
  const successor = groupOf([update('detected', '1.2.0')])
  const { move, retire } = partitionOvertaken(supersededPrs(), [successor])
  assert.deepEqual(move, [])
  assert.deepEqual(
    retire.map((p) => p.number),
    [3],
  )
})

test('an overtaken pull request with no successor at all is retired', () => {
  // The target caught up, vanished, or policy no longer wants a pull request for it --
  // all of which reach here as simply nothing eligible wanting the branch.
  pr(4, 'shipshape/demo--svc', [update('superseded', '1.1.0')])
  const { move, retire } = partitionOvertaken(supersededPrs(), [])
  assert.deepEqual(move, [])
  assert.deepEqual(
    retire.map((p) => p.number),
    [4],
  )
})

// ------------------------------------------------------------------ repointing

test('repointing hands the pull request to the successor and drops the old links', () => {
  const dead = update('superseded', '1.1.0')
  const id = pr(5, 'shipshape/demo--svc', [dead], { sha: 'sha-old' })
  getDb()
    .prepare(
      `INSERT INTO proposals (pr_id, update_id, ops, notes, created_at)
       VALUES (?, ?, '[]', '[]', datetime('now'))`,
    )
    .run(id, dead)
  const live = update('detected', '1.2.0', { magnitude: 'patch' })
  const successor = groupOf([live])

  repointPr(id, successor, 'sha-new')

  const links = getDb()
    .prepare(`SELECT update_id FROM pr_updates WHERE pr_id = ?`)
    .all(id) as { update_id: number }[]
  assert.deepEqual(
    links.map((l) => l.update_id),
    [live],
    'the retired update keeps its state but loses the pull request',
  )
  const states = getDb()
    .prepare(`SELECT id, state FROM updates ORDER BY id`)
    .all() as { id: number; state: string }[]
  assert.deepEqual(states, [
    { id: dead, state: 'superseded' },
    { id: live, state: 'pr_open' },
  ])

  const row = getDb().prepare(`SELECT * FROM prs WHERE id = ?`).get(id) as Record<string, unknown>
  // Written in the same transaction as the links: the poller reads this column to decide
  // whether a head it does not recognise is a human's edit.
  assert.equal(row.head_sha_pushed, 'sha-new')
  assert.equal(row.user_owned, 0)
  assert.equal(row.scope, 'tag-only')
  assert.equal(row.scope_sha, null, 'left for the next poll to classify rather than asserted')

  // A draft written for the retired target describes a diff that no longer exists, and
  // the row alone would keep the proposal pass from ever drafting for the new one.
  assert.deepEqual(getDb().prepare(`SELECT COUNT(*) c FROM proposals`).get(), { c: 0 })
})

test('a repointed pull request is no longer overtaken, and the gates can read it', () => {
  const dead = update('superseded', '1.1.0')
  const id = pr(6, 'shipshape/demo--svc', [dead])

  // Before: every linked row is superseded, so decide() drops them all and refuses for
  // want of anything to judge. Asserting the reason, not just `merge: false` -- every
  // refusal is false, so only the reason says which code path answered.
  assert.equal(
    decide(id, 6, 'tag-only', false, PolicySchema.parse({})).reason,
    'no updates recorded for it',
  )

  const live = update('detected', '1.2.0')
  repointPr(id, groupOf([live]), 'sha-new')

  assert.deepEqual(supersededPrs(), [], 'nothing left for the close path to retire')
  // After: the successor is what the gates read. Whether it then merges depends on tier
  // and verdict, which this fixture has no compose file for -- what matters here is that
  // it is no longer refusing because the pull request carries nothing live.
  assert.notEqual(
    decide(id, 6, 'tag-only', false, PolicySchema.parse({})).reason,
    'no updates recorded for it',
  )
})

test('a pull request that stopped being open is never repointed onto live updates', () => {
  // The race: the poll pass takes no git lock, so a close or a merge can land while the
  // branch is being pushed. Linking live updates to a closed pull request strands them --
  // nothing supersedes a closed pull request's members twice, and the scan reads pr_open
  // as still in flight, so the service would go quiet until upstream moved again.
  const dead = update('superseded', '1.1.0')
  const id = pr(7, 'shipshape/demo--svc', [dead], { state: 'closed' })
  const live = update('detected', '1.2.0')

  assert.equal(repointPr(id, groupOf([live]), 'sha-new'), false)
  assert.equal(
    (getDb().prepare(`SELECT state FROM updates WHERE id = ?`).get(live) as { state: string })
      .state,
    'detected',
    'the successor is left waiting, and opens a pull request of its own next pass',
  )
  assert.deepEqual(
    getDb().prepare(`SELECT update_id FROM pr_updates WHERE pr_id = ?`).all(id),
    [{ update_id: dead }],
    'and the closed pull request keeps the record of what it carried',
  )
})

test('a successor overtaken mid-pass is not resurrected by the repoint', () => {
  // The group was read at the top of the pass; a scan can supersede a member before the
  // write lands. Moving it back to pr_open would put a target nothing tracks in front of
  // the merge gates. Left alone, the pull request simply reads as overtaken again.
  const id = pr(8, 'shipshape/demo--svc', [update('superseded', '1.1.0')])
  const live = update('detected', '1.2.0')
  const group = groupOf([live])
  getDb().prepare(`UPDATE updates SET state = 'superseded' WHERE id = ?`).run(live)

  assert.equal(repointPr(id, group, 'sha-new'), true)
  assert.equal(
    (getDb().prepare(`SELECT state FROM updates WHERE id = ?`).get(live) as { state: string })
      .state,
    'superseded',
  )
  assert.deepEqual(
    supersededPrs().map((p) => p.number),
    [8],
    'so the next pass retargets it again rather than merging a dead target',
  )
})

test('a group keeps its tag-bearing key while its branch stays reusable', () => {
  const a = update('detected', '1.2.0')
  const b = update('detected', '1.2.0', { service: 'svc2' })
  const id = pr(7, 'shipshape/demo--group-demo', [update('superseded', '1.1.0')])
  const successor = groupOf([a, b], 'demo--group-demo--1.2.0', 'demo--group-demo')

  repointPr(id, successor, 'sha-new')
  const row = getDb().prepare(`SELECT group_key FROM prs WHERE id = ?`).get(id) as {
    group_key: string
  }
  assert.equal(row.group_key, 'demo--group-demo--1.2.0')
})

// ------------------------------------------------------------------ branch names

test('a group takes the stable branch when nothing is sitting on it', () => {
  const g = groupOf([update('detected', '1.2.0')])
  assert.equal(resolveBranch(g), 'shipshape/demo--svc')
})

test('the pull request being retargeted does not count as holding its own branch', () => {
  const id = pr(8, 'shipshape/demo--svc', [update('superseded', '1.1.0')])
  const g = groupOf([update('detected', '1.2.0')])
  assert.equal(resolveBranch(g, id), 'shipshape/demo--svc')
})

test('a successor takes the tag-suffixed name rather than contend for a held branch', () => {
  // The held one is a pull request somebody has pushed to: it stays open, keeps its
  // branch, and the successor opens alongside it exactly as it did before retargeting.
  pr(9, 'shipshape/demo--svc', [update('superseded', '1.1.0')], { userOwned: 1 })
  const g = groupOf([update('detected', '1.2.0')])
  assert.equal(resolveBranch(g), 'shipshape/demo--svc--1.2.0')
})

test('a branch held only by a closed pull request is free again', () => {
  pr(10, 'shipshape/demo--svc', [update('superseded', '1.1.0')], { state: 'closed' })
  const g = groupOf([update('detected', '1.2.0')])
  assert.equal(resolveBranch(g), 'shipshape/demo--svc')
})

// ------------------------------------------------------------------ push ownership

test('a tip we last pushed is ours to overwrite even after its pull request closed', () => {
  // The whole reason branch names can be reused. Without this, one ref left behind by a
  // pull request closed by hand would refuse every future push for that service.
  pr(11, 'shipshape/demo--svc', [], { state: 'closed', sha: 'sha-1' })
  assert.equal(branchOwnership('shipshape/demo--svc', 'sha-1'), 'ours')
})

test('a tip we last pushed is ours while its pull request is still open', () => {
  pr(12, 'shipshape/demo--svc', [], { sha: 'sha-1' })
  assert.equal(branchOwnership('shipshape/demo--svc', 'sha-1'), 'ours')
})

test('a tip nobody recorded is left alone', () => {
  pr(13, 'shipshape/demo--svc', [], { sha: 'sha-1' })
  assert.equal(branchOwnership('shipshape/demo--svc', 'sha-someone-elses'), 'theirs')
})

test('an open pull request someone has taken over holds its branch outright', () => {
  // Even when the tip reads as one of ours -- they may have pushed and reverted, leaving
  // a sha we would otherwise claim.
  pr(14, 'shipshape/demo--svc', [], { userOwned: 1, sha: 'sha-1' })
  assert.equal(branchOwnership('shipshape/demo--svc', 'sha-1'), 'theirs')
})

test('an unknown branch is never ours', () => {
  assert.equal(branchOwnership('shipshape/demo--never-seen', 'sha-1'), 'theirs')
})
