import { getDb } from '../db.ts'
import { loadPolicy } from '../config.ts'
import { shouldOpenPr, type EffectiveTier } from '../policy.ts'
import type { Magnitude } from '../versions/patterns.ts'
import { actionsFor, isTransient, primaryVerb, type ActionContext, type Verb } from './actions.ts'
import { LIVE_STATES, sqlIn, type UpdateState } from './state.ts'
import { refLinks, registryName, type RefLinks } from '../links.ts'
import { parseImageRef } from '../images/ref.ts'

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

export interface UpdateView {
  id: number
  stack: string
  service: string
  image: string
  fromTag: string
  toTag: string
  magnitude: Magnitude
  tier: EffectiveTier
  state: UpdateState
  detail: string | null
  rolling: boolean
  detectedAt: string
  updatedAt: string
  ackedAt: string | null
  pr: {
    number: number
    state: string
    scope: 'tag-only' | 'proposed' | 'modified'
    userOwned: boolean
    mergeCommitSha: string | null
    url: string
  } | null
  verdict: {
    recommendation: 'approve' | 'caution' | 'block' | null
    confidence: 'low' | 'medium' | 'high' | null
    severity: string | null
    summary: string | null
    breakingChanges: string[]
    migrationSteps: string[]
    sources: string[]
    model: string | null
    createdAt: string | null
    error: string | null
    attempts: number
    nextAttemptAt: string | null
  } | null
  deploy: {
    id: number
    status: string
    trigger: string
    startedAt: string | null
    finishedAt: string | null
    recheckAt: string | null
    detail: string | null
  } | null
  actions: Verb[]
  primary: Verb | null
  transient: boolean
}

const SELECT_UPDATE = `
  SELECT u.id, u.stack, u.service, u.image, u.from_tag, u.to_tag, u.magnitude, u.tier,
         u.state, u.detail, u.detected_at, u.updated_at, u.acked_at
    FROM updates u`

interface RawUpdate {
  id: number
  stack: string
  service: string
  image: string
  from_tag: string
  to_tag: string
  magnitude: string
  tier: string
  state: string
  detail: string | null
  detected_at: string
  updated_at: string
  acked_at: string | null
}

/**
 * The newest pull request for an update, not an open one.
 *
 * An update that has been round twice has two, and the dashboard's `LEFT JOIN … AND
 * p.state = 'open'` returns a duplicated row while both are open and none once both are
 * closed -- taking the merge commit with it, which is what a rollback needs.
 */
function prFor(updateId: number, repo: string) {
  const row = getDb()
    .prepare(
      `SELECT p.number, p.state, p.scope, p.user_owned, p.merge_commit_sha
         FROM prs p JOIN pr_updates pu ON pu.pr_id = p.id
        WHERE pu.update_id = ? ORDER BY p.id DESC LIMIT 1`,
    )
    .get(updateId) as
    | {
        number: number
        state: string
        scope: string
        user_owned: number
        merge_commit_sha: string | null
      }
    | undefined
  if (!row) return null
  return {
    number: row.number,
    state: row.state,
    scope: (row.scope ?? 'tag-only') as 'tag-only' | 'proposed' | 'modified',
    userOwned: row.user_owned === 1,
    mergeCommitSha: row.merge_commit_sha,
    url: `https://github.com/${repo}/pull/${row.number}`,
  }
}

function verdictFor(u: RawUpdate): UpdateView['verdict'] {
  const v = getDb()
    .prepare(
      `SELECT recommendation, confidence, severity, summary, breaking_changes, migration_steps,
              sources, model, created_at, error, attempts, next_attempt_at
         FROM verdicts WHERE image = ? AND from_tag = ? AND to_tag = ?`,
    )
    .get(u.image, u.from_tag, u.to_tag) as
    | {
        recommendation: string | null
        confidence: string | null
        severity: string | null
        summary: string | null
        breaking_changes: string | null
        migration_steps: string | null
        sources: string | null
        model: string | null
        created_at: string
        error: string | null
        attempts: number
        next_attempt_at: string | null
      }
    | undefined
  if (!v) return null
  const list = (s: string | null): string[] => {
    if (!s) return []
    try {
      const parsed: unknown = JSON.parse(s)
      return Array.isArray(parsed) ? parsed.map(String) : []
    } catch {
      return []
    }
  }
  return {
    recommendation: (v.recommendation as 'approve' | 'caution' | 'block' | null) ?? null,
    confidence: (v.confidence as 'low' | 'medium' | 'high' | null) ?? null,
    severity: v.severity,
    summary: v.summary,
    breakingChanges: list(v.breaking_changes),
    migrationSteps: list(v.migration_steps),
    sources: list(v.sources),
    model: v.model,
    createdAt: v.created_at,
    error: v.error,
    attempts: v.attempts ?? 0,
    nextAttemptAt: v.next_attempt_at,
  }
}

