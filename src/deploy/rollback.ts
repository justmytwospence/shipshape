import { authorArgs, git, withGitLock } from '../gitops/repo.ts'
import { env, loadPolicy } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { notify } from '../notify/index.ts'
import { deploy, manualCommand, type DeployTarget } from './run.ts'
import type { Verdict } from './verify.ts'

/**
 * Putting the previous version back.
 *
 * Every tool in this space that can undo a bad deploy does it by replaying a state it
 * recorded beforehand -- Swarm keeps a PreviousSpec, Kamal keeps the old containers,
 * Argo keeps the stable ReplicaSet. The equivalent here is the commit that caused the
 * change, which git already stores perfectly: reverting it restores the compose file to
 * the tag that was running, and `up -d` converges the host onto it.
 *
 * The alternative -- an override file pinning the previous image digest -- was rejected.
 * It is faster by about ten seconds and creates exactly the git-versus-runtime drift
 * this repository has been burned by: the override lives only in shipshape's head, so
 * the next `bin/homelab up`, the next hand-run compose, or the next scan would quietly
 * converge the service back onto the broken tag.
 *
 * The revert is committed locally and deployed immediately; pushing happens afterwards
 * through the normal sync. The old image's layers are still on disk, so the restore is
 * a recreate rather than a pull, and the service is back before GitHub has been told
 * anything. That ordering is deliberate: nothing about recovery should wait on a
 * network round trip.
 *
 * **One attempt, ever.** A rollback that fails is a person's problem, announced at the
 * loudest priority available. Swarm encodes the same rule by restricting
 * `--rollback-failure-action` to pause or continue -- there is no recursive rollback,
 * because a machine that keeps trying to fix itself in a loop is worse than one that
 * stops and says so.
 */

export interface RollbackPlan {
  /** `auto` acts now; `suggest` only tells the operator; `none` means say nothing extra. */
  action: 'auto' | 'suggest'
  reason: string
}

/**
 * Whether this failure may be undone unattended.
 *
 * Pure, so the gate is testable. Auto-rollback is refused -- downgraded to a suggestion
 * -- whenever undoing the change would mean undoing something a person wrote, or when
 * the evidence is not solid enough to justify rewriting main on its own.
 */
export function rollbackPlan(opts: {
  mode: 'auto' | 'suggest' | 'off'
  scope: string
  mergeSha: string | null
  mergeMethod: string
  verdict: Verdict
}): RollbackPlan | null {
  if (opts.mode === 'off') return null
  if (opts.verdict.kind === 'error') return null // never act on a blind verifier
  if (opts.verdict.kind !== 'failed') return null

  if (!opts.mergeSha) {
    return { action: 'suggest', reason: 'the merge commit was not recorded' }
  }
  if (opts.scope !== 'tag-only') {
    // A drafted or hand-edited pull request carries work nobody asked shipshape to
    // undo. Reverting it unattended would throw away someone's afternoon.
    return { action: 'suggest', reason: 'the pull request carried more than an image line' }
  }
  return { action: opts.mode === 'auto' ? 'auto' : 'suggest', reason: 'verification failed' }
}

/** The revert invocation for a given merge style. */
export function revertCommand(sha: string, mergeMethod: string): string[] {
  // A true merge commit has two parents, so git has to be told which side to keep.
  // Squash and rebase merges are ordinary single-parent commits.
  return mergeMethod === 'merge'
    ? ['revert', '--no-edit', '-m', '1', sha]
    : ['revert', '--no-edit', sha]
}

export interface RollbackResult {
  ok: boolean
  detail: string
  revertSha?: string
}

