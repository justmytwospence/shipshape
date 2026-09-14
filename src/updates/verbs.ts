import { getDb, logEvent } from '../db.ts'
import { loadPolicy } from '../config.ts'
import { setState, type UpdateState } from './state.ts'
import { actionsFor, refusalFor, type ActionContext, type Verb } from './actions.ts'
import { carriedFor, claimJob, linkDeployUpdates, runDeployJob } from '../deploy/queue.ts'
import { performRollback, revertCommand } from '../deploy/rollback.ts'
import { stackPeers, withNamespacePeers, type DeployIo, type DeployTarget } from '../deploy/run.ts'
import { syncMain } from '../gitops/sync.ts'
import { withGitLock } from '../gitops/repo.ts'
import { runAnalysisPass } from '../analyze/run.ts'
import { verdictHolds, type Confidence, type Verdict } from '../policy.ts'

/**
 * The things a person can do to an update.
 *
 * Every one of these was previously either impossible from the interface or a sentence
 * telling you to go and do it in a shell -- including "Try again", which an alert
 * advertised as a button on a page that did not exist. They all go through
 * {@link actionsFor} first, so a stale page cannot make one happen, and they all return a
 * sentence rather than throwing, because the answer to "that is no longer available" is
 * an explanation, not an error page.
 */

export interface VerbResult {
  ok: boolean
  message: string
  /** Set when the verb started something the interface should watch. */
  transient?: boolean
}

export interface UpdateRow {
  id: number
  stack: string
  service: string
  image: string
  from_tag: string
  to_tag: string
  magnitude: string
  tier: string
  state: UpdateState
  detail: string | null
  acked_at: string | null
}

/** Everything a decision needs about one update, in one query. */
export function contextFor(id: number): { row: UpdateRow; ctx: ActionContext } | null {
  const db = getDb()
  const row = db.prepare(`SELECT * FROM updates WHERE id = ?`).get(id) as UpdateRow | undefined
  if (!row) return null

  // The newest pull request, not "an open one": an update that has been through two
  // attempts has two, and joining on open would return neither once both are closed.
  const pr = db
    .prepare(
      `SELECT p.id, p.number, p.state, p.scope, p.user_owned, p.merge_commit_sha, p.hold_reason
         FROM prs p JOIN pr_updates pu ON pu.pr_id = p.id
        WHERE pu.update_id = ? ORDER BY p.id DESC LIMIT 1`,
    )
    .get(id) as
    | {
        id: number
        number: number
        state: string
        scope: string
        user_owned: number
        merge_commit_sha: string | null
        hold_reason: string | null
      }
    | undefined

  const deploy = db
    .prepare(
      `SELECT d.id, d.status FROM deploys d
         JOIN deploy_updates du ON du.deploy_id = d.id
        WHERE du.update_id = ? ORDER BY d.id DESC LIMIT 1`,
    )
    .get(id) as { id: number; status: string } | undefined

  const verdict = db
    .prepare(
      `SELECT error, recommendation, confidence FROM verdicts
       WHERE image = ? AND from_tag = ? AND to_tag = ?`,
    )
    .get(row.image, row.from_tag, row.to_tag) as
    | { error: string | null; recommendation: string | null; confidence: string | null }
    | undefined

  const proposal = pr
    ? (db.prepare(`SELECT id FROM proposals WHERE pr_id = ? LIMIT 1`).get(pr.id) as
        | { id: number }
        | undefined)
    : undefined

  const image = db
    .prepare(`SELECT current_tag FROM images WHERE stack = ? AND service = ?`)
    .get(row.stack, row.service) as { current_tag: string | null } | undefined

  return {
    row,
    ctx: {
      state: row.state,
      detail: row.detail,
      prNumber: pr?.number ?? null,
      prState: (pr?.state as ActionContext['prState']) ?? null,
      prScope: (pr?.scope as ActionContext['prScope']) ?? null,
      userOwned: !!pr?.user_owned,
      mergeCommitSha: pr?.merge_commit_sha ?? null,
      deployStatus: (deploy?.status as ActionContext['deployStatus']) ?? null,
      verdictError: !!verdict?.error,
      hasVerdict: !!verdict && !verdict.error,
      verdictHolds:
        !!verdict &&
        !verdict.error &&
        !!verdict.recommendation &&
        verdictHolds(
          verdict.recommendation as Verdict,
          (verdict.confidence as Confidence | null) ?? null,
          loadPolicy().policy.claude.min_confidence,
        ),
      hasProposal: !!proposal,
      ackedAt: row.acked_at,
      held: pr?.hold_reason ?? null,
      // A digest pin carries `tag@sha`; compare the tag part only.
      atFromTag: image ? image.current_tag === row.from_tag.split('@')[0] : undefined,
    },
  }
}