function deployFor(updateId: number): UpdateView['deploy'] {
  const d = getDb()
    .prepare(
      `SELECT d.id, d.status, d.trigger, d.started_at, d.finished_at, d.recheck_at, d.detail
         FROM deploys d JOIN deploy_updates du ON du.deploy_id = d.id
        WHERE du.update_id = ? ORDER BY d.id DESC LIMIT 1`,
    )
    .get(updateId) as
    | {
        id: number
        status: string
        trigger: string
        started_at: string | null
        finished_at: string | null
        recheck_at: string | null
        detail: string | null
      }
    | undefined
  if (!d) return null
  return {
    id: d.id,
    status: d.status,
    trigger: d.trigger,
    startedAt: d.started_at,
    finishedAt: d.finished_at,
    recheckAt: d.recheck_at,
    detail: d.detail,
  }
}

function toView(u: RawUpdate, repo: string): UpdateView {
  const pr = prFor(u.id, repo)
  const verdict = verdictFor(u)
  const deploy = deployFor(u.id)
  const image = getDb()
    .prepare(`SELECT current_tag FROM images WHERE stack = ? AND service = ?`)
    .get(u.stack, u.service) as { current_tag: string | null } | undefined
  const hasProposal = pr
    ? !!getDb()
        .prepare(
          `SELECT 1 FROM proposals p JOIN prs r ON r.id = p.pr_id WHERE r.number = ? LIMIT 1`,
        )
        .get(pr.number)
    : false

  const ctx: ActionContext = {
    state: u.state as UpdateState,
    detail: u.detail,
    prNumber: pr?.number ?? null,
    prState: (pr?.state as ActionContext['prState']) ?? null,
    prScope: pr?.scope ?? null,
    userOwned: pr?.userOwned ?? false,
    mergeCommitSha: pr?.mergeCommitSha ?? null,
    deployStatus: (deploy?.status as ActionContext['deployStatus']) ?? null,
    verdictError: !!verdict?.error,
    hasVerdict: !!verdict && !verdict.error,
    hasProposal,
    ackedAt: u.acked_at,
    atFromTag: image ? image.current_tag === u.from_tag.split('@')[0] : undefined,
  }
  const actions = actionsFor(ctx)

  return {
    id: u.id,
    stack: u.stack,
    service: u.service,
    image: u.image,
    fromTag: u.from_tag,
    toTag: u.to_tag,
    magnitude: u.magnitude as Magnitude,
    tier: u.tier as EffectiveTier,
    state: u.state as UpdateState,
    detail: u.detail,
    rolling: u.detail === 'rolling',
    detectedAt: u.detected_at,
    updatedAt: u.updated_at,
    ackedAt: u.acked_at,
    pr,
    verdict,
    deploy,
    actions,
    primary: primaryVerb(actions),
    transient: isTransient(ctx),
  }
}

export function updateView(id: number): UpdateView | null {
  const u = getDb().prepare(`${SELECT_UPDATE} WHERE u.id = ?`).get(id) as RawUpdate | undefined
  return u ? toView(u, repoName()) : null
}

function repoName(): string {
  return process.env.GITHUB_REPO ?? 'you/repo'
}

// ------------------------------------------------------------------ the inbox