/** Revert the merge in the live checkout and bring the previous version back up. */
export async function performRollback(
  target: DeployTarget,
  mergeSha: string,
  mergeMethod: string,
): Promise<RollbackResult> {
  const repo = env.repoDir

  const gitPart = await withGitLock('rollback', async (): Promise<RollbackResult> => {
    const contains = await git(repo, ['merge-base', '--is-ancestor', mergeSha, 'HEAD'], {
      allowFail: true,
    })
    if (contains.exitCode !== 0) {
      return { ok: false, detail: `the checkout does not contain ${mergeSha.slice(0, 8)}` }
    }
    const rv = await git(repo, [...authorArgs(), ...revertCommand(mergeSha, mergeMethod)], {
      allowFail: true,
    })
    if (rv.exitCode !== 0) {
      // Leave nothing half-applied: a conflicted revert sitting in the tree would stop
      // the sync loop and every future deploy.
      await git(repo, ['revert', '--abort'], { allowFail: true })
      return { ok: false, detail: `revert failed: ${rv.stderr.slice(0, 200)}` }
    }
    const head = await git(repo, ['rev-parse', 'HEAD'], { allowFail: true })
    return { ok: true, detail: 'reverted', revertSha: head.stdout.trim().slice(0, 8) }
  })

  if (!gitPart.ok) return gitPart

  // Deploy the reverted tree straight away. The image it wants is the one that was
  // running minutes ago, so its layers are local and this is a recreate, not a pull.
  const back = await deploy(target, { skipBlackout: true })
  if (!back.ok) {
    return { ok: false, detail: `reverted ${gitPart.revertSha}, but the redeploy failed: ${back.reason}` }
  }
  if (!back.healthy) {
    return { ok: false, detail: `reverted ${gitPart.revertSha}, but the previous version did not come back healthy` }
  }
  return { ok: true, detail: `rolled back to the previous version`, revertSha: gitPart.revertSha }
}

/**
 * Decide, act, and say what happened.
 *
 * Returns true when the tree no longer carries the change, which is what tells the
 * caller whether the update should be tombstoned as failed.
 */
export async function handleFailure(opts: {
  prNumber: number
  prId: number
  target: DeployTarget
  verdict: Verdict
  logs: string
}): Promise<{ rolledBack: boolean }> {
  const { policy } = loadPolicy()
  const row = getDb()
    .prepare(`SELECT merge_commit_sha, scope FROM prs WHERE id = ?`)
    .get(opts.prId) as { merge_commit_sha: string | null; scope: string } | undefined

  const plan = rollbackPlan({
    mode: policy.deploy.rollback,
    scope: row?.scope ?? 'tag-only',
    mergeSha: row?.merge_commit_sha ?? null,
    mergeMethod: policy.merge_method,
    verdict: opts.verdict,
  })

  const tail = opts.logs ? `\n\n${opts.target.stack} log:\n${opts.logs.split('\n').slice(-15).join('\n')}` : ''
  const url = `https://github.com/${env.githubRepo}/pull/${opts.prNumber}`

  if (!plan || plan.action === 'suggest') {
    await notify({
      title: `shipshape: ${opts.target.stack} failed verification`,
      body:
        `#${opts.prNumber}: ${opts.verdict.detail}\n\n` +
        (plan ? `Not rolled back automatically — ${plan.reason}.\n\n` : '') +
        `Roll back by hand:\n  git revert ${row?.merge_commit_sha?.slice(0, 8) ?? '<merge>'}\n  ${manualCommand(opts.target).split('\n').join('\n  ')}` +
        tail,
      priority: 5,
      tags: ['rotating_light'],
      click: url,
    })
    return { rolledBack: false }
  }

  const result = await performRollback(
    opts.target,
    row!.merge_commit_sha!,
    policy.merge_method,
  )

  if (result.ok) {
    logEvent({
      level: 'warn',
      kind: 'deploy',
      stack: opts.target.stack,
      message: `${opts.target.stack} failed verification and was rolled back`,
      detail: `${opts.verdict.detail} — revert ${result.revertSha}`,
    })
    await notify({
      // Priority 4, not 5: the lab put itself back. Loud, but not "get up now".
      title: `shipshape: ${opts.target.stack} failed and was rolled back`,
      body:
        `#${opts.prNumber}: ${opts.verdict.detail}\n\n` +
        `Rolled back and healthy again. main carries revert ${result.revertSha}.\n\n` +
        `This version will not be offered again. Use Try again on the update page to re-land it.` +
        tail,
      priority: 4,
      tags: ['rotating_light'],
      click: url,
    })
    return { rolledBack: true }
  }

  logEvent({
    level: 'error',
    kind: 'deploy',
    stack: opts.target.stack,
    message: `rollback of ${opts.target.stack} failed`,
    detail: result.detail,
  })
  await notify({
    title: `shipshape: ${opts.target.stack} is DOWN — rollback failed`,
    body:
      `#${opts.prNumber} failed verification (${opts.verdict.detail}) and the previous ` +
      `version would not come back.\n\n${result.detail}\n\nRecover by hand:\n  cd ${env.repoDir}\n  ${manualCommand(opts.target).split('\n').join('\n  ')}` +
      tail,
    priority: 5,
    tags: ['rotating_light'],
    click: url,
  })
  return { rolledBack: result.detail.includes('reverted') }
}
