import { Octokit } from 'octokit'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configured, env, loadPolicy, type Policy } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { scanRepo } from '../compose/scan.ts'
import { bumpFork, readForkPin, retireFork } from '../compose/fork-edit.ts'
import { clearForkConflict, forkConflictFor, forkRefs, recordForkConflict, recordForkPrepared } from '../forks.ts'
import { prepareFork as realPrepareFork, upstreamUrlFor, type PrepareForkInput, type PrepareForkResult } from '../forks/rebase.ts'
import { headDigest } from '../registry/index.ts'
import { sameVersion, versionKey } from '../versions/key.ts'
import { parseImageRef, formatImageRef, displayName } from '../images/ref.ts'
import { rewriteFroms } from '../compose/dockerfile.ts'
import {
  branchFor,
  groupUpdates,
  makeLookups,
  taggedBranchFor,
  type GroupMember,
  type UpdateGroup,
} from '../groups.ts'
import { applyCachedVerdict } from '../analyze/run.ts'
import { routine } from '../notify/digest.ts'
import { foldGroupMagnitude, shouldOpenPr, type EffectiveTier } from '../policy.ts'
import type { Magnitude } from '../versions/patterns.ts'
import { applyForkEdit, bumpImage } from './editor.ts'
import { changeText, prBody, short, type BasePrInfo, type ForkPrInfo } from './body.ts'
import { sourceFor } from '../resolver/index.ts'
import { alreadyCommented, mark } from './comments.ts'
import { authorArgs, ensureWorkRepo, git, httpsUrl, withGitLock } from './repo.ts'
import { syncMain } from './sync.ts'

/**
 * Turning detected updates into pull requests.
 *
 * The PR is the review surface: it carries the diff, the changelog analysis, and the
 * merge decision. Merging one is what makes the change real.
 */

let octokit: Octokit | null = null
function gh(): Octokit {
  octokit ??= new Octokit({ auth: env.githubToken })
  return octokit
}

function repoParts(): { owner: string; repo: string } {
  const [owner, repo] = env.githubRepo.split('/') as [string, string]
  return { owner, repo }
}

const LABELS: Record<string, string> = {
  'image-update': '0e8a16',
  major: 'b60205',
  minor: 'fbca04',
  patch: 'c2e0c6',
  digest: 'c5def5',
  'needs-review': 'd4c5f9',
  'review-hold': 'fbca04',
  'review-block': 'b60205',
}

let labelsEnsured = false

async function ensureLabels(): Promise<void> {
  if (labelsEnsured) return
  labelsEnsured = true
  const { owner, repo } = repoParts()
  for (const [name, color] of Object.entries(LABELS)) {
    try {
      await gh().rest.issues.createLabel({ owner, repo, name, color })
    } catch {
      // Already exists, which is the expected case after the first run.
    }
  }
}

export interface PrRunResult {
  opened: number
  skipped: number
  failed: number
  paused?: string
  /** Overtaken pull requests moved onto their successor's target this pass. */
  retargeted: number
  /** Overtaken pull requests retired this pass. */
  closed: number
}

/**
 * One pass: sync, group what is eligible, and open a PR per group up to the configured
 * ceiling.
 */
export async function runPrPass(): Promise<PrRunResult> {
  return withGitLock('pr-pass', async () => {
    const { policy } = loadPolicy()
    const out: PrRunResult = { opened: 0, skipped: 0, failed: 0, retargeted: 0, closed: 0 }

    const setup = configured()
    if (!setup.ok) {
      out.paused = `not configured: ${setup.missing.map((m) => m.name).join(', ')}`
      return out
    }
    if (!env.githubToken) {
      out.paused = 'GITHUB_TOKEN is not set'
      return out
    }

    const sync = await syncMain()
    if (sync.status === 'paused' || sync.status === 'refused') {
      out.paused = sync.reason
      return out
    }

    const groups = eligibleGroups(policy)

    // Before anything is opened: deal with the pull requests whose target was overtaken.
    // Each is either moved onto its successor -- same pull request, same number, new
    // commit -- or, when it cannot be, retired the old way. Ordering matters: a retarget
    // consumes the successor group, so doing this first is what stops the same bump also
    // being opened as a second pull request below, and any slot a close frees is usable
    // in this same pass.
    const { retargeted, consumed, retire } = await settleOvertaken(groups, policy)
    out.retargeted = retargeted
    out.closed = await closeSupersededPrs(retire)

    const pending = groups.filter((g) => !consumed.has(g))
    if (pending.length === 0) return out

    const openNow = countOpenPrs()
    // `null` is no ceiling: every eligible group opens this pass. Written as a branch
    // rather than folding null to Infinity so the arithmetic below never sees a
    // non-finite number and `groups.slice(0, room)` stays an honest integer slice.
    const room = policy.prs.max_open === null ? pending.length : Math.max(0, policy.prs.max_open - openNow)
    if (room === 0) {
      // Once per change of fact, not once per poll. The PR loop runs every 60s while
      // anything is open, and this branch is the steady state of a full queue -- logging
      // it unconditionally wrote 2,237 identical rows in two days and buried every event
      // that mattered underneath them. The scan path has always had this discipline
      // ("events fire on the first observation of a fact"); this is the same rule.
      noteOnce(
        `queue-full:${pending.length}:${openNow}`,
        `holding ${pending.length} update(s): ${openNow} pull requests already open`,
        'raise prs.max_open to open more at once',
      )
      out.skipped = pending.length
      return out
    }
    clearNote('queue-full')

    await ensureLabels()
    const repoDir = await ensureWorkRepo()

    for (const group of pending.slice(0, room)) {
      try {
        const created = await openPr(repoDir, group, policy)
        if (created) out.opened++
        else out.skipped++
      } catch (err) {
        out.failed++
        logEvent({
          level: 'error',
          kind: 'pr',
          stack: group.members[0]!.stack,
          message: 'failed to open a pull request',
          detail: (err as Error).message,
        })
      }
    }
    out.skipped += Math.max(0, pending.length - room)

    return out
  })
}

/**
 * Pull requests whose target has been overtaken.
 *
 * When a scan finds a newer tag for a service that already has a pull request open, it
 * supersedes the update row the pull request was opened for. What is on the branch now
 * bumps to a version nothing is tracking any more, and the successor would rewrite the
 * same `image:` line from the same base -- so the two can never both merge.
 *
 * The pull request is the review surface, and its number, its comments and whatever
 * reading somebody has already done are worth more than the tag inside it. So the
 * default is to move it: rebuild its branch onto the new target, force-push, retitle,
 * rewrite the body, and repoint the database at the successor. Same pull request, newer
 * bump, one comment saying so.
 *
 * `settleOvertaken` sorts them, `retargetPr` moves one, and `closeSupersededPrs` retires
 * the rest -- the ones with nothing live to move onto, and the ones on the tag-suffixed
 * branch names that predate retargeting. A branch somebody has pushed to is never
 * rewritten and never closed: their commits are not ours to discard, so it gets a comment
 * once and is then left alone.
 */
