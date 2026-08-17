import { getDb, logEvent } from '../db.ts'
import { env, loadPolicy } from '../config.ts'
import { notify } from '../notify/index.ts'
import { deployForPr, type DeployTarget } from './run.ts'
import { handleFailure } from './rollback.ts'
import { captureLogs, inspectService, projectName } from './probe.ts'
import type { Verdict } from './verify.ts'
import { routine } from '../notify/digest.ts'
import { withGitLock } from '../gitops/repo.ts'
import { syncMain } from '../gitops/sync.ts'

/**
 * The deploy queue, and why a merge needs one.
 *
 * A merge used to be marked in the database and then deployed in the same breath, with
 * no try/catch anywhere on the path. Any throw -- a missing docker binary, a socket
 * permission, the container being restarted mid-deploy -- lost the merge permanently:
 * the pull request was already `merged`, so it had dropped out of the query that finds
 * work, and nothing would ever look at it again. The service stayed on the old image
 * with the new one committed to main, which is precisely the drift this tool exists to
 * remove.
 *
 * So the intent is written down first, in the same transaction that records the merge.
 * After that a crash is survivable: the row is still `pending` and the next tick picks
 * it up. That is the entire point of this module -- everything else here is bookkeeping
 * around that one guarantee.
 *
 * Draining happens after `pollPrs` rather than inside it, so noticing a merge and acting
 * on it are no longer the same step. A deploy that spends five minutes in its verify
 * window used to block the loop from seeing that three other pull requests had merged.
 */

/** Bounded per tick so a backlog drains steadily instead of monopolising one pass. */
const MAX_PER_TICK = 3

/** A `running` row older than this was interrupted rather than being slow. */
const STALE_MS = 30 * 60 * 1000

/** One retry after an interrupted attempt; the second failure is a person's problem. */
const MAX_ATTEMPTS = 2

/** Who asked for this deploy. Only `queue` ever starts on its own. */
export type DeployTrigger = 'queue' | 'operator' | 'redeploy' | 'retry' | 'rollback'

export interface DeployJob {
  id: number
  pr_number: number | null
  stack: string
  services: string
  strategy: 'up' | 'rm-first'
  attempts: number
}

/**
 * Take ownership of a queued deploy, or find that someone else already has.
 *
 * Two things can start a deploy now -- the drain, and an operator pressing the button --
 * and they must never both run compose against the same stack. The claim is the guard:
 * a conditional UPDATE that only one caller can win, because SQLite serialises writers.
 * Losing it is not an error, it means the deploy is already happening.
 */
export function claimJob(id: number): DeployJob | null {
  const db = getDb()
  const claimed = db
    .prepare(
      `UPDATE deploys SET status = 'running', attempts = attempts + 1, started_at = ?
         WHERE id = ? AND status IN ('pending', 'ready')`,
    )
    .run(new Date().toISOString(), id)
  if (claimed.changes === 0) return null
  return db
    .prepare(
      `SELECT id, pr_number, stack, services, strategy, attempts FROM deploys WHERE id = ?`,
    )
    .get(id) as DeployJob
}

/**
 * Record the intent to deploy, inside the caller's transaction.
 *
 * Synchronous and transaction-safe on purpose: it must commit atomically with the row
 * that says the pull request merged, or the guarantee above does not hold.
 */
export function enqueueDeploy(opts: {
  prId: number
  prNumber: number
  target: DeployTarget
  now: string
  /** `ready` waits for the operator; `pending` is picked up by the next drain. */
  status?: 'pending' | 'ready'
  trigger?: DeployTrigger
  updateIds?: number[]
}): void {
  const db = getDb()
  const services = [...new Set(opts.target.services)].join(' ')

  db.transaction(() => {
    // An older intent for the same services is not work to do later, it is work that was
    // replaced: bringing the stack up runs against whatever the checkout says now, so
    // the earlier job would deploy this content under the wrong pull request number.
    db.prepare(
      `UPDATE deploys SET status = 'superseded', detail = ?, finished_at = ?
         WHERE stack = ? AND services = ? AND status IN ('pending', 'ready')`,
    ).run(`overtaken by #${opts.prNumber}`, opts.now, opts.target.stack, services)

    const info = db
      .prepare(
        `INSERT INTO deploys (pr_number, pr_id, stack, services, strategy, ok, healthy,
                              status, attempts, created_at, trigger)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?, 0, ?, ?)`,
      )
      .run(
        opts.prNumber,
        opts.prId,
        opts.target.stack,
        services,
        opts.target.strategy,
        opts.status ?? 'pending',
        opts.now,
        opts.trigger ?? 'queue',
      )

    linkDeployUpdates(Number(info.lastInsertRowid), opts.prId, opts.updateIds)
  })()
}

