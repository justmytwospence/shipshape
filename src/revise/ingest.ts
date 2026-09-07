import { Octokit } from 'octokit'
import { env, loadPolicy } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { isOurComment } from '../gitops/comments.ts'

/**
 * Noticing that somebody said something, which is deliberately not the same step as
 * doing anything about it.
 *
 * Splitting the two is what makes the auto-merge interlock real. If a comment were only
 * recorded by the pass that handles it, then a comment posted *while* that pass was
 * thinking -- and it thinks with a model, for up to a few minutes -- would not be in the
 * database when `runAutoMerge` ran a moment later. "Don't merge this yet" would lose a
 * race it looks like it should win, on every tick, for minutes at a time.
 *
 * So this half is free: two API calls, no model, no git, purely deterministic. It can
 * run early and often. The expensive half can then take as long as it likes, because the
 * row it needs is already written and already holding the merge.
 */

let octokit: Octokit | null = null
function gh(): Octokit {
  octokit ??= new Octokit({ auth: env.githubToken })
  return octokit
}

/** What GitHub tells us about a comment, reduced to what the decision actually reads. */
export interface CommentFacts {
  id: number
  kind: 'issue' | 'review'
  body: string | null | undefined
  author: string
  /** GitHub's `user.type`. A GitHub App wears a name; this is how it stops being one. */
  authorType: string
  /** `author_association` -- a repository-side fact no comment body can forge. */
  association: string
  createdAt: string
}

export interface IngestContext {
  /** Logins whose comments count. */
  allow: Set<string>
  /** Comments created before this are backlog, not instructions. */
  epoch: string
  /** Already in the ledger -- including every reply shipshape has posted. */
  known: (commentId: string) => boolean
  /** How many instructions this pull request has taken in the last hour. */
  recentOnPr: number
}

export type IngestVerdict = { take: true; commentId: string } | { take: false; why: string }

/** Instructions one pull request may take in an hour before shipshape stops listening. */
export const BREAKER_PER_HOUR = 6

/** Associations that mean "this person can write to this repository". */
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

/**
 * Should this comment be taken as an instruction?
 *
 * Pure, and the whole decision lives here so it can be argued with in a test rather than
 * inferred from a stack of early returns inside an API loop.
 */
export function ingestable(c: CommentFacts, ctx: IngestContext): IngestVerdict {
  const commentId = `${c.kind}:${c.id}`

  // Ours. The marker is checked on the first line only -- a body that quotes a marker
  // further down is somebody replying to us, which is the case that must not be lost.
  if (isOurComment(c.body)) return { take: false, why: 'shipshape wrote it' }

  // ...and the ledger, which holds every reply shipshape has posted by id. Exact where
  // the marker is merely conventional, and it also makes ingestion idempotent.
  if (ctx.known(commentId)) return { take: false, why: 'already seen' }

  // A GitHub App can wear an allowlisted display name. `user.type` cannot be worn.
  if (c.authorType !== 'User') return { take: false, why: `${c.author} is a ${c.authorType}` }

  if (!ctx.allow.has(c.author)) {
    return { take: false, why: `${c.author} is not in revise.authors` }
  }

  // Belt to the allowlist's braces, and the only check that still means something when
  // the token's login and the operator's login are the same string.
  if (!TRUSTED.has(c.association)) {
    return { take: false, why: `${c.author} is ${c.association} on this repository` }
  }

  // The rollout watermark. Note this reads created_at, never updated_at: an old comment
  // edited today comes back in a `since` window and is still backlog.
  if (c.createdAt < ctx.epoch) return { take: false, why: 'predates the watermark' }

  if (!(c.body ?? '').trim()) return { take: false, why: 'empty' }

  if (ctx.recentOnPr >= BREAKER_PER_HOUR) {
    return { take: false, why: `more than ${BREAKER_PER_HOUR} instructions on this pull request in an hour` }
  }

  return { take: true, commentId }
}

export interface IngestResult {
  taken: number
  skipped: number
}

/** The watermark, and the payload window, both kept in `budgets`. */
function stamp(key: string): string {
  const row = getDb().prepare(`SELECT window FROM budgets WHERE key = ?`).get(key) as
    | { window: string | null }
    | undefined
  return row?.window ?? new Date().toISOString()
}

function setStamp(key: string, at: string): void {
  getDb()
    .prepare(
      `INSERT INTO budgets (key, value, window, updated_at) VALUES (?, 0, ?, ?)
       ON CONFLICT(key) DO UPDATE SET window = excluded.window, updated_at = excluded.updated_at`,
    )
    .run(key, at, new Date().toISOString())
}

