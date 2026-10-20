import { ghRequest, type GhResult } from './github.ts'

/**
 * Where an upstream reference a fork waits on stands: is the fix merged, and has it
 * shipped in a release yet (FORKS.md, "What shipshape does with a fork").
 *
 * Three GitHub questions, each through the one client so a rate limit is a rate limit and
 * not "no fix": what the reference is and whether it is closed; which commit fixed it (a
 * pull request's merge commit, or for an issue the commit or merged pull request that
 * closed it); and whether a release tag contains that commit, which `compare` answers in
 * one call. Nothing here reads the database or decides anything about the fork -- that is
 * `src/forks.ts` -- so every state below can be reached in a test with a mocked fetch.
 */

export type ForkRefState = 'open' | 'merged-unreleased' | 'released' | 'closed-unfixed' | 'unknown'

export interface ForkRefResolution {
  ref: string
  state: ForkRefState
  /** The commit that fixed it, once there is one. */
  fixSha: string | null
  /** The release tag that contains the fix, when `state` is `released`. */
  releasedIn: string | null
  /** The newest release tag the fix was looked for in. */
  comparedTo: string | null
  detail: string | null
}

export interface ParsedRef {
  repo: string
  number: number
}

/** `owner/repo#N` -> its parts, or null when it is not one. */
export function parseForkRef(ref: string): ParsedRef | null {
  const m = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(ref.trim())
  return m ? { repo: m[1]!, number: Number(m[2]) } : null
}

/** Where a reference lives on GitHub. `/issues/N` answers for a pull request too. */
export function forkRefUrl(ref: string): string | null {
  const p = parseForkRef(ref)
  return p ? `https://github.com/${p.repo}/issues/${p.number}` : null
}

/** A release's page, for the tag a fix shipped in. */
export function releaseUrl(ref: string, tag: string): string | null {
  const p = parseForkRef(ref)
  return p ? `https://github.com/${p.repo}/releases/tag/${encodeURIComponent(tag)}` : null
}

export type FixLookup =
  | { kind: 'open' }
  | { kind: 'fixed'; sha: string; via: string }
  | { kind: 'closed-unfixed'; detail: string }
  | { kind: 'unknown'; detail: string }

interface IssueBody {
  state: 'open' | 'closed'
  state_reason: 'completed' | 'not_planned' | 'reopened' | 'duplicate' | null
  pull_request: { merged_at: string | null } | null
}

interface PullBody {
  state: 'open' | 'closed'
  merged: boolean
  merge_commit_sha: string | null
}

interface TimelineEvent {
  event: string
  commit_id: string | null
  source: {
    issue?: {
      number: number
      state: 'open' | 'closed'
      pull_request?: { merged_at: string | null } | null
      repository?: { full_name: string } | null
    }
  } | null
}

const failure = (r: Extract<GhResult<unknown>, { ok: false }>): FixLookup => ({ kind: 'unknown', detail: r.detail })

/**
 * The commit that fixed a reference, or why there is none.
 *
 * `/issues/{n}` answers for pull requests too, and says which it is; the pull request's
 * merge commit then takes one more call. For an issue closed as completed, the timeline
 * is read for a `closed` event carrying a commit, then for a merged pull request in the
 * same repository that mentioned it. An issue closed with neither, or as not planned, is
 * a decision for a person: the fork has no upstream fix on the way.
 */