/** Why an update is in the inbox. The order here is the order the page shows them in. */
export const ATTENTION_KINDS = [
  'deploy-failed', // it broke, and it is still broken
  'rolled-back', // it broke and put itself back; you should know why
  'degraded', // it came up, then stopped looking well
  'ready-to-deploy', // merged and waiting on the button
  'pr-waiting', // a pull request wants a decision
  'on-request', // listed deliberately: datastores, migrations
  'rolling-moved', // a rolling tag moved under us
  'review-failed', // nobody has read the changelog and nobody can
] as const

export type AttentionKind = (typeof ATTENTION_KINDS)[number]

export interface AttentionItem {
  kind: AttentionKind
  update: UpdateView
}

/**
 * What is actually waiting on a person.
 *
 * Deliberately not "everything not finished": an update on the auto rung that will merge
 * itself tonight is not waiting on you, and putting it in the same list as a service that
 * is down is how a list stops being read.
 */
export function inboxNeedsYou(): AttentionItem[] {
  const db = getDb()
  const repo = repoName()
  const rows = db
    .prepare(
      `${SELECT_UPDATE}
        WHERE u.state IN ${sqlIn([...LIVE_STATES, 'merged', 'deployed', 'verified', 'failed'])}
        ORDER BY u.updated_at DESC`,
    )
    .all() as RawUpdate[]

  const items: AttentionItem[] = []
  for (const raw of rows) {
    const v = toView(raw, repo)
    const kind = attentionKind(v)
    if (kind) items.push({ kind, update: v })
  }
  const rank = (k: AttentionKind) => ATTENTION_KINDS.indexOf(k)
  return items.sort((a, b) => rank(a.kind) - rank(b.kind) || b.update.updatedAt.localeCompare(a.update.updatedAt))
}

function attentionKind(v: UpdateView): AttentionKind | null {
  const d = v.deploy?.status
  const seen = !!v.ackedAt

  if (v.state === 'failed' && !seen) {
    return v.detail?.includes('rolled back') || d === 'rolled-back' ? 'rolled-back' : 'deploy-failed'
  }
  if (v.state === 'merged' && (d === 'failed' || d === 'error') && !seen) return 'deploy-failed'
  if (d === 'degraded' && !seen) return 'degraded'
  if (v.state === 'merged' && (d === 'ready' || d === 'pending')) return 'ready-to-deploy'
  if (v.state === 'pr_open') return v.verdict?.error ? 'review-failed' : 'pr-waiting'
  if (v.state === 'held') return 'on-request'
  if (v.state === 'detected' && v.rolling) return 'rolling-moved'
  return null
}

/**
 * Updates that are tracked but parked: detected, not rolling, and nothing will open a
 * pull request for them under the current scope. Informational -- they are the answer to
 * "why is this not in the list", which is otherwise unanswerable from the interface.
 */
export function inboxParked(): UpdateView[] {
  const { policy } = loadPolicy()
  const repo = repoName()
  const rows = getDb()
    .prepare(`${SELECT_UPDATE} WHERE u.state = 'detected' ORDER BY u.stack, u.service`)
    .all() as RawUpdate[]
  return rows
    .filter(
      (r) =>
        r.detail !== 'rolling' &&
        !shouldOpenPr({
          scope: policy.prs.scope,
          tier: r.tier as EffectiveTier,
          magnitude: r.magnitude as Magnitude,
          rolling: false,
        }),
    )
    .map((r) => toView(r, repo))
}

export interface RecentItem {
  at: string
  kind: 'opened' | 'merged' | 'deployed' | 'verified' | 'degraded' | 'failed' | 'rolled-back' | 'skipped' | 'superseded'
  stack: string
  service: string
  fromTag: string
  toTag: string
  updateId: number
  prNumber: number | null
  detail: string | null
}