/**
 * Which updates this deploy carries. Derived from the pull request when there is one --
 * and there is not always: a rolling-tag redeploy and an operator rollback both act on an
 * update with no pull request of their own.
 */
export function linkDeployUpdates(deployId: number, prId?: number | null, ids?: number[]): void {
  const db = getDb()
  const link = db.prepare(
    `INSERT OR IGNORE INTO deploy_updates (deploy_id, update_id) VALUES (?, ?)`,
  )
  const explicit = ids ?? []
  for (const id of explicit) link.run(deployId, id)
  if (explicit.length === 0 && prId != null) {
    const rows = db
      .prepare(`SELECT update_id FROM pr_updates WHERE pr_id = ?`)
      .all(prId) as { update_id: number }[]
    for (const r of rows) link.run(deployId, r.update_id)
  }
}

/** True when there is queued or in-flight work, which keeps the poll loop on its fast cadence. */
export function hasPendingDeploys(): boolean {
  const row = getDb()
    .prepare(`SELECT COUNT(*) c FROM deploys WHERE status IN ('pending','running')`)
    .get() as { c: number }
  return row.c > 0
}

/**
 * Reclaim rows that were mid-flight when the process stopped.
 *
 * A `running` row can only mean one of two things: a deploy is happening right now, or
 * one was happening when shipshape died. The clock distinguishes them, since no deploy
 * legitimately outlives the stale threshold.
 */
function reclaimStale(): void {
  const db = getDb()
  const cutoff = new Date(Date.now() - STALE_MS).toISOString()
  const stuck = db
    .prepare(`SELECT id, pr_number, attempts FROM deploys WHERE status = 'running' AND started_at < ?`)
    .all(cutoff) as { id: number; pr_number: number | null; attempts: number }[]

  for (const row of stuck) {
    if (row.attempts >= MAX_ATTEMPTS) {
      db.prepare(`UPDATE deploys SET status = 'error', finished_at = ? WHERE id = ?`).run(
        new Date().toISOString(),
        row.id,
      )
      logEvent({
        level: 'error',
        kind: 'deploy',
        message: `deploy for #${row.pr_number} was interrupted twice and will not be retried`,
        detail: 'run it by hand -- the command is on the pull request',
      })
    } else {
      db.prepare(`UPDATE deploys SET status = 'pending' WHERE id = ?`).run(row.id)
      logEvent({
        level: 'warn',
        kind: 'deploy',
        message: `deploy for #${row.pr_number} was interrupted; retrying`,
      })
    }
  }
}

/** Queued work, oldest first — a merge should not overtake one that landed before it. */
export function dueJobs(limit = MAX_PER_TICK): DeployJob[] {
  return getDb()
    .prepare(
      `SELECT id, pr_number, stack, services, strategy, attempts
       FROM deploys WHERE status = 'pending' ORDER BY created_at, id LIMIT ?`,
    )
    .all(limit) as DeployJob[]
}

export async function drainDeployQueue(): Promise<{ ran: number }> {
  const { policy } = loadPolicy()
  // While paused nothing self-starts. Jobs enqueued before the pause stay pending and
  // resume when it lifts; jobs enqueued during it are `ready` and wait for the button.
  if (policy.paused) return { ran: 0 }

  reclaimStale()
  const jobs = dueJobs()
  if (jobs.length === 0) return { ran: 0 }

  // The queue holds intents, not content: a job says "bring this stack up", and what
  // comes up is whatever the checkout says. So the checkout has to be the merged
  // content first. If it cannot be, the jobs stay pending -- deploying against a stale
  // tree would quietly bring up the version the merge replaced and record it as a
  // success.
  const sync = await withGitLock('pre-deploy-sync', () => syncMain())
  if (sync.status === 'paused' || sync.status === 'refused') {
    logEvent({
      level: 'warn',
      kind: 'deploy',
      message: `${jobs.length} deploy(s) waiting: the checkout could not be updated`,
      detail: sync.reason,
    })
    return { ran: 0 }
  }

  let ran = 0
  for (const job of jobs) {
    // Claim rather than assume: an operator may have pressed Deploy on this very row
    // between `dueJobs` reading it and this line.
    const claimed = claimJob(job.id)
    if (!claimed) continue
    if (await runDeployJob(claimed)) ran++
  }
  return { ran }
}

