import { env } from '../config.ts'
import { getDb } from '../db.ts'

/**
 * A change record is a `prs` row. v1 rows are GitHub pull requests (`kind = 'github'`,
 * squash-merged); v2 rows are branches shipshape merged into main itself
 * (`kind = 'local'`, `number = 0`, merged with a merge commit). These helpers are the one
 * place that knows the difference, so callers never test `number` or `kind` themselves.
 */

export type ChangeKind = 'github' | 'local'

export function changeKind(prId: number | null | undefined): ChangeKind {
  if (prId == null) return 'github'
  const row = getDb().prepare(`SELECT kind FROM prs WHERE id = ?`).get(prId) as { kind: string } | undefined
  return row?.kind === 'local' ? 'local' : 'github'
}

/** How the change landed on main, which decides how it is reverted. */
export function mergeMethodFor(prId: number | null | undefined): 'merge' | 'squash' {
  return changeKind(prId) === 'local' ? 'merge' : 'squash'
}

/** Where to read the change: a pull request page, or the merge commit. */
export function changeUrl(prId: number | null | undefined): string | undefined {
  if (prId == null || !env.githubRepo) return undefined
  const row = getDb().prepare(`SELECT kind, number, merge_commit_sha FROM prs WHERE id = ?`).get(prId) as
    | { kind: string; number: number; merge_commit_sha: string | null }
    | undefined
  if (!row) return undefined
  if (row.kind === 'local') return row.merge_commit_sha ? `https://github.com/${env.githubRepo}/commit/${row.merge_commit_sha}` : undefined
  return `https://github.com/${env.githubRepo}/pull/${row.number}`
}

/** `#12` for a pull request, `the change` for a local one. */
export function changeLabel(prId: number | null | undefined, number?: number | null): string {
  if (changeKind(prId) === 'local') return 'the change'
  return number ? `#${number}` : 'the change'
}