export interface SupersededPr {
  id: number
  number: number
  branch: string
  user_owned: number
}

/**
 * Open pull requests for which EVERY linked update has been superseded.
 *
 * Every, not any: a group whose members have drifted apart still has live work in it, and
 * closing it would discard the member that is still current. Those refuse to auto-merge
 * instead (see the state filter in automerge.ts) and are left for a person.
 *
 * The first EXISTS is not redundant -- without it a pull request with no linked updates
 * at all would satisfy the NOT EXISTS vacuously and be closed.
 */
export function supersededPrs(): SupersededPr[] {
  return getDb()
    .prepare(
      `SELECT p.id, p.number, p.branch, p.user_owned
       FROM prs p
       WHERE p.state = 'open'
         AND EXISTS (SELECT 1 FROM pr_updates pu WHERE pu.pr_id = p.id)
         AND NOT EXISTS (
           SELECT 1 FROM pr_updates pu JOIN updates u ON u.id = pu.update_id
           WHERE pu.pr_id = p.id AND u.state != 'superseded')
       ORDER BY p.number`,
    )
    .all() as SupersededPr[]
}

/** What overtook it: the newest live update for the same service, and its PR if open. */
export function successorFor(prId: number): { toTag: string; number: number | null } | null {
  return (getDb()
    .prepare(
      `SELECT u2.to_tag AS toTag, p2.number AS number
       FROM pr_updates pu
       JOIN updates u ON u.id = pu.update_id
       JOIN updates u2 ON u2.stack = u.stack AND u2.service = u.service
                      AND u2.state IN ('detected','pr_open','held')
       LEFT JOIN pr_updates pu2 ON pu2.update_id = u2.id
       LEFT JOIN prs p2 ON p2.id = pu2.pr_id AND p2.state = 'open'
       WHERE pu.pr_id = ?
       ORDER BY u2.id DESC
       LIMIT 1`,
    )
    .get(prId) ?? null) as { toTag: string; number: number | null } | null
}

/** Marks our own note so it is written once rather than every poll. */
const SUPERSEDED_MARK = mark('superseded')

function supersededNote(next: { toTag: string; number: number | null } | null, mine: boolean): string {
  const to = next
    ? next.number
      ? `**${next.toTag}**, in #${next.number}`
      : `**${next.toTag}**`
    : 'a newer version'
  return mine
    ? `${SUPERSEDED_MARK}\nSuperseded: the target moved on to ${to}, so this pull request bumps a version nothing is tracking any more.\n\n<sub>Left open because this branch carries your commits. Rebase it onto the new target or close it — shipshape will not touch it either way.</sub>`
    : `${SUPERSEDED_MARK}\nClosed: the target moved on to ${to}. Both change the same \`image:\` line from the same base, so only one of them can merge.\n\n<sub>Nothing is lost — the newer pull request carries this bump too.</sub>`
}

/** True when we have already said this on this pull request. */
async function alreadyNoted(number: number): Promise<boolean> {
  return alreadyCommented(number, 'superseded')
}

/** Marks the retarget note, so the comment can be found again by eye or by grep. */
const RETARGET_MARK = mark('retargeted')

function retargetNote(was: string | null, g: UpdateGroup, discarded = 0): string {
  const to = short(g.members[0]!.to_tag)
  const from = was ? ` (was ${short(was)})` : ''
  // Naming the discarded work is the whole point of counting it. The branch was rebuilt
  // from main, so anything asked for in a comment is no longer on it -- and saying
  // nothing would leave shipshape's own "done, pushed" reply standing next to a branch
  // that does not carry the change.
  const lost =
    discarded > 0
      ? `\n\n**${discarded === 1 ? 'A change you asked for in a comment is' : `${discarded} changes you asked for in comments are`} not on the rebuilt branch.** Ask again and shipshape will redo ${discarded === 1 ? 'it' : 'them'} against the new target — it has not repeated ${discarded === 1 ? 'it' : 'them'} on its own, because ${discarded === 1 ? 'that comment was' : 'those comments were'} written about a different diff.`
      : ''
  return `${RETARGET_MARK}\nRetargeted to **${to}**${from}: the target moved on, so this pull request carries the newer bump rather than being closed in favour of another one.${lost}\n\n<sub>The branch was rebuilt from \`main\`, so any diff you had already read is out of date. The changelog review above re-runs for the new version.</sub>`
}

/** The target this pull request carried until now, for the note that says it moved. */
function previousTarget(prId: number): string | null {
  const row = getDb()
    .prepare(
      `SELECT u.to_tag FROM pr_updates pu JOIN updates u ON u.id = pu.update_id
        WHERE pu.pr_id = ? ORDER BY u.id DESC LIMIT 1`,
    )
    .get(prId) as { to_tag: string } | undefined
  return row?.to_tag ?? null
}

/**
 * Which overtaken pull requests can be moved, and which have to be retired.
 *
 * A pull request can be retargeted when an eligible group wants the branch it is already
 * on. That single test carries all the others: the branch name encodes (stack, service)
 * or (stack, group identity), so a group that matches it is by definition the same work
 * one target later. Everything else falls through to the close path exactly as before --
 * a successor that policy no longer wants a pull request for, a member that caught up or
 * whose tag vanished, a group whose membership drifted apart, and every pull request
 * still sitting on a tag-suffixed branch from before this existed. That last case is the
 * whole migration: those close and reopen once, onto a name that can be reused.
 */
export function partitionOvertaken(
  overtaken: SupersededPr[],
  groups: UpdateGroup[],
): { move: { pr: SupersededPr; group: UpdateGroup }[]; retire: SupersededPr[] } {
  const byBranch = new Map<string, UpdateGroup>()
  for (const g of groups) byBranch.set(branchFor(g), g)

  const move: { pr: SupersededPr; group: UpdateGroup }[] = []
  const retire: SupersededPr[] = []
  // One successor cannot be handed to two pull requests. Nothing should produce two open
  // pull requests on one branch, but if anything ever did, both would repoint the same
  // updates and each would then claim to be the one carrying them.
  const claimed = new Set<UpdateGroup>()
  for (const pr of overtaken) {
    // Their branch is never rewritten, so it is not a candidate whatever is waiting for
    // it; the close path leaves it open with a note instead.
    const group = pr.user_owned ? undefined : byBranch.get(pr.branch)
    if (group && !claimed.has(group)) {
      claimed.add(group)
      move.push({ pr, group })
    } else {
      retire.push(pr)
    }
  }
  return { move, retire }
}

/**
 * Move the overtaken pull requests that can be moved, and report the rest for retirement.
 *
 * `consumed` is the groups that must not also be opened as new pull requests in the same
 * pass -- the ones that were moved, plus the ones whose branch could not be built at all,
 * which would fail identically a second time.
 */
