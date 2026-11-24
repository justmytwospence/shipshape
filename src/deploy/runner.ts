import { env } from '../env.ts'
import { getDb } from '../db/index.ts'
import { logEvent } from '../events.ts'
import { syncMain, type SyncResult } from '../gitops/sync.ts'
import { withGitLock } from '../gitops/repo.ts'
import { background, isStopping } from '../lifecycle.ts'
import { claimJob, runDeployJob, type DeployJob } from './queue.ts'
import type { DeployIo } from './types.ts'

/**
 * The only way a deploy starts.
 *
 * Two things used to start deploys with nothing between them: the queue's drain and an
 * operator pressing a button. The claim on the row stopped them taking the *same* deploy,
 * but not two deploys of the *same stack*, which is what compose cannot tolerate -- two
 * `up -d`s against one project race each other's recreates.
 *
 * So a stack is a try-acquire lock, held for the whole of a deploy, verify window and any
 * rollback included. It is not a queue: a queued lock would put the main tick behind an
 * operator's five-minute verify window. A launch that finds the stack busy, or shipshape
 * stopping, leaves its row `pending` instead, and the drain carries it out once the stack
 * is free. The check and the take happen in one synchronous block, so in one process there
 * is no gap between them.
 */
export type Launch =
  | { started: true }
  | { started: false; queued: true; message: string }
  | { started: false; queued: false; message: string }

const busy = new Set<string>()
const ids = new Set<number>()
const running = new Set<Promise<unknown>>()

export function stackBusy(stack: string): boolean {
  return busy.has(stack)
}

export function inFlightDeployIds(): ReadonlySet<number> {
  return ids
}

const BUSY = (stack: string) => `A deploy of ${stack} is already running; this one is queued and starts after it.`
const STOPPING = 'shipshape is restarting; this deploy is queued and runs once it is back.'

/**
 * Bring the checkout up to date before anything deploys from it. With no checkout
 * configured there is nothing to update, and git must not be run in the working directory.
 */
export async function syncBeforeDeploy(): Promise<SyncResult> {
  if (!env.repoDir) return { status: 'in-sync', sha: '' }
  return withGitLock('pre-deploy-sync', () => syncMain())
}

function release(stack: string, id: number | null): void {
  busy.delete(stack)
  if (id !== null) ids.delete(id)
}

function keep(p: Promise<unknown>): void {
  running.add(p)
  const forget = () => void running.delete(p)
  p.then(forget, forget)
}

/**
 * Claim `deployId` and run it in the background under its stack, after bringing the
 * checkout up to date. A deploy against a stale tree would quietly bring up the version
 * the merge replaced and record it as a success, so a checkout that cannot be updated
 * puts the row back to `pending` with its attempt handed back.
 */
export function launchDeploy(
  deployId: number,
  stack: string,
  opts: { label: string; pull?: boolean; io?: DeployIo; sync?: () => Promise<SyncResult> },
): Launch {
  if (isStopping() || busy.has(stack)) {
    getDb().prepare(`UPDATE deploys SET status = 'pending' WHERE id = ? AND status = 'ready'`).run(deployId)
    return { started: false, queued: true, message: isStopping() ? STOPPING : BUSY(stack) }
  }
  const job = claimJob(deployId)
  if (!job) return { started: false, queued: false, message: 'that deploy is already running' }

  busy.add(stack)
  ids.add(job.id)
  const work = (async () => {
    try {
      let sync: SyncResult
      try {
        sync = await (opts.sync ?? syncBeforeDeploy)()
      } catch (err) {
        sync = { status: 'refused', reason: (err as Error).message.slice(0, 200) }
      }
      if (sync.status === 'paused' || sync.status === 'refused') {
        getDb()
          .prepare(`UPDATE deploys SET status = 'pending', attempts = attempts - 1, detail = ? WHERE id = ?`)
          .run(`waiting: the checkout could not be updated (${sync.reason})`, job.id)
        logEvent({
          level: 'warn',
          kind: 'deploy',
          stack,
          message: `deploy of ${stack} waiting: the checkout could not be updated`,
          detail: sync.reason,
        })
        return
      }
      await runDeployJob(job, { pull: opts.pull, io: opts.io })
    } finally {
      release(stack, job.id)
    }
  })()
  keep(work)
  background(work, opts.label, 'deploy')
  return { started: true }
}

/** Foreground: an already-claimed job under its stack (the queue drain, which synced once for the batch). */
export async function runClaimedDeploy(job: DeployJob, opts: { pull?: boolean; io?: DeployIo } = {}): Promise<boolean> {
  busy.add(job.stack)
  ids.add(job.id)
  const work = runDeployJob(job, opts)
  keep(work)
  try {
    return await work
  } finally {
    release(job.stack, job.id)
  }
}

/** Background: arbitrary stack work, such as the operator rollback. */
export function launchOnStack(stack: string, label: string, fn: () => Promise<void>): Launch {
  if (isStopping()) return { started: false, queued: false, message: 'shipshape is restarting. Try again once it is back.' }
  if (busy.has(stack)) {
    return { started: false, queued: false, message: `A deploy of ${stack} is running. Try again when it finishes.` }
  }
  busy.add(stack)
  const work = fn().finally(() => release(stack, null))
  keep(work)
  background(work, label, 'deploy')
  return { started: true }
}

/** Resolves when no deploy is in flight. */
export async function deploysIdle(): Promise<void> {
  while (running.size > 0) await Promise.allSettled([...running])
}