/** The deploy row this update is currently pointing at, if any. */
function latestDeployId(updateId: number): { id: number; status: string } | null {
  return (getDb()
    .prepare(
      `SELECT d.id, d.status FROM deploys d
         JOIN deploy_updates du ON du.deploy_id = d.id
        WHERE du.update_id = ? ORDER BY d.id DESC LIMIT 1`,
    )
    .get(updateId) ?? null) as { id: number; status: string } | null
}

function targetFor(stack: string, services: string[]): DeployTarget {
  const label = getDb().prepare(`SELECT deploy_label FROM images WHERE stack = ? AND service = ?`)
  const unique = [...new Set(services)]
  return {
    stack,
    // A service pinned into another container's network namespace has to come up with
    // the container it is pinned to, or it survives attached to a namespace that no
    // longer exists: running, listed as up, unreachable.
    services: withNamespacePeers(stack, unique, stackPeers),
    // rm-first if any of them asked for it: the strategy applies to the whole compose
    // invocation, and the safer of the two wins.
    strategy: unique.some(
      (s) => (label.get(stack, s) as { deploy_label: string | null } | undefined)?.deploy_label === 'rm-first',
    )
      ? 'rm-first'
      : 'up',
  }
}

/**
 * The updates a revert of this update's merge takes back: every one its pull request
 * carried, not just the one the button was pressed on.
 *
 * `git revert` undoes the whole commit, so a group's file goes back for every member. Rolling
 * back from one member used to redeploy only that member -- pressed on n8n-import, left
 * stopped from #91, it reverted n8n's line too and never touched n8n, which kept running
 * 2.38.7 and kept reading verified against a file that pinned 2.38.5. A member already
 * overtaken or dismissed is not the revert's to move, and there is no pull request to read
 * for an update that never had one.
 */
function revertedMembers(row: UpdateRow): { id: number; service: string }[] {
  const members = getDb()
    .prepare(
      `SELECT u.id, u.service FROM pr_updates pu JOIN updates u ON u.id = pu.update_id
        WHERE pu.pr_id = (SELECT pr_id FROM pr_updates WHERE update_id = ? ORDER BY pr_id DESC LIMIT 1)
          AND u.stack = ? AND (u.id = ? OR u.state NOT IN ('superseded', 'skipped'))
        ORDER BY u.id`,
    )
    .all(row.id, row.stack, row.id) as { id: number; service: string }[]
  return members.length > 0 ? members : [{ id: row.id, service: row.service }]
}

/**
 * Run a verb. The caller has already decided which one; this checks it is still allowed,
 * does it, and says what happened.
 *
 * Deploys are started but not awaited: bringing a stack up, verifying it and soaking it
 * takes minutes, and the operator's browser must not sit on a request for that long. The
 * interface polls the update instead, which is what the transient flag is for.
 */