async function settleOvertaken(
  groups: UpdateGroup[],
  policy: Policy,
): Promise<{ retargeted: number; consumed: Set<UpdateGroup>; retire: SupersededPr[] }> {
  const consumed = new Set<UpdateGroup>()
  let retargeted = 0

  const overtaken = supersededPrs()
  if (overtaken.length === 0) return { retargeted, consumed, retire: [] }

  const { move, retire } = partitionOvertaken(overtaken, groups)

  let repoDir: string | null = null
  for (const { pr, group } of move) {
    try {
      if (repoDir === null) {
        await ensureLabels()
        repoDir = await ensureWorkRepo()
      }
      const outcome = await retargetPr(repoDir, pr, group, policy)
      if (outcome === 'retargeted') {
        retargeted++
        consumed.add(group)
      } else if (outcome === 'retire') {
        consumed.add(group)
        retire.push(pr)
      } else if (outcome === 'lost') {
        // Closed or merged from under us mid-retarget. Not retired -- whichever handler
        // won the race has already done that -- and not reopened here either, because the
        // branch it would use may be queued for deletion behind this very pass.
        consumed.add(group)
      }
      // 'leave' is deliberately neither: somebody pushed to the branch between polls, so
      // the pull request keeps its old target for now and the successor opens alongside
      // it on the tag-suffixed name -- which is what happened to every overtaken pull
      // request before this. The next poll marks it theirs and the close path takes over.
    } catch (err) {
      logEvent({
        level: 'warn',
        kind: 'pr',
        message: `could not retarget #${pr.number}`,
        detail: (err as Error).message.slice(0, 200),
      })
    }
  }
  return { retargeted, consumed, retire }
}

/**
 * Move one pull request onto its successor's target.
 *
 * Order is the interesting part. The branch is rebuilt and pushed first, then the
 * database is repointed in one transaction, and only then is GitHub told about the new
 * title, body and labels. Everything after the push is best effort: once the database
 * agrees with the branch, a body that failed to rewrite is stale text on a correct pull
 * request, and the next verdict splices into it anyway. The other order -- GitHub first
 * -- would leave a pull request describing a bump its own branch does not contain.
 */
async function retargetPr(
  repoDir: string,
  pr: SupersededPr,
  group: UpdateGroup,
  policy: Policy,
): Promise<'retargeted' | 'retire' | 'leave' | 'lost'> {
  const was = previousTarget(pr.id)
  const built = await buildBranch(repoDir, group, pr.branch)
  if (!built.ok) {
    // Both of these are the same conclusion for the pull request -- there is nothing to
    // move it onto -- and both have already said why in the log.
    if (built.alreadyApplied) retireGroup(group, built.reason)
    else failGroup(group, built.reason)
    return 'retire'
  }
  const forks = built.forks
  const bases = built.bases

  const push = await pushBranch(repoDir, pr.branch)
  if (!push.ok) {
    logEvent({
      level: 'info',
      kind: 'pr',
      message: `left #${pr.number} alone`,
      detail: push.reason,
    })
    return 'leave'
  }

  // Counted before repointPr marks them stale, so the note can say how much of somebody's
  // asking went with the old branch.
  const discarded = (
    getDb()
      .prepare(
        `SELECT COUNT(*) c FROM instructions
          WHERE pr_id = ? AND status IN ('new', 'working', 'done')`,
      )
      .get(pr.id) as { c: number }
  ).c

  // Immediately after the push and before any network call. The poller decides a branch
  // is a human's by comparing its live head against this column, so every moment between
  // the force-push and this write is a moment a poll could mark the pull request theirs.
  // It would correct itself on the next cycle -- ownership is recomputed both ways every
  // time -- but the pull request would refuse to auto-merge in the meantime for no reason.
  if (!repointPr(pr.id, group, built.sha)) {
    // It stopped being open while the branch was going up. Nothing here is salvageable:
    // the successor was never linked, so it is still waiting, and its branch may be about
    // to be deleted by the close it just lost the race to. Consumed rather than retired
    // so that this pass leaves it alone; the next one opens a fresh pull request for it.
    logEvent({
      level: 'info',
      kind: 'pr',
      message: `#${pr.number} stopped being open while it was being retargeted`,
      detail: 'its successor gets a pull request of its own on the next pass',
    })
    return 'lost'
  }

  const { owner, repo } = repoParts()
  const title = prTitle(group, forks, bases)
  try {
    const sources = await sourceRepos(group)
    await gh().rest.pulls.update({
      owner,
      repo,
      pull_number: pr.number,
      title,
      // Regenerated whole rather than patched: it carries the members table, the
      // reference links and a fresh pair of verdict markers holding the "not run yet"
      // placeholder, so the previous target's analysis cannot survive into the new one.
      body: prBody(group, policy, sources, forks, bases),
    })
  } catch (err) {
    logEvent({
      level: 'warn',
      kind: 'pr',
      message: `#${pr.number} was retargeted but its description was not rewritten`,
      detail: (err as Error).message.slice(0, 200),
    })
  }

  await relabel(pr.number, group)
  try {
    await gh().rest.issues.createComment({
      owner,
      repo,
      issue_number: pr.number,
      body: retargetNote(was, group, discarded),
    })
  } catch {
    // The comment is the archive of what happened, not the mechanism. Losing it does not
    // make the pull request wrong, and retrying the whole retarget for it would.
  }

  // The analysis pass only visits pairs with no verdict at all, so a target another stack
  // has already had judged would otherwise sit on the placeholder forever.
  for (const m of group.members) {
    try {
      await applyCachedVerdict(
        { image: m.image, from_tag: m.from_tag, to_tag: m.to_tag },
        pr.number,
      )
    } catch {
      // Same reasoning: the pass will reach it, and a failure here is not the retarget's.
    }
  }

  // Nothing past the repoint may throw. The pull request has already been moved by this
  // point, and an exception escaping here would report it as not moved -- which would
  // send its successor round the open path in the same pass and try to open a second
  // pull request for a branch that already has one.
  try {
    const one = group.members.length === 1 ? group.members[0]! : null
    logEvent({
      level: 'info',
      kind: 'pr',
      stack: group.members[0]!.stack,
      service: one?.service,
      message: `#${pr.number} retargeted: ${describe(group)}`,
      detail: was ? `was ${short(was)}` : undefined,
    })
    await routine({
      category: 'retargeted',
      stack: group.members[0]!.stack,
      service: one?.service,
      summary: `${changeText(group.members)} (#${pr.number})`,
      detail: was ? `#${pr.number} was targeting ${short(was)}` : undefined,
      url: `https://github.com/${env.githubRepo}/pull/${pr.number}`,
    })
  } catch {
    // A digest entry is worth less than a correct answer to the caller.
  }
  return 'retargeted'
}