/** What happened lately, so "did last night go fine" is one glance rather than a hunt. */
export function inboxRecent(hours = 24, limit = 20): RecentItem[] {
  const since = new Date(Date.now() - hours * 3600_000).toISOString()
  const db = getDb()

  const opened = db
    .prepare(
      `SELECT p.created_at AS at, 'opened' AS kind, u.stack, u.service, u.from_tag AS fromTag, u.to_tag AS toTag,
              u.id AS updateId, p.number AS prNumber, NULL AS detail
         FROM prs p JOIN pr_updates pu ON pu.pr_id = p.id JOIN updates u ON u.id = pu.update_id
        WHERE p.created_at >= ?`,
    )
    .all(since) as RecentItem[]

  const merged = db
    .prepare(
      `SELECT p.merged_at AS at, 'merged' AS kind, u.stack, u.service, u.from_tag AS fromTag, u.to_tag AS toTag,
              u.id AS updateId, p.number AS prNumber, NULL AS detail
         FROM prs p JOIN pr_updates pu ON pu.pr_id = p.id JOIN updates u ON u.id = pu.update_id
        WHERE p.merged_at >= ?`,
    )
    .all(since) as RecentItem[]

  const deployed = db
    .prepare(
      `SELECT d.finished_at AS at,
              CASE d.status WHEN 'verified' THEN 'verified' WHEN 'degraded' THEN 'degraded'
                            WHEN 'rolled-back' THEN 'rolled-back'
                            WHEN 'deployed' THEN 'deployed' ELSE 'failed' END AS kind,
              u.stack, u.service, u.from_tag AS fromTag, u.to_tag AS toTag,
              u.id AS updateId, d.pr_number AS prNumber, d.detail
         FROM deploys d JOIN deploy_updates du ON du.deploy_id = d.id
         JOIN updates u ON u.id = du.update_id
        WHERE d.finished_at >= ? AND d.status NOT IN ('pending','ready','running','superseded')`,
    )
    .all(since) as RecentItem[]

  const closed = db
    .prepare(
      `SELECT u.updated_at AS at,
              CASE u.state WHEN 'skipped' THEN 'skipped' ELSE 'superseded' END AS kind,
              u.stack, u.service, u.from_tag AS fromTag, u.to_tag AS toTag,
              u.id AS updateId, NULL AS prNumber, u.detail
         FROM updates u
        WHERE u.updated_at >= ? AND u.state IN ('skipped','superseded')`,
    )
    .all(since) as RecentItem[]

  return [...opened, ...merged, ...deployed, ...closed]
    .filter((r) => r.at)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit)
}

// --------------------------------------------------------------- the timeline

export interface Milestone {
  at: string | null
  kind: string
  label: string
  detail?: string | null
  /** Rendered ahead of time, greyed: this step has not happened yet. */
  future?: boolean
  level?: 'info' | 'warn' | 'error'
}

/**
 * One update's whole story, in order.
 *
 * Everything here was already recorded and none of it was reachable: a verdict lived in a
 * pull request body on GitHub, a deploy's verify findings in a JSON column nothing read,
 * and "verified" or "rolled back" only ever as a sentence in the log.
 */
