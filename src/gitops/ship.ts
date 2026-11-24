import { loadPolicy } from '../config.ts'
import { type Policy } from '../policy-schema.ts'
import { configured, gitBranch, gitCredentialProblem } from '../env.ts'
import { getDb } from '../db/index.ts'
import { logEvent } from '../events.ts'
import { type GroupMember, type UpdateGroup } from '../groups.ts'
import { type BasePrInfo, type ForkPrInfo, changeTitle, shipBranchFor, commitBody } from './body.ts'
import { changeText } from '../updates/vocabulary.ts'
import { authorArgs, ensureWorkRepo, git, httpsUrl, withGitLock } from './repo.ts'
import { syncMain } from './sync.ts'
import { closeLocalChange, closeStaleDrafts, draftFor } from './drafts.ts'
import type { DeployTarget } from '../deploy/types.ts'
import { buildableServices, stackPeers, withNamespacePeers } from '../compose/topology.ts'
import { enqueueDeploy } from '../deploy/queue.ts'
import { logRetired, retireOvertaken, type Retired } from '../updates/overtaken.ts'
import { type UpdateHolds } from '../updates/holds.ts'
import { canRestore, restorePointsFor, takeRestorePoint } from '../restore/index.ts'
import { notify } from '../notify/index.ts'
import { deployLabelFor } from '../images/rows.ts'
import { buildBranch } from './build.ts'
import { eligibleGroups, statusesFor, groupStatus } from './eligible.ts'

/**
 * Shipping updates.
 *
 * An update ships on its own unless a hold says a person is needed (src/policy.ts). When
 * one ships, shipshape builds a branch in its own work clone, merges it into `main` with a
 * merge commit -- so the log keeps the branch shape and a one-line `git revert -m 1` undoes
 * it -- pushes `main`, and queues the deploy. The branch itself is never pushed and there
 * is no pull request: the review that used to live on one is in the merge commit's message
 * and on the update's page. A drafted config change (src/propose) is the one thing that
 * still travels as a branch, because it is a diff a person should read before shipping.
 */



/**
 * The update turned out to be done already.
 *
 * Not a failure: nothing went wrong and nothing needs a person. Superseding it stops the
 * ship pass reconsidering it every cycle, which it otherwise would until the
 * next scan noticed the file had moved.
 */
function retireGroup(group: UpdateGroup, reason: string): boolean {
  const db = getDb()
  const now = new Date().toISOString()
  // "Already applied" is exactly what a ship that was pushed and not yet recorded looks
  // like. Retiring it would lose the deploy that goes with it.
  const ids = group.members.map((m) => m.id)
  const pushing = db
    .prepare(
      `SELECT 1 FROM pr_updates pu JOIN prs p ON p.id = pu.pr_id
        WHERE p.state = 'pushing' AND pu.update_id IN (${ids.map(() => '?').join(',')}) LIMIT 1`,
    )
    .get(...ids)
  if (pushing) {
    logEvent({
      level: 'warn',
      kind: 'ship',
      stack: group.members[0]!.stack,
      message: 'already applied, but a ship of it is still being confirmed',
      detail: reason,
    })
    return false
  }
  const stmt = db.prepare(
    `UPDATE updates SET state = 'superseded', detail = 'applied elsewhere', updated_at = ?
     WHERE id = ?`,
  )
  db.transaction(() => {
    for (const m of group.members) stmt.run(now, m.id)
  })()
  logEvent({
    level: 'info',
    kind: 'ship',
    stack: group.members[0]!.stack,
    message: 'update already applied',
    detail: reason,
  })
  return false
}

function failGroup(group: UpdateGroup, reason: string): boolean {
  logEvent({
    level: 'warn',
    kind: 'ship',
    stack: group.members[0]!.stack,
    message: 'could not build the change',
    detail: reason,
  })
  return false
}


// ------------------------------------------------------------------ the ship pass

export interface ShipRun {
  shipped: number
  /** Groups waiting on a person. */
  decisions: number
  /** Groups left for later: cooldown, review pending, snoozed, paused. */
  waiting: number
  failed: number
  paused?: string
}

/**
 * One pass: work out which groups are ready, and ship them, up to `ship.max_per_run`.
 *
 * Groups that need a person get `decision_since` stamped so the card can escalate; groups
 * that are only waiting (cooldown, review on its way, snoozed, paused) are left alone.
 * Restore points are taken before the git lock, because a dump can take minutes and
 * nothing else should wait behind it; readiness is checked again inside the lock.
 */