/**
 * Point an existing pull request at a different set of updates, in one transaction.
 *
 * The links are replaced rather than added to. Everything downstream reads the members
 * of a pull request through `pr_updates` -- the merge gate, auto-merge, the analysis
 * pass, and the deploy that `onMerged` builds -- so a leftover link to the retired update
 * would get it analysed again and, on merge, marked as though it had shipped.
 *
 * The retired rows keep `state = 'superseded'`: they are the record that this target was
 * once offered, and the only thing they lose is their pull request, which now belongs to
 * the row that overtook them.
 *
 * Refuses, and returns false, if the pull request stopped being open while the branch was
 * being pushed. The poll pass takes no git lock and can be triggered from the web routes,
 * so a person closing or merging this pull request lands its `onClosed`/`onMerged` in the
 * middle of a retarget. Linking live updates to a pull request that is already closed
 * would strand them: nothing supersedes the members of a closed pull request a second
 * time, and the scan reads `pr_open` as still in flight, so the service would go without
 * a pull request until upstream published a different version. The check and the write
 * are one transaction, and better-sqlite3 is synchronous, so nothing can interleave.
 */
export function repointPr(prId: number, group: UpdateGroup, sha: string): boolean {
  const db = getDb()
  const now = new Date().toISOString()
  return db.transaction(() => {
    // scope_sha stays null so the next poll classifies the rebuilt branch rather than
    // taking our word for it, exactly as it does for a pull request that has just opened.
    const moved = db
      .prepare(
        `UPDATE prs SET head_sha_pushed = ?, scope = 'tag-only', scope_sha = NULL,
                        user_owned = 0, group_key = ? WHERE id = ? AND state = 'open'`,
      )
      .run(sha, group.key, prId)
    if (moved.changes === 0) return false

    db.prepare(`DELETE FROM pr_updates WHERE pr_id = ?`).run(prId)
    const link = db.prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`)
    // Only a row that is still waiting for a pull request. A scan that overtook this
    // successor between the pass reading it and this write has already said so, and
    // moving it back to `pr_open` would resurrect a target nothing is tracking. Left as
    // it is, the pull request simply reads as overtaken again and is retargeted next pass.
    const mark = db.prepare(
      `UPDATE updates SET state = 'pr_open', updated_at = ? WHERE id = ? AND state = 'detected'`,
    )
    for (const m of group.members) {
      link.run(prId, m.id)
      mark.run(now, m.id)
    }
    // A draft written for the retired target describes a diff that no longer exists, and
    // the row alone would keep the proposal pass from ever drafting for the new one.
    db.prepare(`DELETE FROM proposals WHERE pr_id = ?`).run(prId)
    // An instruction is somebody's sentence, so it is marked rather than deleted. The
    // branch was just rebuilt from main, which threw away whatever was written for them
    // -- and a ledger still reading `done` next to a branch that no longer carries the
    // change is how shipshape ends up having told them it did something it did not.
    //
    // Marked `stale`, not requeued: re-running the instruction against a rebuilt branch
    // would be acting on a sentence written about a different diff. The retarget note
    // says so and they can ask again.
    db.prepare(
      `UPDATE instructions SET status = 'stale'
        WHERE pr_id = ? AND status IN ('new', 'working', 'done')`,
    ).run(prId)
    // ...and a hold does not survive a target change either: it was about the version
    // that is no longer here.
    db.prepare(`UPDATE prs SET hold_reason = NULL, hold_at = NULL WHERE id = ?`).run(prId)
    return true
  })()
}

/**
 * Bring the labels back in line with what the pull request now carries.
 *
 * Removals are named one at a time rather than replacing the whole set: a label somebody
 * put on the pull request by hand is theirs, and `setLabels` would take it off. The
 * analysis labels go because the verdict they described was about the old target --
 * whatever replaces them is written by the verdict that lands next.
 */
async function relabel(number: number, group: UpdateGroup): Promise<void> {
  const { owner, repo } = repoParts()
  const magnitude = foldGroupMagnitude(group.members.map((m) => m.magnitude as Magnitude))
  const stale = ['major', 'minor', 'patch', 'digest'].filter((l) => l !== magnitude)
  for (const name of [...stale, 'review-block', 'review-hold', 'claude-block', 'claude-hold', 'proposed-changes']) {
    await gh()
      .rest.issues.removeLabel({ owner, repo, issue_number: number, name })
      .catch(() => {})
  }
  await gh()
    .rest.issues.addLabels({
      owner,
      repo,
      issue_number: number,
      labels: ['image-update', magnitude, 'needs-review'],
    })
    .catch(() => {})
}

/**
 * Retire the overtaken pull requests that could not be moved.
 *
 * Takes its candidates rather than selecting them: `settleOvertaken` has already tried
 * each one and knows which are left, and re-running the query here would pick up the ones
 * it just repointed -- which are no longer superseded at all, but only because a write
 * that happened moments ago says so.
 */
export async function closeSupersededPrs(candidates: SupersededPr[]): Promise<number> {
  if (candidates.length === 0) return 0

  const { owner, repo } = repoParts()
  const db = getDb()
  let closed = 0
  // ensureWorkRepo fetches over the network every call, so resolve it once and only if
  // something actually needs its branch deleted -- a pass that finds only user-owned
  // candidates should cost no git at all.
  let workRepo: string | null = null

  for (const pr of candidates) {
    const next = successorFor(pr.id)
    try {
      if (pr.user_owned) {
        // Their branch, their call. Say it once and leave it.
        if (await alreadyNoted(pr.number)) continue
        await gh().rest.issues.createComment({
          owner,
          repo,
          issue_number: pr.number,
          body: supersededNote(next, true),
        })
        logEvent({
          level: 'info',
          kind: 'pr',
          message: `#${pr.number} is superseded but is yours`,
          detail: 'left open; rebase it onto the new target or close it',
        })
        continue
      }

      await gh().rest.issues.createComment({
        owner,
        repo,
        issue_number: pr.number,
        body: supersededNote(next, false),
      })
      await gh().rest.pulls.update({ owner, repo, pull_number: pr.number, state: 'closed' })

      // Best effort. The pull request is closed either way, and a left-behind branch is
      // cosmetic -- whereas failing here would retry the whole close every poll.
      workRepo ??= await ensureWorkRepo()
      await git(workRepo, ['push', httpsUrl(), '--delete', pr.branch], {
        remote: true,
        allowFail: true,
      })

      db.prepare(`UPDATE prs SET state = 'closed' WHERE id = ?`).run(pr.id)
      closed++

      const detail = next
        ? next.number
          ? `superseded by ${next.toTag} in #${next.number}`
          : `superseded by ${next.toTag}`
        : 'superseded'
      logEvent({ level: 'info', kind: 'pr', message: `#${pr.number} closed as superseded`, detail })
      await routine({
        category: 'superseded',
        summary: `#${pr.number} closed — ${detail}`,
        url: `https://github.com/${env.githubRepo}/pull/${pr.number}`,
      })
    } catch (err) {
      logEvent({
        level: 'warn',
        kind: 'pr',
        message: `could not close superseded #${pr.number}`,
        detail: (err as Error).message.slice(0, 200),
      })
    }
  }
  return closed
}

/** Pending updates that policy says deserve a PR, grouped so companions travel together.
 *  Exported for the tests, which check what never reaches it rather than what does. */