/**
 * Run one claimed deploy to its conclusion: bring it up, verify it, and record what
 * happened -- including rolling it back when verification says so.
 *
 * The caller must have claimed the row first. Every path through here is caught: one bad
 * deploy must never abandon the rest of the queue, which is the failure this module
 * exists to prevent.
 */
export async function runDeployJob(
  job: DeployJob,
  opts: { pull?: boolean } = {},
): Promise<boolean> {
  const db = getDb()
  const { policy } = loadPolicy()
  let ran = false

  {
    const target: DeployTarget = {
      stack: job.stack,
      services: job.services.split(' ').filter(Boolean),
      strategy: job.strategy,
      pull: opts.pull,
    }
    markUpdates(job.id, 'deploying')

    try {
      const outcome = await deployForPr(job.pr_number ?? 0, target, job.id)
      ran = true

      if (outcome.ok && outcome.healthy) {
        markUpdates(job.id, 'deployed')
        // Passing the window is not the same as being fine. The failures a window misses
        // are the slow ones, so nothing reads `verified` until the soak has also passed.
        const soak = policy.deploy.soak_s
        if (soak > 0) {
          db.prepare(`UPDATE deploys SET recheck_at = ? WHERE id = ?`).run(
            new Date(Date.now() + soak * 1000).toISOString(),
            job.id,
          )
        } else {
          markUpdates(job.id, 'verified')
          db.prepare(`UPDATE deploys SET status = 'verified' WHERE id = ?`).run(job.id)
        }
        await routine({
          category: 'deployed',
          stack: job.stack,
          summary: `#${job.pr_number} deployed — ${outcome.detail}`,
          url: `https://github.com/${env.githubRepo}/pull/${job.pr_number}`,
        })
      } else if (outcome.ok && outcome.verdict?.kind === 'failed') {
        // Verification said no. Everything from here is remediation.
        const logs = await collectLogs(job.stack, target.services, outcome.verdict)
        db.prepare(`UPDATE deploys SET verdict = ?, diagnosis = ? WHERE id = ?`).run(
          JSON.stringify(outcome.verdict),
          JSON.stringify({ logs }),
          job.id,
        )
        const { rolledBack } = await handleFailure({
          prNumber: job.pr_number ?? 0,
          prId: prIdFor(job.id),
          target,
          verdict: outcome.verdict,
          logs,
        })
        // Tombstone only when the tree no longer carries the change. If it still does,
        // the update is still live and re-deploying it is a legitimate retry.
        markUpdates(job.id, rolledBack ? 'failed' : 'merged')
        db.prepare(`UPDATE deploys SET status = ? WHERE id = ?`).run(
          rolledBack ? 'rolled-back' : 'failed',
          job.id,
        )
      } else {
        markUpdates(job.id, 'merged')
      }
    } catch (err) {
      // The row stays `running` and reclaimStale will retry it once. Never rethrow:
      // one bad deploy must not abandon the rest of the queue, which is the failure
      // this module exists to prevent.
      db.prepare(`UPDATE deploys SET status = 'pending', detail = ? WHERE id = ?`).run(
        `attempt failed: ${(err as Error).message.slice(0, 200)}`,
        job.id,
      )
      logEvent({
        level: 'error',
        kind: 'deploy',
        stack: job.stack,
        message: `deploy attempt for #${job.pr_number} threw`,
        detail: (err as Error).message.slice(0, 300),
      })
      if (job.attempts + 1 >= MAX_ATTEMPTS) {
        db.prepare(`UPDATE deploys SET status = 'error', finished_at = ? WHERE id = ?`).run(
          new Date().toISOString(),
          job.id,
        )
        await notify({
          title: `shipshape: deploy of ${job.stack} could not be run`,
          body: `#${job.pr_number}: ${(err as Error).message.slice(0, 300)}\n\nThe merge stands; deploy by hand. The command is on the pull request.`,
          priority: 5,
          tags: ['rotating_light'],
        })
      }
    }
  }
  return ran
}

/**
 * The second look.
 *
 * A deploy that passed its window is `deployed`, not `verified`. The failures a window
 * catches are the fast ones -- a container that will not start, a healthcheck that never
 * goes green. The ones it misses are slow: a leak, a migration that half-finished, a
 * crash on the first real request an hour later. So every passing deploy is looked at
 * once more after the soak, and only then does the update read `verified`.
 *
 * Deliberately never rolls anything back. By this point real state has accrued -- a
 * database has been migrated, files have been written -- and reverting a version that
 * has been serving for half an hour is a decision with consequences a machine should not
 * take alone. It alerts and hands over.
 */