let passRunning = false

export async function runShipPass(): Promise<ShipRun> {
  const out: ShipRun = { shipped: 0, decisions: 0, waiting: 0, failed: 0 }
  // One pass at a time: a verb wakes the loop, and a second pass beside a running one
  // would ship the same group twice.
  if (passRunning) {
    out.paused = 'a ship pass is already running'
    return out
  }
  passRunning = true
  try {
    return await passBody(out)
  } finally {
    passRunning = false
  }
}

async function passBody(out: ShipRun): Promise<ShipRun> {
  const { policy } = loadPolicy()

  const setup = configured()
  if (!setup.ok) {
    out.paused = `not configured: ${setup.missing.map((m) => m.name).join(', ')}`
    return out
  }
  const credential = gitCredentialProblem()
  if (credential) {
    out.paused = credential
    return out
  }

  await closeStaleDrafts()

  const groups = eligibleGroups(policy)
  const now = new Date().toISOString()
  const stamp = getDb().prepare(`UPDATE updates SET decision_since = COALESCE(decision_since, ?) WHERE id = ?`)

  for (const group of groups) {
    if (out.shipped >= policy.ship.max_per_run) break
    const statuses = statusesFor(group, policy)
    const verdict = groupStatus(statuses)
    if (verdict === 'decision') {
      for (const s of statuses) if (s.status.status === 'decision') stamp.run(now, s.row.id)
      out.decisions++
      continue
    }
    if (verdict === 'waiting') {
      out.waiting++
      continue
    }

    try {
      if (await shipGroup(group, policy)) out.shipped++
      else out.waiting++
    } catch (err) {
      out.failed++
      logEvent({
        level: 'error',
        kind: 'ship',
        stack: group.members[0]!.stack,
        message: 'failed to ship an update',
        detail: (err as Error).message.slice(0, 300),
      })
    }
  }
  return out
}

/** Does a restore point need taking before this group ships? */
function wantsRestorePoint(statuses: UpdateHolds[]): boolean {
  if (!statuses[0]) return false
  const stack = statuses[0].row.stack
  if (!canRestore(stack)) return false
  // An irreversible migration always gets one. A stateful service gets one for a version
  // move, not for a digest rebuild of the version it already runs (policy.ts, holdsFor).
  return statuses.some(
    (s) =>
      [...s.holds, ...s.waived].some((h) => h.kind === 'irreversible') ||
      (s.cls === 'stateful' && s.row.magnitude !== 'digest'),
  )
}