export function updateTimeline(id: number): Milestone[] {
  const v = updateView(id)
  if (!v) return []
  const out: Milestone[] = []

  out.push({
    at: v.detectedAt,
    kind: 'detected',
    label: `${v.magnitude} update detected`,
    detail: `${v.fromTag} → ${v.toTag}`,
  })

  if (v.pr) {
    const pr = getDb()
      .prepare(`SELECT created_at, merged_at, state FROM prs WHERE number = ?`)
      .get(v.pr.number) as { created_at: string; merged_at: string | null; state: string } | undefined
    out.push({
      at: pr?.created_at ?? null,
      kind: 'pr',
      label: `pull request #${v.pr.number} opened`,
      detail: v.pr.scope === 'tag-only' ? null : `carries ${v.pr.scope === 'proposed' ? 'drafted config changes' : 'edits'}`,
    })

    if (v.verdict?.error) {
      out.push({
        at: v.verdict.createdAt,
        kind: 'review',
        label: `changelog review failed (attempt ${v.verdict.attempts})`,
        detail: v.verdict.error,
        level: 'warn',
      })
    } else if (v.verdict) {
      out.push({
        at: v.verdict.createdAt,
        kind: 'review',
        label: `reviewed: ${v.verdict.recommendation} at ${v.verdict.confidence} confidence`,
        detail: v.verdict.summary,
        level: v.verdict.recommendation === 'block' ? 'warn' : 'info',
      })
    }

    if (pr?.merged_at) {
      out.push({ at: pr.merged_at, kind: 'merged', label: `merged into main` })
    } else if (pr?.state === 'closed') {
      out.push({ at: null, kind: 'closed', label: 'pull request closed without merging' })
    }
  }

  if (v.deploy) {
    const d = getDb()
      .prepare(`SELECT verdict, snapshot, diagnosis, created_at FROM deploys WHERE id = ?`)
      .get(v.deploy.id) as
      | { verdict: string | null; snapshot: string | null; diagnosis: string | null; created_at: string }
      | undefined

    if (v.deploy.status === 'ready') {
      out.push({
        at: d?.created_at ?? null,
        kind: 'ready',
        label: 'ready to deploy',
        detail: 'waiting for you — this service is deployed by hand',
      })
    }
    if (v.deploy.startedAt) {
      out.push({
        at: v.deploy.startedAt,
        kind: 'deploying',
        label: v.deploy.trigger === 'queue' ? 'deploying' : `deploying (${v.deploy.trigger})`,
      })
    }

    const finished: Record<string, { label: string; level?: Milestone['level'] }> = {
      deployed: { label: 'up and healthy — soaking' },
      verified: { label: 'verified' },
      degraded: { label: 'degraded after the soak', level: 'warn' },
      failed: { label: 'deploy failed', level: 'error' },
      'rolled-back': { label: 'rolled back to the previous version', level: 'error' },
      error: { label: 'the deploy could not be run', level: 'error' },
    }
    const f = finished[v.deploy.status]
    if (f) {
      out.push({
        at: v.deploy.finishedAt ?? v.deploy.startedAt,
        kind: v.deploy.status,
        label: f.label,
        detail: v.deploy.detail ?? verifyDetail(d?.verdict),
        level: f.level,
      })
    }
    if (v.deploy.status === 'deployed' && v.deploy.recheckAt) {
      out.push({
        at: v.deploy.recheckAt,
        kind: 'verified',
        label: 'verified, if it is still healthy',
        future: true,
      })
    }
  }

  if (v.state === 'skipped') {
    out.push({ at: v.updatedAt, kind: 'skipped', label: 'skipped', detail: v.detail })
  }
  if (v.state === 'superseded') {
    out.push({ at: v.updatedAt, kind: 'superseded', label: 'superseded', detail: v.detail })
  }

  return out
}

function verifyDetail(json: string | null | undefined): string | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as { detail?: string; findings?: { code: string; service: string }[] }
    if (v.detail) return v.detail
    if (v.findings?.length) return v.findings.map((f) => `${f.service}: ${f.code}`).join(', ')
  } catch {
    /* a malformed verdict is not worth failing a page over */
  }
  return null
}

// -------------------------------------------------------------- lists & filters

/** The stages the Updates page filters by, and which states each covers. */
export const STAGE_FILTERS = {
  open: ['detected', 'held', 'pr_open', 'merged'],
  rolling: ['deploying', 'deployed'],
  done: ['verified'],
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

interface RawRelease extends RawUpdate {
  source_url: string | null
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

  // Both joins are one-to-one -- images is keyed by (stack, service) and resolutions by
  // (registry, repository) -- so neither can multiply the rows. Both are LEFT joins
  // because this is history: a service deleted from the compose file loses its images
  // row, and the releases it did have should not disappear from the feed along with it.
  // Without a resolved source repository refLinks falls back to what the image reference
  // alone can produce, which is the registry rather than the changelog.
  const rows = getDb()
    .prepare(
      `SELECT u.id, u.stack, u.service, u.image, u.from_tag, u.to_tag, u.magnitude, u.tier,
              u.state, u.detail, u.detected_at, u.updated_at, u.acked_at, r.source_url
         FROM updates u
         LEFT JOIN images i ON i.stack = u.stack AND i.service = u.service
         LEFT JOIN resolutions r ON r.registry = i.registry AND r.repository = i.repository
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY u.detected_at DESC, u.id DESC
       LIMIT ?`,
    )
    .all(...args, opts.limit ?? 200) as RawRelease[]

  const repo = repoName()
  return rows.map((r) => {
    const ref = parseImageRef(r.image)
    return {
      ...toView(r, repo),
      links: refLinks(ref, r.to_tag, r.source_url),
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
