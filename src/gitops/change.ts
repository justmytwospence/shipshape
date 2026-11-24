import { env } from '../env.ts'
import { getDb } from '../db/index.ts'

/**
 * A change record is a `prs` row: a branch shipshape merged into the published branch
 * itself, with a merge commit. (The table keeps its v1 name.)
 */

/** Where to read the change: its merge commit on the remote's web page, when there is one. */
export function changeUrl(prId: number | null | undefined): string | undefined {
  if (prId == null) return undefined
  const row = getDb().prepare(`SELECT merge_commit_sha FROM prs WHERE id = ?`).get(prId) as
    | { merge_commit_sha: string | null }
    | undefined
  // `/commit/<sha>` resolves on GitHub, Gitea, Forgejo and, by redirect, GitLab.
  const web = env.gitRemote.webUrl
  return web && row?.merge_commit_sha ? `${web}/commit/${row.merge_commit_sha}` : undefined
}