async function shipGroup(group: UpdateGroup, policy: Policy): Promise<boolean> {
  const stack = group.members[0]!.stack

  // Before the lock: a dump of a large database must not hold every other git operation.
  const before = statusesFor(group, policy)
  let restoreIds: number | null = null
  if (wantsRestorePoint(before)) {
    const r = await takeRestorePoint(stack, undefined)
    if (!r.ok) {
      const mark = getDb().prepare(`UPDATE updates SET restore_error = ? WHERE id = ?`)
      for (const m of group.members) mark.run(r.reason.slice(0, 300), m.id)
      return false
    }
    restoreIds = r.points.length
    const clear = getDb().prepare(`UPDATE updates SET restore_error = NULL WHERE id = ?`)
    for (const m of group.members) clear.run(m.id)
  }

  const shipped = await withGitLock('ship', async () => {
    const sync = await syncMain()
    if (sync.status === 'paused' || sync.status === 'refused') {
      logEvent({ level: 'warn', kind: 'sync', stack, message: 'not shipping: the checkout could not be synced', detail: sync.reason })
      return null
    }
    // Asked again with the lock held: a verb or a scan may have moved things since.
    const statuses = statusesFor(group, policy)
    if (groupStatus(statuses) !== 'ready') return null
    // Not already shipped, skipped or superseded since the pass looked.
    if (!statuses.every((s) => s.row.state === 'detected' || (s.row.state === 'frozen' && s.row.approved_at))) return null

    const repoDir = await ensureWorkRepo()
    const draft = draftFor(group)
    let branch = draft?.branch ?? shipBranchFor(group)
    let built: { forks: Map<number, ForkPrInfo>; bases: Map<number, BasePrInfo> } = { forks: new Map(), bases: new Map() }
    let title = changeTitle(group)

    const hasDraft =
      draft &&
      (await git(repoDir, ['rev-parse', '--verify', `refs/heads/${draft.branch}`], { allowFail: true })).exitCode === 0
    if (!hasDraft) {
      if (draft) {
        // The work clone was recreated: the draft is gone. Close it and let the update be
        // drafted again rather than ship something that was meant to carry more.
        closeLocalChange(draft.id, 'the drafted branch no longer exists in the work clone')
        branch = shipBranchFor(group)
      }
      const b = await buildBranch(repoDir, group, branch)
      if (!b.ok) {
        if (b.alreadyApplied) retireGroup(group, b.reason)
        else failGroup(group, b.reason)
        return null
      }
      built = b
      title = changeTitle(group, b.forks, b.bases)
    }

    // Written down before the push, so a crash between the push and the record leaves a
    // `pushing` row for the next tick to reconcile instead of a ship nobody remembers.
    let prId: number | null = null
    const merged = await mergeAndPush(
      repoDir,
      branch,
      title,
      commitBody(group, built, statuses),
      group,
      hasDraft ? undefined : async () => (await buildBranch(repoDir, group, branch)).ok,
      (mergeSha, branchSha) => {
        prId = recordIntent({
          group,
          branch,
          branchSha,
          mergeSha,
          draftId: hasDraft ? draft!.id : null,
          existingId: prId,
          scope: hasDraft ? 'proposed' : 'tag-only',
          restore: restoreIds !== null,
        })
      },
    )
    if (!merged.ok) {
      if (prId !== null) abandonIntent(prId, !!hasDraft)
      failGroup(group, merged.reason)
      return null
    }
    shipHooks.afterPush?.()
    const recorded = prId as number | null
    if (recorded === null) throw new Error('a ship was pushed without an intent record')
    const rules = statuses.flatMap((s) => s.waived.map((h) => h.waivedBy!))
    if (rules.length > 0) {
      const mark = getDb().prepare(`UPDATE updates SET waived_by = ? WHERE id = ?`)
      for (const s of statuses) mark.run([...new Set(s.waived.map((h) => h.waivedBy!))].join(','), s.row.id)
    }
    return { prId: recorded, mergeSha: merged.mergeSha, title }
  })
  if (!shipped) return false

  await recordShipped(shipped.prId, shipped.mergeSha, group, shipped.title)
  return true
}

/**
 * Merge `branch` into main with a merge commit and push main.
 *
 * The merge commit is what keeps the history branch-shaped; `-m 1` on a revert undoes it.
 * On a lost race with origin the branch is rebuilt (when this pass built it) and merged
 * once more.
 */
async function mergeAndPush(
  repoDir: string,
  branch: string,
  title: string,
  body: string,
  _group: UpdateGroup,
  rebuild?: () => Promise<boolean>,
  beforePush?: (mergeSha: string, branchSha: string) => void,
): Promise<{ ok: true; mergeSha: string; branchSha: string } | { ok: false; reason: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const branchSha = (await git(repoDir, ['rev-parse', branch])).stdout
    await git(repoDir, ['checkout', '-B', gitBranch(), `origin/${gitBranch()}`])
    const merge = await git(repoDir, [...authorArgs(), 'merge', '--no-ff', '-m', title, '-m', body, branch], { allowFail: true })
    if (merge.exitCode !== 0) {
      await git(repoDir, ['merge', '--abort'], { allowFail: true })
      await git(repoDir, ['checkout', '-f', gitBranch()], { allowFail: true })
      return { ok: false, reason: `merging ${branch} failed: ${(merge.stderr || merge.stdout).slice(0, 200)}` }
    }
    const mergeSha = (await git(repoDir, ['rev-parse', 'HEAD'])).stdout
    beforePush?.(mergeSha, branchSha)
    const push = await git(repoDir, ['push', httpsUrl(), `${gitBranch()}:${gitBranch()}`], { remote: true, allowFail: true })
    if (push.exitCode === 0) {
      await git(repoDir, ['branch', '-D', branch], { allowFail: true })
      return { ok: true, mergeSha, branchSha }
    }
    if (!/non-fast-forward|fetch first|rejected/i.test(push.stderr)) {
      return { ok: false, reason: `push failed: ${push.stderr.slice(0, 200)}` }
    }
    // Origin moved under us: refresh and go round once more.
    await git(repoDir, ['fetch', '--prune', httpsUrl(), '+refs/heads/*:refs/remotes/origin/*'], { remote: true })
    if (rebuild && !(await rebuild())) return { ok: false, reason: `the branch could not be rebuilt on the new ${gitBranch()}` }
  }
  return { ok: false, reason: 'push kept losing a race with origin' }
}