export function eligibleGroups(policy: Policy): UpdateGroup[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT u.id, u.stack, u.service, u.image, u.from_tag, u.to_tag, u.magnitude, u.tier,
              u.detail
       FROM updates u
       WHERE u.state = 'detected'
         AND NOT EXISTS (SELECT 1 FROM pr_updates pu JOIN prs p ON p.id = pu.pr_id
                         WHERE pu.update_id = u.id AND p.state = 'open')
       ORDER BY u.id`,
    )
    .all() as (GroupMember & { detail: string | null })[]

  const wanted = rows.filter((r) =>
    shouldOpenPr({
      tier: r.tier as EffectiveTier,
      magnitude: r.magnitude as Magnitude,
      rolling: r.detail === 'rolling',
    }),
  )
  if (wanted.length === 0) return []

  const services = scanRepo(env.repoDir, policy.exclude_stacks)
  // A fork whose last replay onto this very target conflicted, from this very pin, is
  // left alone: the replay would fail identically every poll. A changed pin or a newer
  // target is a new attempt (FORKS.md, "When a rebase conflicts").
  const candidates = wanted.filter((r) => {
    if (!isFork(r.stack, r.service)) return true
    const conflict = forkConflictFor(r.stack, r.service)
    if (!conflict) return true
    const live = services.find((s) => s.stack === r.stack && s.service === r.service)
    const pinned = /#([0-9a-f]{7,40})$/.exec(live?.buildContext ?? '')?.[1] ?? null
    return !(conflict.toTag === r.to_tag.split('@')[0] && pinned === conflict.sha)
  })
  if (candidates.length === 0) return []

  const { sourceRepoFor, groupLabelFor } = makeLookups(services)
  return groupUpdates(candidates, sourceRepoFor, groupLabelFor)
}

/**
 * Log a standing condition once, and again only when it changes.
 *
 * In-memory rather than in the database on purpose: the point is to keep a *repeating*
 * observation out of the log, and a restart is a good moment to restate one. Keyed by
 * a prefix so the condition can be cleared when it stops being true.
 */
const noted = new Map<string, string>()

function noteOnce(key: string, message: string, detail?: string): void {
  const prefix = key.split(':')[0]!
  if (noted.get(prefix) === key) return
  noted.set(prefix, key)
  logEvent({ level: 'info', kind: 'pr', message, detail })
}

function clearNote(prefix: string): void {
  noted.delete(prefix)
}

function countOpenPrs(): number {
  return (getDb().prepare(`SELECT COUNT(*) c FROM prs WHERE state = 'open'`).get() as { c: number })
    .c
}

/**
 * The branch this group should be written to.
 *
 * Normally the stable name -- the one that lets the pull request on it be retargeted
 * later rather than replaced. The exception is a stale pull request still sitting on that
 * name: one somebody has pushed to, which is left open on purpose and never rewritten.
 * Rather than contend for the branch, the newcomer takes the tag-suffixed form and the
 * two coexist, which is what every overtaken pull request did before retargeting existed.
 */
export function resolveBranch(g: UpdateGroup, retargeting?: number): string {
  const stable = branchFor(g)
  const held = getDb()
    .prepare(`SELECT id FROM prs WHERE branch = ? AND state = 'open'`)
    .get(stable) as { id: number } | undefined
  if (!held || held.id === retargeting) return stable
  return taggedBranchFor(g)
}

/**
 * Write the bump onto `branch` and commit it, returning the new head.
 *
 * Shared by the two callers that produce a branch: opening a pull request and retargeting
 * one. It always cuts from the freshly-fetched origin tip rather than from whatever the
 * work clone happened to be on -- which for a retarget is also what discards the previous
 * target's commit, and any config draft written on top of it.
 *
 * Nothing is logged here. The two ways this fails mean different things to each caller.
 */
/**
 * What `buildBranch` reaches outside the work clone, replaceable so a test can hand it a
 * replay that already happened and a registry that answers.
 */
export interface BuildDeps {
  prepareFork: (input: PrepareForkInput) => Promise<PrepareForkResult>
  /** The digest of an upstream tag, for a fork whose pin carries one. */
  digestFor: (registry: string, repository: string, tag: string) => Promise<string | null>
  /** The upstream repository (`owner/repo`) an image comes from. */
  sourceRepoFor: (m: GroupMember) => Promise<string | null>
}

const realDeps: BuildDeps = {
  prepareFork: realPrepareFork,
  digestFor: headDigest,
  sourceRepoFor: async (m) => {
    const ref = parseImageRef(m.image)
    try {
      const r = await sourceFor(
        { registry: ref.registry, repository: ref.repository },
        { service: { stack: m.stack, service: m.service }, tag: ref.tag ?? m.from_tag },
      )
      return r.repo
    } catch {
      return null
    }
  },
}

export type BuildResult =
  | { ok: true; sha: string; forks: Map<number, ForkPrInfo>; bases: Map<number, BasePrInfo> }
  | { ok: false; alreadyApplied?: boolean; conflict?: boolean; reason: string }

export async function buildBranch(
  repoDir: string,
  group: UpdateGroup,
  branch: string,
  deps: BuildDeps = realDeps,
): Promise<BuildResult> {
  await git(repoDir, ['checkout', '-B', branch, 'origin/main'])
  const forks = new Map<number, ForkPrInfo>()
  const bases = new Map<number, BasePrInfo>()

  for (const m of group.members) {
    const file = composeFileFor(m.stack, m.service)
    if (!file) return { ok: false, reason: `no compose file recorded for ${m.stack}/${m.service}` }

    if (isFork(m.stack, m.service)) {
      const r = await buildForkMember(repoDir, file, m, deps)
      if (!r.ok) return r
      forks.set(m.id, r.info)
      continue
    }

    const dockerfile = baseDockerfileFor(m.stack, m.service)
    if (dockerfile) {
      const r = await buildBaseMember(repoDir, dockerfile, m, deps)
      if (!r.ok) return r
      bases.set(m.id, r.info)
      continue
    }

    const oldRef = m.image
    const newRef = rewriteRef(oldRef, m.to_tag)
    if (!newRef) return { ok: false, reason: `cannot build a new reference from "${m.to_tag}"` }

    const edit = await bumpImage({
      repoDir,
      composeFile: file,
      service: m.service,
      expectedOldRef: oldRef,
      newRef,
    })
    if (!edit.ok) return { ok: false, alreadyApplied: edit.alreadyApplied, reason: edit.reason }
  }

  await git(repoDir, [...authorArgs(), 'commit', '-am', prTitle(group, forks, bases)])
  return { ok: true, sha: (await git(repoDir, ['rev-parse', 'HEAD'])).stdout, forks, bases }
}

/**
 * Our own build's bump: the final stage's `FROM` moves to the new base (compose/dockerfile.ts),
 * and nothing else in the Dockerfile or the compose file changes. A digest pin is kept: the
 * new tag's digest is looked up, and the edit refused rather than written without it.
 */
async function buildBaseMember(
  repoDir: string,
  dockerfile: string,
  m: GroupMember,
  deps: BuildDeps,
): Promise<{ ok: true; info: BasePrInfo } | Extract<BuildResult, { ok: false }>> {
  const who = `${m.stack}/${m.service}`
  const abs = join(repoDir, dockerfile)
  let text: string
  try {
    text = readFileSync(abs, 'utf8')
  } catch (err) {
    return { ok: false, reason: `cannot read ${dockerfile}: ${(err as Error).message}` }
  }
  const next = await upstreamRefAt(m.image, m.to_tag, deps.digestFor)
  if (!next.ok) return { ok: false, reason: `${who}: ${next.reason}` }
  // `m.image` is the base exactly as the final stage named it when this update was found:
  // the same assertion bumpImage makes on an image line. Past it means done; anything
  // else means a person edited the Dockerfile and should look.
  const edit = rewriteFroms(text, m.image, next.ref)
  if (!edit.ok) return { ok: false, alreadyApplied: edit.alreadyApplied, reason: `${dockerfile}: ${edit.reason}` }
  writeFileSync(abs, edit.text)
  const diff = await git(repoDir, ['diff', '--quiet', '--', dockerfile], { allowFail: true })
  if (diff.exitCode === 0) return { ok: false, reason: `${dockerfile}: the edit produced no diff` }
  return { ok: true, info: { dockerfile, fromRef: m.image, toRef: next.ref, lines: edit.count } }
}

/**
 * A fork's bump is a replay of our fixes onto the new release (src/forks/rebase.ts),
 * then the compose edit that moves its pins onto the result (compose/fork-edit.ts) --
 * or, when nothing is left to carry, the edit that puts the plain upstream image back.
 *
 * A conflict is written down and raised as an incident here, because this is where it is
 * found; the pass leaves the update alone afterwards until the pin or the target changes
 * (see `eligibleGroups`). A successful replay clears whatever conflict was recorded.
 */
async function buildForkMember(
  repoDir: string,
  file: string,
  m: GroupMember,
  deps: BuildDeps,
): Promise<{ ok: true; info: ForkPrInfo } | Extract<BuildResult, { ok: false }>> {
  const who = `${m.stack}/${m.service}`
  let text: string
  try {
    text = readFileSync(join(repoDir, file), 'utf8')
  } catch (err) {
    return { ok: false, reason: `cannot read ${file}: ${(err as Error).message}` }
  }
  const targetTag = m.to_tag.split('@')[0]!
  const fromTag = m.from_tag.split('@')[0]!
  const upstreamRef = await upstreamRefAt(m.image, m.to_tag, deps.digestFor)
  if (!upstreamRef.ok) return { ok: false, reason: `${who}: ${upstreamRef.reason}` }

  const read = readForkPin(text, m.service)
  if (!read.ok) {
    // No fork pin to read: retired already -- by an earlier pass, or by hand -- is done,
    // and anything else is a shape to look at.
    const retired = retireFork(text, m.service, { expectedSha: '', upstreamRef: upstreamRef.ref })
    if (!retired.ok && retired.alreadyApplied) return { ok: false, alreadyApplied: true, reason: `${who}: ${retired.reason}` }
    return { ok: false, reason: `${who}: ${read.reason}` }
  }
  const pin = read.pin
  // The same assertion bumpImage makes on an image line: the file must still be where
  // this update was computed from. Past it means done; anywhere else means a person.
  if (sameTag(pin.baseTag, targetTag)) {
    return { ok: false, alreadyApplied: true, reason: `${file} already builds ${m.service} from ${targetTag} (${pin.sha.slice(0, 7)})` }
  }
  if (!sameTag(pin.baseTag, fromTag)) {
    return { ok: false, reason: `${file} now builds ${m.service} from ${pin.baseTag}, expected ${fromTag}` }
  }

  const refs = forkRefs(m.stack, m.service)
  const waitsOn = refs.map((r) => ({ ref: r.ref, state: r.state, releasedIn: r.releasedIn }))
  const upstreamUrl = upstreamUrlFor(await deps.sourceRepoFor(m), refs.map((r) => r.ref))
  if (!upstreamUrl) {
    return {
      ok: false,
      reason: `${who}: no upstream repository is known to rebase onto -- add a shipshape.source label naming it`,
    }
  }
  const prepared = await deps.prepareFork({
    forkUrl: pin.contextUrl,
    upstreamUrl,
    pinnedSha: pin.sha,
    baseTag: pin.baseTag,
    targetTag,
    waitsOn,
    shortLength: pin.shortSha.length,
  })

  switch (prepared.kind) {
    case 'refused':
      return { ok: false, reason: `${who}: ${prepared.reason}` }
    case 'conflict':
      await recordForkConflict(m.stack, m.service, {
        toTag: targetTag,
        sha: pin.sha,
        commit: prepared.commit.sha,
        subject: prepared.commit.subject,
        files: prepared.files,
        detail: prepared.detail,
      })
      return { ok: false, conflict: true, reason: `${who}: ${prepared.detail}` }
    case 'retire':
    case 'bump':
      break
  }

  const edit =
    prepared.kind === 'retire'
      ? retireFork(text, m.service, { expectedSha: pin.sha, upstreamRef: upstreamRef.ref })
      : bumpFork(text, m.service, {
          expectedSha: pin.sha,
          newSha: prepared.sha,
          newTag: targetTag,
          newUpstream: upstreamRef.ref,
        })
  if (!edit.ok) return { ok: false, alreadyApplied: edit.alreadyApplied, reason: `${who}: ${edit.reason}` }
  const landed = await applyForkEdit({ repoDir, composeFile: file, text: edit.text })
  if (!landed.ok) return { ok: false, reason: `${who}: ${landed.reason}` }

  const info: ForkPrInfo = {
    kind: prepared.kind,
    fromSha: pin.sha,
    sha: prepared.kind === 'bump' ? prepared.sha : null,
    tag: prepared.kind === 'bump' ? prepared.tag : null,
    forkUrl: pin.contextUrl,
    upstreamRef: upstreamRef.ref,
    carried: prepared.kind === 'bump' ? prepared.carried : [],
    dropped: prepared.dropped,
    waitsOn,
  }
  recordForkPrepared(m.stack, m.service, { ...info, waitsOn, forkUrl: pin.contextUrl, toTag: targetTag })
  await clearForkConflict(m.stack, m.service)
  return { ok: true, info }
}

/** The same version in either spelling (`v3.5.1` / `3.5.1`), or the same string. */
function sameTag(a: string, b: string): boolean {
  if (a === b) return true
  const ka = versionKey(a)
  const kb = versionKey(b)
  return !!ka && !!kb && sameVersion(ka, kb)
}

/**
 * The upstream reference at the new version: the tag, keeping a digest pin when the
 * current reference has one. A `to_tag` that carries its own digest is used as is; one that
 * does not, on a digest-pinned upstream, has its digest looked up -- and the edit is refused
 * rather than written without the pin when the registry does not answer.
 */
export async function upstreamRefAt(
  currentRef: string,
  toTag: string,
  digestFor: BuildDeps['digestFor'],
): Promise<{ ok: true; ref: string } | { ok: false; reason: string }> {
  const ref = parseImageRef(currentRef)
  const at = toTag.indexOf('@')
  if (at !== -1 || !ref.digest) {
    const out = rewriteRef(currentRef, toTag)
    return out ? { ok: true, ref: out } : { ok: false, reason: `cannot build a new reference from "${toTag}"` }
  }
  let digest: string | null = null
  try {
    digest = await digestFor(ref.registry, ref.repository, toTag)
  } catch (err) {
    return { ok: false, reason: `could not resolve the digest of ${ref.repository}:${toTag} (${(err as Error).message}); the digest pin would be lost` }
  }
  if (!digest) {
    return { ok: false, reason: `could not resolve the digest of ${ref.repository}:${toTag}; the digest pin would be lost` }
  }
  return { ok: true, ref: formatImageRef(ref, toTag, digest) }
}

async function openPr(repoDir: string, group: UpdateGroup, policy: Policy): Promise<boolean> {
  let branch = resolveBranch(group)
  const members = group.members
  const stack = members[0]!.stack

  const built = await buildBranch(repoDir, group, branch)
  if (!built.ok) {
    // The file already carries this bump -- someone merged it, or a deploy landed it
    // while this pass was queued. Retrying every minute for a change that has already
    // happened is noise, so the update is retired instead. The scan reaches the same
    // conclusion, but not until it next runs.
    if (built.alreadyApplied) return retireGroup(group, built.reason)
    return failGroup(group, built.reason)
  }
  const sha = built.sha
  const title = prTitle(group, built.forks, built.bases)

  let push = await pushBranch(repoDir, branch)
  if (!push.ok && branch !== taggedBranchFor(group)) {
    // Something upstream is sitting on the reusable name that no row of ours accounts
    // for: a commit of ours from a pull request that failed to open after its branch had
    // already gone up, or one a person left behind on a branch they closed.
    //
    // Refusing and moving on is what the old naming could afford, because the name was
    // per-target and the next target got a fresh one. This name belongs to the *service*,
    // so the same refusal would repeat for every update it ever gets again. Falling back
    // to the tag-suffixed name costs nothing but a longer branch -- the pull request
    // opens, and the ref in the way is left exactly as found.
    branch = taggedBranchFor(group)
    await git(repoDir, ['checkout', '-B', branch])
    push = await pushBranch(repoDir, branch)
  }
  if (!push.ok) return failGroup(group, push.reason)

  // After the push, so a registry being slow or down delays the body's links rather
  // than the branch. sourceRepos never throws; unresolved members simply lose theirs.
  const sources = await sourceRepos(group)

  const { owner, repo } = repoParts()
  const created = await gh().rest.pulls.create({
    owner,
    repo,
    base: 'main',
    head: branch,
    title,
    body: prBody(group, policy, sources, built.forks, built.bases),
  })
  const number = created.data.number

  await gh().rest.issues.addLabels({
    owner,
    repo,
    issue_number: number,
    labels: ['image-update', foldGroupMagnitude(members.map((m) => m.magnitude as Magnitude)), 'needs-review'],
  })

  recordPr({ number, branch, sha, groupKey: group.key, memberIds: members.map((m) => m.id) })
  // Recorded per pull request rather than as one "N opened" message at the end of the
  // pass: a pass is an implementation detail of the poll loop, and batching is now the
  // digest's job. Each item names what moved, so the digest can list them.
  const one = members.length === 1 ? members[0]! : null
  await routine({
    category: 'opened',
    stack,
    service: one?.service,
    // The digest prefixes every line with stack/service, so naming the service again
    // here reads as "servarr/radarr: radarr 5.28 -> 5.29". A group has no single
    // service to prefix with, so there the names belong in the summary -- which is what
    // `changeText` does unnamed.
    summary: `${changeText(members)} (#${number})`,
    url: `https://github.com/${env.githubRepo}/pull/${number}`,
  })
  logEvent({
    level: 'info',
    kind: 'pr',
    stack,
    service: members.length === 1 ? members[0]!.service : undefined,
    message: `opened #${number}: ${describe(group)}`,
    detail: members.length > 1 ? `${members.length} services move together` : undefined,
  })
  return true
}