export async function runVerb(
  id: number,
  verb: Verb,
  /** The docker the deploy verbs talk to; the real one unless a test says otherwise. */
  opts: { io?: DeployIo } = {},
): Promise<VerbResult> {
  const found = contextFor(id)
  if (!found) return { ok: false, message: 'that update no longer exists' }
  const { row, ctx } = found

  if (!actionsFor(ctx).includes(verb)) {
    return { ok: false, message: refusalFor(verb, ctx) }
  }

  switch (verb) {
    case 'deploy':
      return startQueuedDeploy(row, opts.io)
    case 'redeploy':
      return startRedeploy(row, opts.io)
    case 'retry':
      return retry(row, ctx, opts.io)
    case 'rollback':
      return rollback(row, ctx, opts.io)
    case 'ack':
      return acknowledge(row)
    case 'skip':
      return skipUpdate(row)
    case 'rerun-review':
      return rerunReview(row)
    case 'release-hold':
      return releaseHold(row)
    default:
      // The remaining verbs live where their machinery does: merge and propose in the
      // GitHub routes, open-pr alongside them.
      return { ok: false, message: `${verb} is handled elsewhere` }
  }
}

/**
 * Not this version.
 *
 * Durable: `skipped` is in REFUSED_STATES, so the next scan will not offer it again.
 * That is what makes it the one verb a model may not reach by reading prose -- see
 * `hasSkipToken` in the revision path.
 */
function skipUpdate(row: UpdateRow): VerbResult {
  setState(row.id, 'skipped', 'dismissed')
  logEvent({
    level: 'info',
    kind: 'pr',
    stack: row.stack,
    service: row.service,
    message: `${row.from_tag} -> ${row.to_tag} dismissed by the operator`,
  })
  return { ok: true, message: 'Skipped. It will not be offered again unless you ask for it.' }
}

/**
 * Let go of a pull request you asked shipshape to hold.
 *
 * The other half of a hold, and the reason a hold is a column rather than a state of the
 * comment that asked for it: it lasts until somebody says otherwise, which means there
 * has to be a way to say otherwise. Only clears the standing hold -- an instruction that
 * has not been answered yet still holds, because that one resolves itself.
 */
function releaseHold(row: UpdateRow): VerbResult {
  getDb()
    .prepare(
      `UPDATE prs SET hold_reason = NULL, hold_at = NULL
        WHERE id IN (SELECT pr_id FROM pr_updates WHERE update_id = ?)`,
    )
    .run(row.id)
  logEvent({
    level: 'info',
    kind: 'pr',
    stack: row.stack,
    service: row.service,
    message: 'hold released by the operator',
  })
  return { ok: true, message: 'Released. It can merge on its own again.' }
}

/** Read the changelog again: for a review that failed, or one that never ran. */
function rerunReview(row: UpdateRow): VerbResult {
  // Clear the backoff rather than the row: the attempt count is the history of how hard
  // this changelog has been to read, and somebody asking is not attempt one.
  //
  // A verdict that arrived is flagged rather than deleted, for a reason that is not
  // bookkeeping: with no verdict the gate falls back to static policy and merges, so a
  // deleted block followed by a failed re-read would merge what the block was holding.
  // The old verdict stays in force until a new one replaces it.
  getDb()
    .prepare(
      `UPDATE verdicts
         SET next_attempt_at = NULL,
             rerun_requested_at = CASE WHEN error IS NULL THEN ? ELSE rerun_requested_at END
       WHERE image = ? AND from_tag = ? AND to_tag = ?`,
    )
    .run(new Date().toISOString(), row.image, row.from_tag, row.to_tag)
  void detach(runAnalysisPass(1), 'rerun-review')
  return { ok: true, message: 'Reading the changelog again…' }
}

/** Bring up a merge that has been waiting -- the button `paused` exists to require. */
async function startQueuedDeploy(row: UpdateRow, io?: DeployIo): Promise<VerbResult> {
  const latest = latestDeployId(row.id)
  if (!latest) return { ok: false, message: 'there is no queued deploy for this update' }
  const job = claimJob(latest.id)
  if (!job) return { ok: false, message: 'that deploy is already running' }

  void detach(runDeployJob(job, { io }), `deploy of ${row.stack}`)
  // Said before the outcome is known, so it states the rule rather than promising a start
  // that may not happen.
  return {
    ok: true,
    transient: true,
    message: `Deploying ${row.stack} — anything not running is left stopped.`,
  }
}