/**
 * A test seam: called right after a ship was pushed, before anything is recorded. Tests
 * throw from it to stand in for a crash in the window `reconcilePushing` exists to close.
 * Always null in production.
 */
export const shipHooks: { afterPush: (() => void) | null } = { afterPush: null }

/**
 * The change record for a branch shipshape is about to publish: a `prs` row in state
 * `pushing`, carrying the merge commit's sha so a restart can ask origin whether it
 * landed. `recordShipped` moves it to `merged`.
 */
function recordIntent(o: {
  group: UpdateGroup
  branch: string
  branchSha: string
  mergeSha: string
  draftId: number | null
  existingId: number | null
  scope: 'tag-only' | 'proposed'
  restore: boolean
}): number {
  const db = getDb()
  const now = new Date().toISOString()
  return db.transaction(() => {
    let id: number
    if (o.existingId !== null) {
      // A second attempt in the same push: the merge was rebuilt on a newer origin.
      db.prepare(`UPDATE prs SET head_sha_pushed = ?, merge_commit_sha = ? WHERE id = ?`).run(o.branchSha, o.mergeSha, o.existingId)
      id = o.existingId
    } else if (o.draftId !== null) {
      db.prepare(
        `UPDATE prs SET state = 'pushing', head_sha_pushed = ?, merge_commit_sha = ?, group_key = ? WHERE id = ?`,
      ).run(o.branchSha, o.mergeSha, o.group.key, o.draftId)
      const link = db.prepare(`INSERT OR IGNORE INTO pr_updates (pr_id, update_id) VALUES (?, ?)`)
      for (const m of o.group.members) link.run(o.draftId, m.id)
      id = o.draftId
    } else {
      const info = db
        .prepare(
          `INSERT INTO prs (number, branch, head_sha_pushed, state, group_key, scope, created_at, merge_commit_sha)
           VALUES (0, ?, ?, 'pushing', ?, ?, ?, ?)`,
        )
        .run(o.branch, o.branchSha, o.group.key, o.scope, now, o.mergeSha)
      id = Number(info.lastInsertRowid)
      const link = db.prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`)
      for (const m of o.group.members) link.run(id, m.id)
    }
    if (o.restore) {
      db.prepare(`UPDATE restore_points SET pr_id = ? WHERE pr_id IS NULL AND stack = ? AND created_at >= ?`).run(
        id,
        o.group.members[0]!.stack,
        new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
      )
    }
    return id
  })()
}

/** The push did not happen: a drafted change goes back to being read, any other record is closed. */
function abandonIntent(prId: number, draft: boolean): void {
  const db = getDb()
  if (draft) db.prepare(`UPDATE prs SET state = 'open', merge_commit_sha = NULL WHERE id = ?`).run(prId)
  else db.prepare(`UPDATE prs SET state = 'closed' WHERE id = ?`).run(prId)
}

/**
 * Settle every ship that was being pushed when shipshape last stopped.
 *
 * A `pushing` row means shipshape meant to publish a merge commit and did not get as far
 * as recording that it had. Origin knows which: if the commit is an ancestor of the
 * published branch it landed, and the rest of the ship (the record, the retired updates,
 * the queued deploy) is done now; if not, the row is abandoned and the update ships again.
 * Run first in every tick, never at boot: boot must not depend on the network.
 */
export async function reconcilePushing(): Promise<{ landed: number; dropped: number; unknown: number }> {
  const db = getDb()
  const rows = db
    .prepare(`SELECT id, scope, branch, merge_commit_sha AS sha, group_key FROM prs WHERE state = 'pushing'`)
    .all() as { id: number; scope: string; branch: string; sha: string | null; group_key: string | null }[]
  const out = { landed: 0, dropped: 0, unknown: 0 }
  if (rows.length === 0) return out

  const verdicts = new Map<number, 'landed' | 'dropped' | 'unknown'>()
  try {
    await withGitLock('reconcile', async () => {
      const repo = await ensureWorkRepo()
      for (const r of rows) {
        if (!r.sha) {
          verdicts.set(r.id, 'dropped')
          continue
        }
        const known = await git(repo, ['cat-file', '-e', `${r.sha}^{commit}`], { allowFail: true })
        if (known.exitCode !== 0) {
          verdicts.set(r.id, 'dropped')
          continue
        }
        const anc = await git(repo, ['merge-base', '--is-ancestor', r.sha, `origin/${gitBranch()}`], { allowFail: true })
        if (anc.exitCode === 0) {
          verdicts.set(r.id, 'landed')
          await git(repo, ['branch', '-D', r.branch], { allowFail: true })
        } else verdicts.set(r.id, anc.exitCode === 1 ? 'dropped' : 'unknown')
      }
    })
  } catch (err) {
    logEvent({
      level: 'warn',
      kind: 'sync',
      message: 'could not confirm a ship that was being pushed when shipshape stopped',
      detail: (err as Error).message.slice(0, 300),
    })
    out.unknown = rows.length
    return out
  }

  for (const r of rows) {
    const verdict = verdicts.get(r.id) ?? 'unknown'
    if (verdict === 'unknown') {
      out.unknown++
      continue
    }
    if (verdict === 'dropped') {
      abandonIntent(r.id, r.scope === 'proposed')
      out.dropped++
      logEvent({
        level: 'info',
        kind: 'ship',
        message: 'a ship that was interrupted before it was pushed did not land; it ships again on the next pass',
      })
      continue
    }
    // Landed: finish what recordShipped would have done.
    const members = db
      .prepare(
        `SELECT u.id, u.stack, u.service, u.image, u.from_tag, u.to_tag, u.magnitude, u.tier
           FROM pr_updates pu JOIN updates u ON u.id = pu.update_id WHERE pu.pr_id = ? ORDER BY u.id`,
      )
      .all(r.id) as GroupMember[]
    const group: UpdateGroup = { key: r.group_key, branchKey: null, members }
    const title = changeTitle(group)
    await recordShipped(r.id, r.sha!, group, title)
    out.landed++
    logEvent({
      level: 'warn',
      kind: 'ship',
      stack: members[0]?.stack,
      message: 'a ship that was interrupted after it was pushed has been recorded',
      detail: title,
    })
  }
  return out
}

/**
 * The change landed on main: mark it merged, retire what it overtook, and queue the
 * deploy. All in one transaction, so a crash cannot leave a merged change with nothing
 * queued -- which is how merges used to be lost, silently and permanently.
 */
async function recordShipped(prId: number, mergeSha: string, group: UpdateGroup, title: string): Promise<void> {
  const { policy } = loadPolicy()
  const db = getDb()
  const now = new Date().toISOString()
  const members = group.members
  const stack = members[0]?.stack ?? 'unknown'
  const target: DeployTarget = {
    stack,
    // Plus anything that shares a namespace with them: recreating the owner strands its
    // followers on a dead one, and they go on looking perfectly healthy while it happens.
    services: withNamespacePeers(stack, [...new Set(members.map((m) => m.service))], stackPeers),
    strategy: members.some((m) => deployLabelFor(m.stack, m.service) === 'rm-first') ? 'rm-first' : 'up',
  }
  target.build = buildableServices(stack, target.services, policy)

  let retired: Retired[] = []
  db.transaction(() => {
    db.prepare(`UPDATE prs SET state = 'merged', merged_at = ?, merge_commit_sha = ? WHERE id = ?`).run(now, mergeSha, prId)
    const mark = db.prepare(`UPDATE updates SET state = 'merged', updated_at = ? WHERE id = ?`)
    for (const m of members) mark.run(now, m.id)
    retired = retireOvertaken(now)
    enqueueDeploy({ prId, target, now, status: 'pending' })
  })()
  logRetired(retired)

  // Land it in the live checkout so the deploy runs against merged content.
  const sync = await withGitLock('post-merge-sync', () => syncMain())
  const names = members.map((m) => m.service).join(', ')
  if (sync.status === 'paused' || sync.status === 'refused') {
    logEvent({
      level: 'warn',
      kind: 'ship',
      stack,
      message: `${title} shipped, but the checkout could not be updated`,
      detail: sync.reason,
    })
    await notify({
      key: 'shipshape:sync',
      title: `shipshape: ${stack} shipped, sync blocked`,
      body: `${title}\n\n${sync.reason}\n\nThe deploy stays queued and runs once the checkout is clean.`,
      priority: 4,
      tags: ['warning'],
      eventClass: 'system',
    })
    return
  }
  logEvent({
    level: 'info',
    kind: 'ship',
    stack,
    message: `shipped ${stack}: ${changeText(members, { named: true })}`,
    detail: `deploying ${names}${restorePointsFor(prId).length > 0 ? ', restore point taken' : ''}`,
  })
}