/**
 * Read new comments across the repository and record the ones that are instructions.
 *
 * Repo-level rather than per pull request, which is the difference between two API calls
 * a tick and two per open pull request per tick. With a dozen open at the 60-second
 * active cadence the per-PR shape would be some 2,700 requests an hour against a budget
 * of 5,000, for information that one call already returns whole.
 */
export async function ingestInstructions(): Promise<IngestResult> {
  const out: IngestResult = { taken: 0, skipped: 0 }
  const { policy } = loadPolicy()
  if (!env.githubToken || !env.githubRepo) return out

  // While the feature is off the watermark still advances, so switching it on means
  // "from this moment" rather than "replay everything since the migration".
  if (policy.revise.mode === 'off') {
    setStamp('revise.epoch', new Date().toISOString())
    setStamp('revise.since', new Date().toISOString())
    return out
  }

  const db = getDb()
  const open = db.prepare(`SELECT id, number FROM prs WHERE state = 'open'`).all() as {
    id: number
    number: number
  }[]
  if (open.length === 0) return out
  const byNumber = new Map(open.map((p) => [p.number, p.id]))

  const [owner, repo] = env.githubRepo.split('/') as [string, string]
  const since = stamp('revise.since')
  const epoch = stamp('revise.epoch')
  const allow = new Set(
    policy.revise.authors.length > 0 ? policy.revise.authors : [await selfLogin()].filter(Boolean),
  ) as Set<string>

  const known = db.prepare(`SELECT 1 FROM instructions WHERE comment_id = ?`)
  const recent = db.prepare(
    `SELECT COUNT(*) c FROM instructions
      WHERE pr_id = ? AND status != 'ours' AND created_at > datetime('now', '-1 hour')`,
  )
  const insert = db.prepare(
    `INSERT OR IGNORE INTO instructions
       (pr_id, comment_id, kind, author, body, url, path, line, context, commented_at,
        status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
  )

  let newest = since
  const seen: { facts: CommentFacts; prNumber: number; url: string; path?: string; line?: number }[] = []

  try {
    for await (const page of gh().paginate.iterator(gh().rest.issues.listCommentsForRepo, {
      owner,
      repo,
      since,
      sort: 'created',
      direction: 'asc',
      per_page: 100,
    })) {
      for (const c of page.data) {
        const number = prNumberOf(c.issue_url)
        if (number === null || !byNumber.has(number)) continue
        if (c.created_at > newest) newest = c.created_at
        seen.push({
          prNumber: number,
          url: c.html_url,
          facts: {
            id: c.id,
            kind: 'issue',
            body: c.body,
            author: c.user?.login ?? '',
            authorType: c.user?.type ?? 'Unknown',
            association: c.author_association ?? 'NONE',
            createdAt: c.created_at,
          },
        })
      }
    }
  } catch (err) {
    logEvent({
      level: 'warn',
      kind: 'pr',
      message: 'could not read pull request comments',
      detail: (err as Error).message.slice(0, 200),
    })
    return out
  }

  for (const item of seen) {
    const prId = byNumber.get(item.prNumber)!
    const verdict = ingestable(item.facts, {
      allow,
      epoch,
      known: (id) => known.get(id) !== undefined,
      recentOnPr: (recent.get(prId) as { c: number }).c,
    })
    if (!verdict.take) {
      out.skipped++
      continue
    }
    insert.run(
      prId,
      verdict.commentId,
      item.facts.kind,
      item.facts.author,
      item.facts.body ?? '',
      item.url,
      item.path ?? null,
      item.line ?? null,
      null,
      item.facts.createdAt,
      new Date().toISOString(),
    )
    out.taken++
    logEvent({
      level: 'info',
      kind: 'pr',
      message: `#${item.prNumber}: ${item.facts.author} asked for something`,
      detail: (item.facts.body ?? '').trim().split('\n')[0]?.slice(0, 160) ?? '',
    })
  }

  // Advance only past what was actually read. A window that moves on a failed page
  // would skip the comments in it permanently.
  setStamp('revise.since', newest)
  return out
}

/** `https://api.github.com/repos/o/r/issues/12` -> 12. */
export function prNumberOf(issueUrl: string | null | undefined): number | null {
  const m = /\/issues\/(\d+)$/.exec(issueUrl ?? '')
  return m ? Number(m[1]) : null
}

let cachedLogin: string | null = null

/**
 * The account the token authenticates as, which is the default allowlist of one.
 *
 * Cached for the process: it cannot change without the token changing, and that needs a
 * restart anyway.
 */
async function selfLogin(): Promise<string> {
  if (cachedLogin !== null) return cachedLogin
  try {
    const { data } = await gh().rest.users.getAuthenticated()
    cachedLogin = data.login
  } catch {
    cachedLogin = ''
  }
  return cachedLogin
}