/**
 * A rolling tag moved. There is nothing to change in git, so the only way to adopt it is
 * to pull and bring the service up again -- and the only record of it having happened is
 * the deploy row this creates.
 */
async function startRedeploy(row: UpdateRow, io?: DeployIo): Promise<VerbResult> {
  const db = getDb()
  const target = targetFor(row.stack, [row.service])
  const now = new Date().toISOString()

  const info = db
    .prepare(
      `INSERT INTO deploys (pr_number, pr_id, stack, services, strategy, ok, healthy,
                            status, attempts, created_at, trigger)
       VALUES (NULL, NULL, ?, ?, ?, 0, 0, 'pending', 0, ?, 'redeploy')`,
    )
    .run(target.stack, target.services.join(' '), target.strategy, now)
  const deployId = Number(info.lastInsertRowid)
  linkDeployUpdates(deployId, null, [row.id])

  const job = claimJob(deployId)
  if (!job) return { ok: false, message: 'that deploy is already running' }

  void detach(runDeployJob(job, { pull: true, io }), `redeploy of ${row.stack}`)
  return {
    ok: true,
    transient: true,
    message: `Redeploying ${row.stack} — anything not running is left stopped.`,
  }
}

/**
 * Go round again.
 *
 * Two different situations wear the same word. A deploy that failed can simply be run
 * again -- the change is still in the tree. An update that was rolled back or dismissed
 * has to re-enter the pipeline from the top, which means clearing the tombstone that
 * stops the scan re-offering it and letting the next pull request pass pick it up.
 */
async function retry(row: UpdateRow, ctx: ActionContext, io?: DeployIo): Promise<VerbResult> {
  if (row.state === 'merged') {
    const target = targetFor(row.stack, [row.service])
    const now = new Date().toISOString()
    const db = getDb()
    const prId = db
      .prepare(`SELECT pr_id FROM pr_updates WHERE update_id = ? ORDER BY pr_id DESC LIMIT 1`)
      .get(row.id) as { pr_id: number } | undefined
    const info = db
      .prepare(
        `INSERT INTO deploys (pr_number, pr_id, stack, services, strategy, ok, healthy,
                              status, attempts, created_at, trigger)
         VALUES (?, ?, ?, ?, ?, 0, 0, 'pending', 0, ?, 'retry')`,
      )
      .run(ctx.prNumber ?? null, prId?.pr_id ?? null, target.stack, target.services.join(' '), target.strategy, now)
    const deployId = Number(info.lastInsertRowid)
    linkDeployUpdates(deployId, prId?.pr_id ?? null, [row.id])
    const job = claimJob(deployId)
    if (!job) return { ok: false, message: 'that deploy is already running' }
    void detach(runDeployJob(job, { io }), `retry of ${row.stack}`)
    return { ok: true, transient: true, message: `Deploying ${row.stack} again.` }
  }

  // Back to the top of the pipeline. The tier is left as it was: a major that needed a
  // human still needs one.
  setState(row.id, 'detected', 'retry')
  getDb().prepare(`UPDATE updates SET acked_at = NULL WHERE id = ?`).run(row.id)
  logEvent({
    level: 'info',
    kind: 'pr',
    stack: row.stack,
    service: row.service,
    message: `${row.from_tag} -> ${row.to_tag} put back in the queue by the operator`,
    detail: `was ${row.state}`,
  })
  return {
    ok: true,
    message: `Back in the queue. A pull request opens on the next pass.`,
  }
}