export async function runRechecks(): Promise<{ checked: number }> {
  const db = getDb()
  const due = db
    .prepare(
      `SELECT id, pr_number, stack, services FROM deploys
       WHERE recheck_at IS NOT NULL AND recheck_at <= ? AND status = 'deployed'`,
    )
    .all(new Date().toISOString()) as {
    id: number
    pr_number: number | null
    stack: string
    services: string
  }[]
  if (due.length === 0) return { checked: 0 }

  for (const row of due) {
    const project = projectName(row.stack)
    const services = row.services.split(' ').filter(Boolean)
    const obs = await Promise.all(services.map((svc) => inspectService(project, svc)))
    const bad = obs.filter(
      (o) => !o.found || o.health === 'unhealthy' || o.state === 'restarting' || o.state === 'exited',
    )

    db.prepare(`UPDATE deploys SET recheck_at = NULL WHERE id = ?`).run(row.id)

    if (bad.length === 0) {
      db.prepare(`UPDATE deploys SET status = 'verified' WHERE id = ?`).run(row.id)
      markUpdates(row.id, 'verified')
      logEvent({
        level: 'info',
        kind: 'deploy',
        stack: row.stack,
        message: `${row.stack} verified`,
        detail: `still healthy after the soak`,
      })
      continue
    }

    const detail = bad.map((b) => `${b.service}: ${b.found ? b.state : 'gone'}`).join('; ')
    db.prepare(`UPDATE deploys SET status = 'degraded', detail = ? WHERE id = ?`).run(
      `soak failed — ${detail}`,
      row.id,
    )
    logEvent({
      level: 'error',
      kind: 'deploy',
      stack: row.stack,
      message: `${row.stack} stopped being healthy after the deploy`,
      detail,
    })
    await notify({
      title: `shipshape: ${row.stack} degraded after deploying`,
      body:
        `#${row.pr_number} passed its verify window and has since stopped being healthy.\n\n${detail}\n\n` +
        `Not rolled back: it has been running long enough to have changed state, so undoing it is your call.`,
      priority: 4,
      tags: ['rotating_light'],
    })
  }
  return { checked: due.length }
}

/** True when a soak is due, which keeps the loop awake long enough to run it. */
export function hasDueRechecks(): boolean {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) c FROM deploys WHERE recheck_at IS NOT NULL AND status = 'deployed'`,
    )
    .get() as { c: number }
  return row.c > 0
}

/** The pull request a deploy row belongs to. */
function prIdFor(deployId: number): number {
  const row = getDb().prepare(`SELECT pr_id FROM deploys WHERE id = ?`).get(deployId) as
    | { pr_id: number | null }
    | undefined
  return row?.pr_id ?? 0
}

/**
 * The failing service's own words.
 *
 * An alert that says "unhealthy" and nothing else sends the operator to a terminal to
 * find out what every alert should already have told them. The container has been
 * saying why the whole time; nothing was reading it.
 */
async function collectLogs(
  stack: string,
  services: string[],
  verdict: Verdict,
): Promise<string> {
  const failing =
    verdict.kind === 'failed' || verdict.kind === 'degraded'
      ? [...new Set(verdict.findings.map((f) => f.service))]
      : services
  const project = projectName(stack)
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const parts: string[] = []
  for (const service of failing.slice(0, 2)) {
    const obs = await inspectService(project, service)
    if (obs.healthLog.length > 0) {
      parts.push(`${service} healthcheck:\n${obs.healthLog.join('\n')}`)
    }
    if (obs.id) {
      const logs = await captureLogs(obs.id, since, 60).catch(() => '')
      if (logs.trim()) parts.push(`${service}:\n${logs.trim()}`)
    }
  }
  return parts.join('\n\n').slice(0, 4000)
}

/** Move every update behind a deploy row to the same lifecycle state. */
export function markUpdates(deployId: number, state: string): void {
  getDb()
    .prepare(
      `UPDATE updates SET state = ?, updated_at = ?
       WHERE id IN (SELECT pu.update_id FROM deploys d
                    JOIN pr_updates pu ON pu.pr_id = d.pr_id
                    WHERE d.id = ?)`,
    )
    .run(state, new Date().toISOString(), deployId)
}