/**
 * May this branch be overwritten, given what is on it upstream?
 *
 * Only when the remote tip is verbatim a commit shipshape pushed and nobody has claimed
 * the branch since. Rows are never deleted from `prs` and `head_sha_pushed` is written on
 * every push shipshape makes, so a tip we recognise is one nobody has touched -- whether
 * its pull request is still open, or was merged or closed months ago.
 *
 * That last part is what keeps a reusable branch name usable. Branch names no longer
 * carry the target tag, so every future update of a service wants the same ref; without
 * recognising our own abandoned tips, one branch left behind by a pull request that was
 * closed by hand would refuse every push for that service from then on.
 *
 * The one case it answers wrongly: a closed pull request whose branch is restored and
 * which is then reopened on GitHub. Nothing tells shipshape -- the poll pass only reads
 * pull requests its own rows call open -- so the tip still looks like an abandoned one of
 * ours and would be overwritten. Reopening a pull request shipshape closed because its
 * target was overtaken is the only way to reach it, and what it costs is a force-push
 * over a commit that is still in the reflog.
 */
export function branchOwnership(branch: string, remoteSha: string): 'ours' | 'theirs' {
  const db = getDb()
  // An open pull request somebody has taken over holds the name outright, whatever is on
  // the tip: they may have pushed and reverted, leaving a sha we would otherwise claim.
  const claimed = db
    .prepare(`SELECT 1 FROM prs WHERE branch = ? AND state = 'open' AND user_owned = 1 LIMIT 1`)
    .get(branch)
  if (claimed) return 'theirs'
  const ours = db
    .prepare(
      `SELECT 1 FROM prs WHERE branch = ? AND head_sha_pushed = ? AND user_owned = 0 LIMIT 1`,
    )
    .get(branch, remoteSha)
  return ours ? 'ours' : 'theirs'
}

