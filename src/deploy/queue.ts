import { getDb, logEvent } from '../db.ts'
import { env, loadPolicy } from '../config.ts'
import { notify } from '../notify/index.ts'
import { deployForPr, type DeployIo, type DeployTarget } from './run.ts'
import { handleFailure } from './rollback.ts'
import { readRecordedPlan, recheckServices } from './runstate.ts'
import {
  captureLogs,
  DockerUnreadable,
  inspectService,
  projectName,
  type ServiceObservation,
} from './probe.ts'
import type { Verdict } from './verify.ts'
import { deployLine, routine } from '../notify/digest.ts'
import { changeText } from '../gitops/body.ts'
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
  trigger: DeployTrigger
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
      `SELECT id, pr_number, stack, services, strategy, attempts, trigger FROM deploys WHERE id = ?`,
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
      `SELECT id, pr_number, stack, services, strategy, attempts, trigger
       FROM deploys WHERE status = 'pending' ORDER BY created_at, id LIMIT ?`,
    )
    .all(limit) as DeployJob[]
}

export async function drainDeployQueue(): Promise<{ ran: number }> {
  // Pause does not gate this any more, and that is deliberate.
  //
  // It used to return here, which meant a merge the operator pressed themselves produced
  // a deploy that then sat waiting for a second press. Pause is about what shipshape may
  // *decide* -- it still stops auto-merge dead (see automerge.ts) -- and a merge is a
  // decision already taken. What is queued here is the carrying out of one, and carrying
  // it out under a health check is safer than leaving it to happen unwatched the next
  // time something recreates the stack.
  //
  // Services that must not be touched without a person present say so for themselves, per
  // service, on the `attended` and on-request rungs: those enqueue as `ready`, which no
  // drain claims. That is now the only thing that holds a deploy back.

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
  opts: { pull?: boolean; io?: DeployIo } = {},
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
    // Where an update goes back to when its deploy did not land. A merge that did not come
    // up is still merged -- the change is in the tree and deploying it again is a retry. A
    // rolling redeploy never merged anything: the tag moved upstream and still has, so it
    // goes back to `detected`, where Redeploy is offered again.
    const notLanded = job.trigger === 'redeploy' ? 'detected' : 'merged'
    // Read before this attempt records a plan of its own, so the only plan of this row it
    // can find is one an interrupted run of it wrote.
    const carried = carriedFor(job.stack, target.services, job.id)
    markUpdates(job.id, 'deploying')

    try {
      const outcome = await deployForPr(job.pr_number ?? 0, target, job.id, {
        carried,
        io: opts.io,
        trigger: job.trigger,
      })
      ran = true

      // The versions, not the timing: `deploys.detail` keeps "up in Ns" for the timeline.
      // The link only when there is a pull request -- a redeploy has none, and used to
      // record "#null deployed" pointing at /pull/null.
      const members = carriedUpdates(job.id)
      const change = changeText(members)
      const service = members.length === 1 ? members[0]!.service : undefined
      const url =
        job.pr_number != null ? `https://github.com/${env.githubRepo}/pull/${job.pr_number}` : undefined
      const leftList = outcome.ok
        ? outcome.left.map((l) => ({ service: l.service, absent: l.state === 'absent' || l.state === 'removing' }))
        : []

      // A service the deploy left is finished with, whatever became of the half that came
      // up: the merge stands and nothing more is owed. Marked first, so every branch below
      // moves only the services it actually brought up.
      if (outcome.ok) markUpdates(job.id, 'left-stopped', { services: outcome.left.map((l) => l.service) })

      if (outcome.ok && outcome.up.length === 0) {
        // Nothing was running, so nothing was started and there is nothing to soak. The
        // line says so under its own heading; a redeploy with no pull request says nothing,
        // since nothing landed and nothing changed.
        const line = deployLine({ prNumber: job.pr_number, change, broughtUp: 0, left: leftList })
        if (line) {
          await routine({ category: line.category, stack: job.stack, service, summary: line.summary, detail: outcome.detail, url })
        }
      } else if (outcome.ok && outcome.healthy) {
        markUpdates(job.id, 'deployed', { services: outcome.up })
        // Passing the window is not the same as being fine. The failures a window misses
        // are the slow ones, so nothing reads `verified` until the soak has also passed.
        const soak = policy.deploy.soak_s
        if (soak > 0) {
          db.prepare(`UPDATE deploys SET recheck_at = ? WHERE id = ?`).run(
            new Date(Date.now() + soak * 1000).toISOString(),
            job.id,
          )
        } else {
          markUpdates(job.id, 'verified', { services: outcome.up })
          db.prepare(`UPDATE deploys SET status = 'verified' WHERE id = ?`).run(job.id)
        }
        const degraded = outcome.verdict?.kind === 'degraded' ? outcome.verdict : null
        const line = deployLine({
          prNumber: job.pr_number,
          change,
          broughtUp: outcome.up.length,
          left: leftList,
          warnings: degraded !== null,
        })
        if (line) {
          await routine({
            category: line.category,
            stack: job.stack,
            service,
            summary: line.summary,
            // The warnings, then a sentence per service left or brought back: the summary
            // names them, and this is where each one says what compose would do.
            detail:
              [degraded ? `with warnings — ${degraded.detail}` : null, ...outcome.notes].filter(Boolean).join('\n') ||
              undefined,
            url,
          })
        }
      } else if (outcome.ok && outcome.verdict?.kind === 'failed') {
        // Verification said no. Everything from here is remediation -- of what came up, and
        // only that: the services left stopped were never touched, so neither their logs
        // nor the command an operator is handed should reach them.
        const upTarget: DeployTarget = { ...target, services: outcome.up }
        const logs = await collectLogs(job.stack, outcome.up, outcome.verdict)
        db.prepare(`UPDATE deploys SET verdict = ?, diagnosis = ? WHERE id = ?`).run(
          JSON.stringify(outcome.verdict),
          JSON.stringify({ logs }),
          job.id,
        )
        const { rolledBack } = await handleFailure({
          prNumber: job.pr_number ?? 0,
          prId: prIdFor(job.id),
          target: upTarget,
          verdict: outcome.verdict,
          logs,
          // The automatic rollback puts back what this attempt brought up, even if the
          // failure took it down: the up-set is known here and no longer in docker.
          carry: new Set(outcome.up),
        })
        // Tombstone only when the tree no longer carries the change. If it still does,
        // the update is still live and re-deploying it is a legitimate retry. A revert
        // takes the whole merge out, the left half with it.
        markUpdates(job.id, rolledBack ? 'failed' : notLanded, rolledBack ? {} : { services: outcome.up })
        db.prepare(`UPDATE deploys SET status = ? WHERE id = ?`).run(
          rolledBack ? 'rolled-back' : 'failed',
          job.id,
        )
      } else {
        markUpdates(job.id, notLanded, outcome.ok ? { services: outcome.up } : {})
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
 *
 * And a look that could not see is not a look. When docker cannot be asked, the soak is
 * postponed rather than decided: this used to read a socket error as every service gone
 * and page the operator that a healthy deploy had degraded.
 */
export async function runRechecks(
  opts: {
    observe?: (project: string, service: string) => Promise<ServiceObservation>
    now?: () => number
  } = {},
): Promise<{ checked: number }> {
  const observe = opts.observe ?? inspectService
  const now = opts.now ?? Date.now
  const db = getDb()
  const due = db
    .prepare(
      `SELECT id, pr_number, stack, services, snapshot FROM deploys
       WHERE recheck_at IS NOT NULL AND recheck_at <= ? AND status = 'deployed'`,
    )
    .all(new Date(now()).toISOString()) as {
    id: number
    pr_number: number | null
    stack: string
    services: string
    snapshot: string | null
  }[]
  if (due.length === 0) return { checked: 0 }

  for (const row of due) {
    const project = projectName(row.stack)
    // What came up, not everything the row names: a member left stopped was never started,
    // and looking at it would call a service nobody touched degraded.
    const services = recheckServices(row.services, row.snapshot)
    let obs: ServiceObservation[]
    try {
      obs = await Promise.all(services.map((svc) => observe(project, svc)))
    } catch (err) {
      if (!(err instanceof DockerUnreadable)) throw err
      // The deploy stays `deployed` and nobody is told anything is wrong, because nothing
      // was seen to be. Five minutes is long enough for a restarting daemon to come back
      // and short enough that the soak still means something when it does.
      db.prepare(`UPDATE deploys SET recheck_at = ? WHERE id = ?`).run(
        new Date(now() + 5 * 60 * 1000).toISOString(),
        row.id,
      )
      logEvent({
        level: 'warn',
        kind: 'deploy',
        stack: row.stack,
        message: `could not ask docker about ${row.stack}; looking again in 5 minutes`,
        detail: err.message,
      })
      continue
    }
    const bad = obs.filter(
      (o) => !o.found || o.health === 'unhealthy' || o.state === 'restarting' || o.state === 'exited',
    )

    db.prepare(`UPDATE deploys SET recheck_at = NULL WHERE id = ?`).run(row.id)

    if (bad.length === 0) {
      db.prepare(`UPDATE deploys SET status = 'verified' WHERE id = ?`).run(row.id)
      markUpdates(row.id, 'verified', { services })
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

/**
 * The updates a deploy row carried, with the versions each moves between.
 *
 * Through `deploy_updates` rather than the pull request, for the same reasons
 * `markUpdates` is: a retry carries one member, and a redeploy has no pull request.
 */
export function carriedUpdates(
  deployId: number,
): { service: string; from_tag: string; to_tag: string }[] {
  return getDb()
    .prepare(
      `SELECT u.service, u.from_tag, u.to_tag
         FROM deploy_updates du JOIN updates u ON u.id = du.update_id
        WHERE du.deploy_id = ? ORDER BY u.id`,
    )
    .all(deployId) as { service: string; from_tag: string; to_tag: string }[]
}

/** Statuses of an attempt that ended without the service healthy on what it brought up. */
const CARRY_FROM = new Set(['failed', 'error', 'rolled-back'])

/**
 * The services shipshape's own earlier attempt left down, which this deploy puts back up
 * unless someone has visibly stopped them since.
 *
 * The rule that a deploy never starts a stopped service needs this one exception, or it
 * reads shipshape's damage back as an operator's decision. minuspod #79 and #93 are the
 * shape: both deploys (rows 23 and 24) were rm-first, removed the old container, and
 * failed mid-"Recreate", leaving minuspod DOWN. The next merge on minuspod, and Try again
 * on the DOWN alert that asked for exactly that, would both find no container and leave
 * it down, reporting "left stopped (no container)" about an outage shipshape caused.
 *
 * So, per service, the newest recorded plan that names it -- up or left -- decides. It is
 * carried when that plan brought it up, and either the plan is this very row (an attempt
 * interrupted after recording, now re-run) or the attempt failed with nothing healthy on
 * it: `failed`, `error`, or `rolled-back` with `healthy = 0`. Newest-that-names-it is what
 * breaks the chain: a later plan that verified it, or left it stopped, is the later word.
 * An operator rollback that came back healthy never carries, and neither do rows with no
 * plan -- legacy rows, refusals, and attempts docker could not be asked about.
 *
 * Carried does not mean started regardless: `planRun` still leaves a carried service that
 * is paused, removing, or exited under a restart policy that would otherwise be restarting
 * it, because that is someone stopping it after shipshape's attempt.
 */
export function carriedFor(stack: string, services: readonly string[], deployId: number): Set<string> {
  const rows = getDb()
    .prepare(
      `SELECT id, status, healthy, snapshot FROM deploys
        WHERE stack = ? AND id <= ? AND snapshot IS NOT NULL
        ORDER BY id DESC LIMIT 50`,
    )
    .all(stack, deployId) as { id: number; status: string; healthy: number; snapshot: string }[]
  const plans = rows.flatMap((row) => {
    const plan = readRecordedPlan(row.snapshot)
    return plan ? [{ row, plan }] : []
  })

  const out = new Set<string>()
  for (const s of new Set(services)) {
    const newest = plans.find(({ plan }) => plan.up.includes(s) || plan.left.some((l) => l.service === s))
    if (!newest || !newest.plan.up.includes(s)) continue
    if (newest.row.id === deployId || (CARRY_FROM.has(newest.row.status) && newest.row.healthy === 0)) {
      out.add(s)
    }
  }
  return out
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
    // Diagnosis is a courtesy on an alert that is going out regardless. A docker that
    // cannot be read here costs this service's logs, never the alert or the rollback.
    let obs: ServiceObservation
    try {
      obs = await inspectService(project, service)
    } catch {
      continue
    }
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

/**
 * Move the updates a deploy carried to a lifecycle state.
 *
 * It follows `deploy_updates` -- what this row carried -- and not the pull request the row
 * belongs to. Those were treated as the same thing, and they are not. A retry links the
 * one update it was pressed on, so marking through the pull request moved every sibling
 * in its group as well. A redeploy of a rolling tag has no pull request at all, so it
 * moved nothing, and the update never left the state it was pressed in. And a deploy
 * that brings up only part of a group has to move its services separately, which a join
 * on the pull request cannot say.
 *
 * `services` narrows it to the updates for those services. An empty list moves nothing:
 * a caller that brought no service up must never be read as meaning all of them.
 */
export function markUpdates(
  deployId: number,
  state: string,
  opts: { services?: readonly string[] } = {},
): void {
  if (opts.services && opts.services.length === 0) return
  const list = opts.services ? JSON.stringify([...opts.services]) : null
  getDb()
    .prepare(
      `UPDATE updates SET state = ?, updated_at = ?
        WHERE id IN (SELECT du.update_id FROM deploy_updates du JOIN updates u ON u.id = du.update_id
                      WHERE du.deploy_id = ? AND (? IS NULL OR u.service IN (SELECT value FROM json_each(?))))`,
    )
    .run(state, new Date().toISOString(), deployId, list, list)
}