export async function fixingCommit(ref: ParsedRef): Promise<FixLookup> {
  const base = `/repos/${ref.repo}`
  const issue = await ghRequest<IssueBody>(`${base}/issues/${ref.number}`, {
    cacheKey: `github:${base}/issues/${ref.number}#fork`,
    trim: (raw) => {
      const b = raw as IssueBody
      return {
        state: b.state,
        state_reason: b.state_reason ?? null,
        pull_request: b.pull_request ? { merged_at: b.pull_request.merged_at ?? null } : null,
      }
    },
  })
  if (!issue.ok) {
    if (issue.kind === 'not-found') return { kind: 'unknown', detail: `GitHub has no ${ref.repo}#${ref.number}` }
    return failure(issue)
  }

  if (issue.data.pull_request) {
    const pull = await ghRequest<PullBody>(`${base}/pulls/${ref.number}`, {
      cacheKey: `github:${base}/pulls/${ref.number}#fork`,
      trim: (raw) => {
        const b = raw as PullBody
        return { state: b.state, merged: !!b.merged, merge_commit_sha: b.merge_commit_sha ?? null }
      },
    })
    if (!pull.ok) return failure(pull)
    if (pull.data.merged && pull.data.merge_commit_sha) {
      return { kind: 'fixed', sha: pull.data.merge_commit_sha, via: 'merged' }
    }
    if (pull.data.state === 'open') return { kind: 'open' }
    return { kind: 'closed-unfixed', detail: 'the pull request was closed without being merged' }
  }

  if (issue.data.state === 'open') return { kind: 'open' }
  if (issue.data.state_reason === 'not_planned' || issue.data.state_reason === 'duplicate') {
    return { kind: 'closed-unfixed', detail: `the issue was closed as ${issue.data.state_reason.replace('_', ' ')}` }
  }

  const timeline = await ghRequest<TimelineEvent[]>(`${base}/issues/${ref.number}/timeline?per_page=100`, {
    cacheKey: `github:${base}/issues/${ref.number}/timeline#fork`,
    trim: (raw) =>
      (Array.isArray(raw) ? (raw as TimelineEvent[]) : [])
        .filter((e) => e.event === 'closed' || e.event === 'cross-referenced')
        .map((e) => ({
          event: e.event,
          commit_id: e.commit_id ?? null,
          source: e.source?.issue
            ? {
                issue: {
                  number: e.source.issue.number,
                  state: e.source.issue.state,
                  pull_request: e.source.issue.pull_request
                    ? { merged_at: e.source.issue.pull_request.merged_at ?? null }
                    : null,
                  repository: e.source.issue.repository ? { full_name: e.source.issue.repository.full_name } : null,
                },
              }
            : null,
        })),
  })
  if (!timeline.ok) return failure(timeline)

  // The last close wins: an issue reopened and closed again was fixed by the later one.
  const closes = timeline.data.filter((e) => e.event === 'closed' && e.commit_id)
  const byCommit = closes[closes.length - 1]
  if (byCommit?.commit_id) return { kind: 'fixed', sha: byCommit.commit_id, via: 'closing commit' }

  // A merged pull request in the same repository that mentioned the issue. Other
  // repositories' pull requests do not put a fix into this one's releases.
  const merged = timeline.data.filter(
    (e) =>
      e.event === 'cross-referenced' &&
      e.source?.issue?.pull_request?.merged_at &&
      (e.source.issue.repository?.full_name ?? ref.repo).toLowerCase() === ref.repo.toLowerCase(),
  )
  const last = merged[merged.length - 1]?.source?.issue
  if (last) {
    const pull = await ghRequest<PullBody>(`${base}/pulls/${last.number}`, {
      cacheKey: `github:${base}/pulls/${last.number}#fork`,
      trim: (raw) => {
        const b = raw as PullBody
        return { state: b.state, merged: !!b.merged, merge_commit_sha: b.merge_commit_sha ?? null }
      },
    })
    if (!pull.ok) return failure(pull)
    if (pull.data.merge_commit_sha) {
      return { kind: 'fixed', sha: pull.data.merge_commit_sha, via: `merged in #${last.number}` }
    }
  }

  return {
    kind: 'closed-unfixed',
    detail: 'the issue was closed, but no fixing commit or merged pull request was found',
  }
}

export type Containment =
  | { ok: true; contains: boolean; tag: string }
  | { ok: false; detail: string }

/**
 * Whether `tag` contains `sha`, by GitHub's compare: with `sha...tag`, the tag is `ahead`
 * of or `identical` to the commit exactly when the commit is in its history.
 *
 * An image tag is not always the git tag -- `3.4.0` against a repository that tags
 * `v3.4.0` -- so the other spelling is tried when the first is unknown to GitHub.
 */
export async function tagContains(repo: string, sha: string, tag: string): Promise<Containment> {
  const spellings = [tag, tag.startsWith('v') ? tag.slice(1) : `v${tag}`]
  let lastDetail = ''
  for (const t of spellings) {
    const path = `/repos/${repo}/compare/${encodeURIComponent(sha)}...${encodeURIComponent(t)}`
    const r = await ghRequest<{ status: string }>(path, {
      cacheKey: `github:${path}#fork`,
      trim: (raw) => ({ status: String((raw as { status?: string }).status ?? '') }),
    })
    if (r.ok) {
      return { ok: true, contains: r.data.status === 'ahead' || r.data.status === 'identical', tag: t }
    }
    if (r.kind !== 'not-found') return { ok: false, detail: r.detail }
    lastDetail = r.detail
  }
  return { ok: false, detail: `${tag} is not a tag GitHub knows in ${repo} (${lastDetail})` }
}

/**
 * One reference, resolved against the newest release tag known: the whole answer the
 * Services page shows and the retire notice is decided from.
 */
export async function resolveForkRef(ref: string, newestTag: string | null): Promise<ForkRefResolution> {
  const parsed = parseForkRef(ref)
  const out = (
    state: ForkRefState,
    o: Partial<Omit<ForkRefResolution, 'ref' | 'state'>> = {},
  ): ForkRefResolution => ({
    ref,
    state,
    fixSha: o.fixSha ?? null,
    releasedIn: o.releasedIn ?? null,
    comparedTo: o.comparedTo ?? null,
    detail: o.detail ?? null,
  })
  if (!parsed) return out('unknown', { detail: 'not an owner/repo#N reference' })

  const fix = await fixingCommit(parsed)
  switch (fix.kind) {
    case 'open':
      return out('open')
    case 'closed-unfixed':
      return out('closed-unfixed', { detail: fix.detail })
    case 'unknown':
      return out('unknown', { detail: fix.detail })
    case 'fixed':
      break
  }

  if (!newestTag) return out('merged-unreleased', { fixSha: fix.sha, detail: `${fix.via}; no release tag to look in` })
  const c = await tagContains(parsed.repo, fix.sha, newestTag)
  if (!c.ok) return out('unknown', { fixSha: fix.sha, comparedTo: newestTag, detail: c.detail })
  return c.contains
    ? out('released', { fixSha: fix.sha, releasedIn: c.tag, comparedTo: c.tag, detail: fix.via })
    : out('merged-unreleased', { fixSha: fix.sha, comparedTo: c.tag, detail: fix.via })
}