/**
 * The arguments that overwrite a branch we have just proved is ours.
 *
 * The lease is spelled out rather than left implicit, and that is the whole point of this
 * function existing. A bare `--force-with-lease` works out what it expects from the
 * remote-tracking ref for the destination -- and these pushes go to a URL rather than to a
 * configured remote, so there is no such ref, nothing to compare against, and git refuses
 * with `stale info`. It rejected the first retarget that ever reached this line.
 *
 * Naming the sha is also the stronger claim of the two. `branchOwnership` has just read
 * that exact tip and recognised it as ours; leasing against it means a push that lands in
 * the moment between the reading and the writing is refused rather than flattened.
 */
export function forcePushArgs(url: string, branch: string, expectedSha: string): string[] {
  return ['push', `--force-with-lease=${branch}:${expectedSha}`, url, branch]
}

async function pushBranch(
  repoDir: string,
  branch: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const remote = await git(repoDir, ['ls-remote', httpsUrl(), `refs/heads/${branch}`], {
    remote: true,
    allowFail: true,
  })
  const remoteSha = remote.stdout.split('\t')[0] ?? ''

  if (remoteSha) {
    // The branch exists upstream. Only overwrite it if it is still exactly what we last
    // pushed -- anything else means a human has been editing it.
    if (branchOwnership(branch, remoteSha) === 'theirs') {
      return {
        ok: false,
        reason: `branch ${branch} has been modified upstream; leaving it alone`,
      }
    }
    const forced = await git(repoDir, forcePushArgs(httpsUrl(), branch, remoteSha), {
      remote: true,
      allowFail: true,
    })
    if (forced.exitCode !== 0) return { ok: false, reason: forced.stderr.slice(0, 200) }
    return { ok: true }
  }

  const pushed = await git(repoDir, ['push', '-u', httpsUrl(), branch], {
    remote: true,
    allowFail: true,
  })
  if (pushed.exitCode !== 0) return { ok: false, reason: pushed.stderr.slice(0, 200) }
  return { ok: true }
}

