import { getDb } from '../db.ts'
import { sqlIn, type UpdateState } from './state.ts'
import { refLinks, registryName, type RefLinks } from '../links.ts'
import { parseImageRef } from '../images/ref.ts'
import { sourceForSync } from '../resolver/index.ts'
import { type UpdateView, SELECT_UPDATE, type RawUpdate, toView, repoName } from './view.ts'

/**
 * What the pages read.
 *
 * The old dashboard asked one question -- "what is pending" -- and answered it with a
 * table of everything in three states. That is a list of rows, not a worklist: it cannot
 * distinguish an update waiting on a decision from one waiting on a machine, and it stops
 * at the merge, so everything after it (deployed, verified, rolled back) existed only as
 * free text in the log. These queries answer the questions an operator actually has:
 * what needs me, what happened, and what is the whole story of this one update.
 */

// -------------------------------------------------------------- lists & filters

/** The stages the Updates page filters by, and which states each covers. */
export const STAGE_FILTERS = {
  open: ['detected', 'frozen', 'merged'],
  rolling: ['deploying', 'deployed'],
  // Left stopped is merged with nothing more owed by shipshape, so it is finished rather
  // than open -- in Open it would sit in the list and the nav count forever.
  done: ['verified', 'left-stopped'],
  closed: ['failed', 'skipped', 'superseded'],
} as const satisfies Record<string, readonly UpdateState[]>

/**
 * `releases` is not a state filter like the others -- it is the same rows read for a
 * different reason. The stage tabs above answer "what is in my way"; releases answers
 * "what came out", which wants recency rather than the triage order, and every release
 * rather than a slice of the pipeline. It rides on the stage parameter because it is
 * still a way of looking at the updates list, and the alternative -- a second axis in
 * the toolbar, or a seventh destination in a navigation that documents six as its
 * ceiling -- costs more than it explains.
 */
export type StageFilter = keyof typeof STAGE_FILTERS | 'all' | 'releases'

export function listUpdates(opts: { stage?: StageFilter; q?: string; magnitude?: string; limit?: number } = {}): UpdateView[] {
  const stage = opts.stage ?? 'open'
  const where: string[] = []
  const args: unknown[] = []

  if (stage !== 'all' && stage !== 'releases') {
    where.push(`u.state IN ${sqlIn(STAGE_FILTERS[stage])}`)
  }
  if (opts.magnitude && opts.magnitude !== 'all') {
    where.push(`u.magnitude = ?`)
    args.push(opts.magnitude)
  }
  if (opts.q) {
    where.push(`(u.stack LIKE ? OR u.service LIKE ? OR u.image LIKE ?)`)
    const like = `%${opts.q}%`
    args.push(like, like, like)
  }

  const rows = getDb()
    .prepare(
      `${SELECT_UPDATE}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY CASE u.magnitude WHEN 'major' THEN 0 WHEN 'minor' THEN 1 WHEN 'patch' THEN 2 ELSE 3 END,
                u.updated_at DESC
       LIMIT ?`,
    )
    .all(...args, opts.limit ?? 200) as RawUpdate[]
  const repo = repoName()
  return rows.map((r) => toView(r, repo))
}

/**
 * One release, as something to read rather than something to action.
 *
 * Same rows as the updates list, ordered by when they turned up rather than by how big
 * they are, and carrying the outbound links. The links matter most here: they are derived
 * from the image reference and the resolved source repository, so a release has somewhere
 * to send you even when no changelog review ever ran for it -- which is the common case,
 * because reviews are written for pull requests and most updates apply without one.
 */
export interface ReleaseView extends UpdateView {
  links: RefLinks
  /** What to call the registry, for the link that exists when no changelog does. */
  registry: string
}

export function listReleases(
  opts: { q?: string; magnitude?: string; limit?: number } = {},
): ReleaseView[] {
  const where: string[] = []
  const args: unknown[] = []

  if (opts.magnitude && opts.magnitude !== 'all') {
    where.push(`u.magnitude = ?`)
    args.push(opts.magnitude)
  }
  if (opts.q) {
    where.push(`(u.stack LIKE ? OR u.service LIKE ? OR u.image LIKE ?)`)
    const like = `%${opts.q}%`
    args.push(like, like, like)
  }

  // The source comes from the one accessor, with the service's label applied, rather than
  // from a join on the resolution cache -- which is how a labelled service showed a registry
  // link here instead of its release notes. It is keyed by the update's own image reference,
  // so a release whose service has since left the compose file keeps its links. Without a
  // source, refLinks falls back to what the image reference alone can produce, which is the
  // registry rather than the changelog.
  const rows = getDb()
    .prepare(
      `SELECT u.id, u.stack, u.service, u.image, u.from_tag, u.to_tag, u.magnitude, u.tier,
              u.state, u.detail, u.detected_at, u.updated_at, u.acked_at
         FROM updates u
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY u.detected_at DESC, u.id DESC
       LIMIT ?`,
    )
    .all(...args, opts.limit ?? 200) as RawUpdate[]

  const repo = repoName()
  // Most of a feed is the same few services over and over; ask once for each.
  const sources = new Map<string, string | null>()
  return rows.map((r) => {
    const ref = parseImageRef(r.image)
    const key = `${ref.registry}/${ref.repository}|${r.stack}/${r.service}`
    if (!sources.has(key)) {
      const s = sourceForSync(
        { registry: ref.registry, repository: ref.repository },
        { service: { stack: r.stack, service: r.service } },
      )
      sources.set(key, s.repo)
    }
    return {
      ...toView(r, repo),
      links: refLinks(ref, r.to_tag, sources.get(key) ?? null),
      registry: registryName(ref.registry),
    }
  })
}

/** Every update ever recorded for one service, newest first. */
export function updatesForService(stack: string, service: string): UpdateView[] {
  const rows = getDb()
    .prepare(`${SELECT_UPDATE} WHERE u.stack = ? AND u.service = ? ORDER BY u.detected_at DESC`)
    .all(stack, service) as RawUpdate[]
  const repo = repoName()
  return rows.map((r) => toView(r, repo))
}
