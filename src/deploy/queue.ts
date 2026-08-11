import { getDb, logEvent } from '../db.ts'
import { loadPolicy } from '../config.ts'
import { notify } from '../notify/index.ts'
import { deployForPr, type DeployTarget } from './run.ts'
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

export interface DeployJob {
  id: number
  pr_number: number | null
  stack: string
  services: string
  strategy: 'up' | 'rm-first'
  attempts: number
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
}): void {
  getDb()
    .prepare(
      `INSERT INTO deploys (pr_number, pr_id, stack, services, strategy, ok, healthy,
                            status, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, 'pending', 0, ?)`,
    )
    .run(
      opts.prNumber,
      opts.prId,
      opts.target.stack,
      [...new Set(opts.target.services)].join(' '),
      opts.target.strategy,
      opts.now,
    )
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
  if (policy.deploy.mode !== 'auto') return { ran: 0 }

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

  const db = getDb()
  let ran = 0

  for (const job of jobs) {
    const target: DeployTarget = {
      stack: job.stack,
      services: job.services.split(' ').filter(Boolean),
      strategy: job.strategy,
    }
    db.prepare(
      `UPDATE deploys SET status = 'running', attempts = attempts + 1, started_at = ? WHERE id = ?`,
    ).run(new Date().toISOString(), job.id)
    markUpdates(job.id, 'deploying')

    try {
      const outcome = await deployForPr(job.pr_number ?? 0, target, job.id)
      ran++
      markUpdates(job.id, outcome.ok && outcome.healthy ? 'deployed' : 'merged')
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
  return { ran }
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