/** Put the previous version back, on purpose rather than because verification said so. */
async function rollback(row: UpdateRow, ctx: ActionContext, io?: DeployIo): Promise<VerbResult> {
  const { policy } = loadPolicy()
  const sha = ctx.mergeCommitSha
  if (!sha) return { ok: false, message: 'the merge commit is unknown, so there is nothing to revert' }

  const db = getDb()
  // Everything the revert takes back is deployed from the reverted file, each service read
  // live the same as any deploy: a running sibling goes back to the old version, and one
  // that is not running stays as it is.
  const members = revertedMembers(row)
  const target = targetFor(
    row.stack,
    members.map((m) => m.service),
  )
  const now = new Date().toISOString()
  const info = db
    .prepare(
      `INSERT INTO deploys (pr_number, pr_id, stack, services, strategy, ok, healthy,
                            status, attempts, created_at, started_at, trigger)
       VALUES (?, NULL, ?, ?, ?, 0, 0, 'running', 1, ?, ?, 'rollback')`,
    )
    .run(ctx.prNumber ?? null, target.stack, target.services.join(' '), target.strategy, now, now)
  const deployId = Number(info.lastInsertRowid)
  linkDeployUpdates(
    deployId,
    null,
    members.map((m) => m.id),
  )
  // Roll back applies the rule every deploy does -- it chooses a version, it does not start
  // a service -- with the same exception: what shipshape's own failed attempt left down
  // goes back up. Read now, before this row records a plan of its own.
  const carried = carriedFor(target.stack, target.services, deployId)

  void detach(
    (async () => {
      const result = await performRollback(target, sha, policy.merge_method, {
        carried,
        io,
        record: (p) => {
          db.prepare(`UPDATE deploys SET snapshot = ? WHERE id = ?`).run(JSON.stringify(p), deployId)
        },
      })
      const finished = new Date().toISOString()
      if (result.ok) {
        // `healthy` only when something came up: a rollback that left everything stopped
        // verified nothing, and a healthy row is the one thing that never carries.
        db.prepare(
          `UPDATE deploys SET status = 'rolled-back', ok = 1, healthy = ?, detail = ?, finished_at = ? WHERE id = ?`,
        ).run(result.up && result.up.length === 0 ? 0 : 1, result.detail, finished, deployId)
        for (const m of members) setState(m.id, 'failed', 'rolled back by the operator')
        logEvent({
          level: 'warn',
          kind: 'deploy',
          stack: row.stack,
          service: row.service,
          message: `${row.stack} rolled back to ${row.from_tag} by the operator`,
          detail: result.detail,
        })
        // Publish the revert, or the next scan sees the old tag and offers the update
        // it just undid.
        await withGitLock('post-rollback-sync', () => syncMain())
      } else {
        db.prepare(
          `UPDATE deploys SET status = 'error', detail = ?, finished_at = ? WHERE id = ?`,
        ).run(result.detail, finished, deployId)
        logEvent({
          level: 'error',
          kind: 'deploy',
          stack: row.stack,
          service: row.service,
          message: `rollback of ${row.stack} failed`,
          detail: `${result.detail}. Undo it by hand: ${revertCommand(sha, policy.merge_method).join(' ')}`,
        })
      }
    })(),
    `rollback of ${row.stack}`,
  )

  return {
    ok: true,
    transient: true,
    message: `Reverting ${row.to_tag}. ${row.stack} goes back to ${row.from_tag}; anything not running stays stopped.`,
  }
}

function acknowledge(row: UpdateRow): VerbResult {
  getDb().prepare(`UPDATE updates SET acked_at = ? WHERE id = ?`).run(new Date().toISOString(), row.id)
  return { ok: true, message: 'Acknowledged.' }
}

/**
 * Start work the request must not wait for.
 *
 * A deploy takes minutes; a browser request cannot hold that open, and an unhandled
 * rejection in a detached promise would take the process down with it.
 */
function detach(work: Promise<unknown>, what: string): Promise<void> {
  return work.then(
    () => undefined,
    (err: unknown) => {
      logEvent({
        level: 'error',
        kind: 'deploy',
        message: `${what} threw`,
        detail: (err as Error).message?.slice(0, 300) ?? String(err),
      })
    },
  )
}

