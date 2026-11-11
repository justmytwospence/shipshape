import { Octokit } from 'octokit'
import { env } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { resolveIncident } from '../notify/index.ts'
import { ensureWorkRepo, git, httpsUrl, withGitLock } from './repo.ts'

/**
 * The one-time move from pull requests to merge commits (v2).
 *
 * v1 left a pull request open for every update that was not merged yet. v2 has no pull
 * requests, so on the first tick after the upgrade each one is closed with a comment
 * saying where the update went, its branch is deleted (only when shipshape wrote it and
 * nobody has pushed to it since), and its updates go back to `detected` so the ship pass
 * decides them afresh. Drafted config changes on those branches are discarded; they are
 * drafted again, locally.
 *
 * Guarded by a row in `budgets`, written only when every pull request was handled, so a
 * GitHub hiccup retries on the next tick rather than half-completing forever.
 */

const GUARD = 'cutover.v2'

let octokit: Octokit | null = null
function gh(): Octokit {
  octokit ??= new Octokit({ auth: env.githubToken })
  return octokit
}

export const CUTOVER_COMMENT =
  'Shipshape no longer uses pull requests. This update continues in shipshape and lands on main ' +
  'as a merge commit; there is nothing to do here.'

/**
 * May this branch be deleted, given what is on it upstream? Only when the remote tip is
 * verbatim a commit shipshape pushed and nobody has claimed the branch since.
 */
export function branchOwnership(branch: string, remoteSha: string): 'ours' | 'theirs' {
  const db = getDb()
  const claimed = db
    .prepare(`SELECT 1 FROM prs WHERE branch = ? AND state = 'open' AND user_owned = 1 LIMIT 1`)
    .get(branch)
  if (claimed) return 'theirs'
  const ours = db
    .prepare(`SELECT 1 FROM prs WHERE branch = ? AND head_sha_pushed = ? AND user_owned = 0 LIMIT 1`)
    .get(branch, remoteSha)
  return ours ? 'ours' : 'theirs'
}

export function cutoverDone(): boolean {
  return !!getDb().prepare(`SELECT 1 FROM budgets WHERE key = ?`).get(GUARD)
}

export async function runCutover(): Promise<{ closed: number; failed: number; done: boolean }> {
  if (cutoverDone()) return { closed: 0, failed: 0, done: true }
  const db = getDb()
  const open = db
    .prepare(`SELECT id, number, branch FROM prs WHERE kind = 'github' AND state = 'open' ORDER BY number`)
    .all() as { id: number; number: number; branch: string }[]

  let closed = 0
  let failed = 0
  if (open.length > 0) {
    if (!env.githubToken) {
      logEvent({ level: 'warn', kind: 'system', message: 'cutover waiting: GITHUB_TOKEN is not set' })
      return { closed, failed: open.length, done: false }
    }
    const [owner, repo] = env.githubRepo.split('/') as [string, string]
    for (const pr of open) {
      try {
        await gh().rest.issues.createComment({ owner, repo, issue_number: pr.number, body: CUTOVER_COMMENT })
        await gh().rest.pulls.update({ owner, repo, pull_number: pr.number, state: 'closed' })
        await deleteBranchIfOurs(pr.branch)
        const now = new Date().toISOString()
        db.transaction(() => {
          db.prepare(`UPDATE prs SET state = 'closed' WHERE id = ?`).run(pr.id)
          db.prepare(
            `UPDATE updates SET state = 'detected', updated_at = ?
              WHERE state = 'pr_open' AND id IN (SELECT update_id FROM pr_updates WHERE pr_id = ?)`,
          ).run(now, pr.id)
          db.prepare(`DELETE FROM proposals WHERE pr_id = ?`).run(pr.id)
        })()
        closed++
      } catch (err) {
        failed++
        logEvent({
          level: 'warn',
          kind: 'system',
          message: `cutover could not close #${pr.number}`,
          detail: (err as Error).message.slice(0, 200),
        })
      }
    }
  }

  // The cards v1 posted per update are gone; the decision cards replace them.
  const cards = db.prepare(`SELECT key FROM incidents WHERE open = 1 AND key LIKE 'shipshape:update:%'`).all() as { key: string }[]
  for (const c of cards) await resolveIncident(c.key)

  if (failed > 0) return { closed, failed, done: false }
  db.prepare(`INSERT OR REPLACE INTO budgets (key, value, window, updated_at) VALUES (?, 1, 'once', ?)`).run(GUARD, new Date().toISOString())
  logEvent({
    level: 'info',
    kind: 'system',
    message: 'moved from pull requests to merge commits',
    detail: `${closed} open pull request(s) closed`,
  })
  return { closed, failed, done: true }
}

async function deleteBranchIfOurs(branch: string): Promise<void> {
  await withGitLock('cutover-branch', async () => {
    const repoDir = await ensureWorkRepo()
    const remote = await git(repoDir, ['ls-remote', httpsUrl(), `refs/heads/${branch}`], { remote: true, allowFail: true })
    const sha = remote.stdout.split('\t')[0] ?? ''
    if (!sha || branchOwnership(branch, sha) !== 'ours') return
    await git(repoDir, ['push', httpsUrl(), '--delete', branch], { remote: true, allowFail: true })
  })
}