/**
 * The update turned out to be done already.
 *
 * Not a failure: nothing went wrong and nothing needs a person. Superseding it stops the
 * pull request pass reconsidering it every cycle, which it otherwise would until the
 * next scan noticed the file had moved.
 */
function retireGroup(group: UpdateGroup, reason: string): boolean {
  const db = getDb()
  const now = new Date().toISOString()
  const stmt = db.prepare(
    `UPDATE updates SET state = 'superseded', detail = 'applied elsewhere', updated_at = ?
     WHERE id = ?`,
  )
  db.transaction(() => {
    for (const m of group.members) stmt.run(now, m.id)
  })()
  logEvent({
    level: 'info',
    kind: 'pr',
    stack: group.members[0]!.stack,
    message: 'update already applied',
    detail: reason,
  })
  return false
}

function failGroup(group: UpdateGroup, reason: string): boolean {
  logEvent({
    level: 'warn',
    kind: 'pr',
    stack: group.members[0]!.stack,
    message: 'skipped opening a pull request',
    detail: reason,
  })
  return false
}

function recordPr(opts: {
  number: number
  branch: string
  sha: string
  groupKey: string | null
  memberIds: number[]
}): void {
  const db = getDb()
  const now = new Date().toISOString()
  db.transaction(() => {
    const info = db
      .prepare(
        // Explicitly tag-only: the editor's gates guarantee the commit touched nothing
        // else. A compose-editing feature would set 'modified' here instead.
        `INSERT INTO prs (number, branch, head_sha_pushed, state, group_key, scope, created_at)
         VALUES (?, ?, ?, 'open', ?, 'tag-only', ?)`,
      )
      .run(opts.number, opts.branch, opts.sha, opts.groupKey, now)
    const link = db.prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`)
    const mark = db.prepare(`UPDATE updates SET state = 'pr_open', updated_at = ? WHERE id = ?`)
    for (const id of opts.memberIds) {
      link.run(info.lastInsertRowid, id)
      mark.run(now, id)
    }
  })()
}

// ------------------------------------------------------------------ rendering

/** The group and its versions, named even when it is one service. See `changeText`. */
function describe(g: UpdateGroup): string {
  return changeText(g.members, { named: true }) ?? ''
}

export function prTitle(g: UpdateGroup, forks?: Map<number, ForkPrInfo>, bases?: Map<number, BasePrInfo>): string {
  const m = g.members[0]!
  const names = g.members.map((x) => x.service).join(', ')
  // A retire is still a version change, but "bump" would undersell what the diff does.
  if (forks && g.members.every((x) => forks.get(x.id)?.kind === 'retire')) {
    return `chore(deps): ${m.stack}: retire the ${names} fork, back to upstream ${short(m.to_tag)}`
  }
  // The version in the title is the base's, so the title says it is the base that moves:
  // "bump obsidian-sync 22-slim -> 24-slim" would read as a release of obsidian-sync.
  if (bases && g.members.every((x) => bases.has(x.id))) {
    const base = displayName(parseImageRef(m.image))
    return `chore(deps): ${m.stack}: rebuild ${names} on ${base} ${short(m.from_tag)} -> ${short(m.to_tag)}`
  }
  return `chore(deps): ${m.stack}: bump ${names} ${short(m.from_tag)} -> ${short(m.to_tag)}`
}

/**
 * The upstream repository for each member, resolved before the body is written.
 *
 * Resolving here rather than reading the cache is deliberate. The cache is populated by
 * `analyze()`, which runs a minute *after* the pull request opens, so at this point most
 * images have no row -- and a reference section that said "no upstream resolved" for
 * almost every pull request would be worse than none. Nothing extra is spent: the answer
 * is cached and analysis would have made the identical call moments later.
 *
 * Note it is not read through groups.ts's `sourceRepoFor`, which falls back to the
 * image's own repository path when nothing resolves. That fallback is right for deciding
 * what to group -- two services sharing an image share an identity -- and wrong here,
 * where it would render as a GitHub link that 404s.
 */
async function sourceRepos(g: UpdateGroup): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>()
  for (const m of g.members) {
    const ref = parseImageRef(m.image)
    try {
      const r = await sourceFor(
        { registry: ref.registry, repository: ref.repository },
        { service: { stack: m.stack, service: m.service }, tag: ref.tag ?? m.from_tag },
      )
      out.set(m.id, r.repo)
    } catch {
      // A pull request must open whether or not a registry is reachable. Links are the
      // one part of it that is genuinely optional.
      out.set(m.id, null)
    }
  }
  return out
}


/** The Dockerfile of our own build watched through its base image, or null (compose/scan.ts). */
export function baseDockerfileFor(stack: string, service: string): string | null {
  const row = getDb()
    .prepare(`SELECT base_dockerfile FROM images WHERE stack = ? AND service = ?`)
    .get(stack, service) as { base_dockerfile: string | null } | undefined
  return row?.base_dockerfile ?? null
}

/** Whether the compose file runs our own build of this service's upstream image. */
export function isFork(stack: string, service: string): boolean {
  const row = getDb()
    .prepare(`SELECT fork_upstream FROM images WHERE stack = ? AND service = ?`)
    .get(stack, service) as { fork_upstream: string | null } | undefined
  return !!row?.fork_upstream
}

function composeFileFor(stack: string, service: string): string | null {
  const row = getDb()
    .prepare(`SELECT compose_file FROM images WHERE stack = ? AND service = ?`)
    .get(stack, service) as { compose_file: string } | undefined
  return row?.compose_file ?? null
}

function rewriteRef(currentRef: string, toTag: string): string | null {
  const ref = parseImageRef(currentRef)
  const at = toTag.indexOf('@')
  if (at === -1) return formatImageRef(ref, toTag, null)
  const tag = toTag.slice(0, at) || ref.tag
  return formatImageRef(ref, tag, toTag.slice(at + 1))
}
