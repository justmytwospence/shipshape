import { Octokit } from 'octokit'
import { env, loadPolicy, type Policy } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { canAutoMerge, foldGroupMagnitude, foldGroupTier, tierFor } from '../policy.ts'
import { scanRepo } from '../compose/scan.ts'
import type { Magnitude } from '../versions/patterns.ts'
import { assess, type ResolutionTier } from '../policy/model-tier.ts'
import { normaliseSourceUrl } from '../resolver/index.ts'

/**
 * Merging what policy already allows, without a human.
 *
 * This is the only place in shipshape that can change the repository without someone
 * pressing something, so the gating is the feature and the merge call is an afterthought.
 *
 * Five conditions, all required:
 *
 * 1. `merge.auto` is on. Off by default and off in this deployment: turning it on is
 *    an operator decision, not a consequence of upgrading.
 * 2. The pull request is still exactly what shipshape wrote — `scope = 'tag-only'` and
 *    not user-owned. A drafted proposal (`proposed`) or a human edit (`modified`)
 *    permanently disqualifies it, because nothing has reviewed those changes.
 * 3. `canAutoMerge()` passes for every update in the group: the auto tier, a patch or
 *    minor, and no verdict withholding it. This is the same predicate the dashboard
 *    shows, so what merges is what the dashboard said would merge.
 * 4. GitHub's own checks are not failing. A red check is a reason to stop even when
 *    policy is satisfied.
 * 5. Not in a blackout window, and under the hourly ceiling — so a misconfiguration
 *    merges a few things and then stops, rather than the entire backlog at 3am.
 *
 * The asymmetry from the analysis model holds here: Claude can withhold a merge and
 * never cause one. Nothing in a changelog can make this function return true.
 */

let octokit: Octokit | null = null
function gh(): Octokit {
  octokit ??= new Octokit({ auth: env.githubToken })
  return octokit
}

export interface MergeDecision {
  number: number
  merge: boolean
  reason: string
}

/** Last shadow-mode conclusion logged per pull request, so a steady state stays quiet. */
const shadowLogged = new Map<number, string>()

interface Candidate {
  id: number
  number: number
  scope: string
  user_owned: number
}

/**
 * Decide, without merging. Exported so the dashboard and the dry run can show exactly
 * what would happen using the same code that does it.
 */
export function decide(prId: number, number: number, scope: string, userOwned: boolean, policy: Policy): MergeDecision {
  if (userOwned) return { number, merge: false, reason: 'the branch has been edited by hand' }
  if (scope !== 'tag-only') {
    return {
      number,
      merge: false,
      reason: scope === 'proposed' ? 'it carries drafted config changes' : 'it contains more than an image tag',
    }
  }

  const rows = getDb()
    .prepare(
      `SELECT u.stack, u.service, u.magnitude, u.detail, u.image, u.from_tag, u.to_tag,
              v.recommendation, v.confidence, v.error AS verdict_error,
              v.sources, v.breaking_changes, v.migration_steps,
              r.tier AS resolution_tier, r.source_url
       FROM updates u
       JOIN pr_updates pu ON pu.update_id = u.id
       LEFT JOIN verdicts v ON v.image = u.image AND v.from_tag = u.from_tag AND v.to_tag = u.to_tag
       LEFT JOIN images i ON i.stack = u.stack AND i.service = u.service
       LEFT JOIN resolutions r ON r.registry = i.registry AND r.repository = i.repository
       -- A superseded row describes an update that has been overtaken. It must not be
       -- allowed to supply the magnitude, tier or verdict that justifies a merge: the
       -- successor rewrites the same line, so merging this one lands a version nobody is
       -- tracking any more. Dropping every row leaves the result empty, which refuses
       -- below -- and a partially superseded group refuses too, which is the point.
       WHERE pu.pr_id = ? AND u.state != 'superseded'`,
    )
    .all(prId) as {
    stack: string
    service: string
    magnitude: Magnitude
    detail: string | null
    image: string
    from_tag: string
    to_tag: string
    recommendation: string | null
    confidence: string | null
    verdict_error: string | null
    sources: string | null
    breaking_changes: string | null
    migration_steps: string | null
    resolution_tier: string | null
    source_url: string | null
  }[]

  if (rows.length === 0) return { number, merge: false, reason: 'no updates recorded for it' }

  // Tier is re-derived from the compose files rather than read from the update row, so
  // a label added since the pull request opened takes effect.
  const services = scanRepo(env.repoDir, policy.exclude_stacks)
  const svcFor = (r: { stack: string; service: string }) =>
    services.find((s) => s.stack === r.stack && s.service === r.service)
  const tiers = rows.map((r) =>
    tierFor({
      magnitude: r.magnitude,
      policyLabel: svcFor(r)?.policyLabel ?? null,
      prLabel: svcFor(r)?.prLabel ?? null,
      defaults: policy.defaults,
    }),
  )

  // `shipshape.claude: required` flips a service to fail-closed: rather than falling back
  // to static policy when no verdict exists, it stalls. This was previously hardcoded
  // false here, which made the label parse, store, and render while changing nothing --
  // the most expensive kind of inert, because the operator believes they opted in.
  // One required member is enough: a group is only as merge-able as its strictest.
  const claudeRequired = rows.some((r) => svcFor(r)?.claudeLabel === 'required')

  // The group is only as mergeable as its most conservative member.
  const worstVerdict = rows.reduce<{ rec: string; conf: string }>(
    (acc, r) => {
      const rec = r.verdict_error ? 'unavailable' : (r.recommendation ?? 'unavailable')
      const rank = { block: 3, caution: 2, unavailable: 1, approve: 0 } as Record<string, number>
      return (rank[rec] ?? 1) > (rank[acc.rec] ?? 1)
        ? { rec, conf: r.confidence ?? 'low' }
        : acc
    },
    { rec: 'approve', conf: 'high' },
  )

  let tier = foldGroupTier(tiers)
  if (tier === 'model') {
    // The one place the model's judgement can raise rather than lower a tier. Every
    // guard must pass; anything else falls back to what static policy alone would say,
    // which for a major is a human.
    //
    // The `linked` guard asks how the upstream repository was identified, and the
    // resolution cache cannot answer for a service whose upstream is known only from a
    // `shipshape.source` label -- resolveSource short-circuits on the label and never
    // writes a row. So the label is folded in here, where the compose files are already
    // in hand, rather than left to make the guard quietly unsatisfiable.
    tier = resolveModelTier(
      rows.map((r) => {
        const label = svcFor(r)?.sourceLabel
        const fromLabel = label ? normaliseSourceUrl(label) : null
        return fromLabel
          ? { ...r, resolution_tier: 'label', source_url: fromLabel }
          : r
      }),
      policy,
      number,
    )
  }

  const d = canAutoMerge({
    tier,
    magnitude: foldGroupMagnitude(rows.map((r) => r.magnitude)),
    verdict: worstVerdict.rec as never,
    confidence: worstVerdict.conf as never,
    claudeRequired,
    claudeMode: policy.claude.mode,
    minConfidence: policy.claude.min_confidence,
    prScope: 'tag-only',
  })
  return { number, merge: d.merge, reason: d.merge ? 'policy allows it' : d.reason }
}

/**
 * Resolve a deferred `model` tier into a real one, recording the decision either way.
 *
 * Returns `auto` only when every guard passes AND the mode is `enforce`. Under
 * `shadow` the assessment is recorded and the static fallback is returned, so the
 * track record accumulates without anything acting on it.
 */
function resolveModelTier(
  rows: {
    stack: string
    service: string
    image?: string
    from_tag?: string
    to_tag?: string
    magnitude: Magnitude
    recommendation: string | null
    confidence: string | null
    verdict_error: string | null
    sources: string | null
    breaking_changes: string | null
    migration_steps: string | null
    resolution_tier: string | null
    source_url: string | null
  }[],
  policy: Policy,
  number: number,
): EffectiveTierResolved {
  const { mode } = policy.model_tier
  if (mode === 'off') return fallbackTier()

  const db = getDb()
  const now = new Date().toISOString()
  let allPromote = true
  let firstRefusal = 'every guard passed'

  for (const r of rows) {
    const a = assess({
      resolutionTier: (r.resolution_tier ?? 'none') as ResolutionTier,
      sourceRepo: r.source_url,
      sources: parseArray(r.sources),
      recommendation: (r.verdict_error ? 'unavailable' : (r.recommendation ?? 'unavailable')) as never,
      confidence: (r.confidence ?? 'low') as never,
      breakingChanges: parseArray(r.breaking_changes),
      migrationSteps: parseArray(r.migration_steps),
    })
    if (!a.promote && allPromote) firstRefusal = `${r.service}: ${a.reason}`
    allPromote &&= a.promote

    // The decision is re-derived on every poll cycle, but only a *change* is worth a
    // row: without this the table grows one entry per minute per open model-tier pull
    // request, and the System page's track record becomes the same verdict restated a
    // thousand times rather than a history of judgements.
    const last = db
      .prepare(
        `SELECT promote, reason, enforced FROM model_tier_decisions
         WHERE image = ? AND stack = ? AND service = ? AND from_tag IS ? AND to_tag IS ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(r.image ?? '', r.stack, r.service, r.from_tag ?? null, r.to_tag ?? null) as
      | { promote: number; reason: string; enforced: number }
      | undefined
    const unchanged =
      last !== undefined &&
      last.promote === (a.promote ? 1 : 0) &&
      last.reason === a.reason &&
      last.enforced === (mode === 'enforce' ? 1 : 0)
    if (unchanged) continue

    db.prepare(
      `INSERT INTO model_tier_decisions
         (image, stack, service, from_tag, to_tag, magnitude, static_tier,
          promote, reason, guards, enforced, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      r.image ?? '',
      r.stack,
      r.service,
      r.from_tag ?? null,
      r.to_tag ?? null,
      r.magnitude,
      fallbackTier(),
      a.promote ? 1 : 0,
      a.reason,
      JSON.stringify(a.guards),
      mode === 'enforce' ? 1 : 0,
      now,
    )
  }

  if (mode === 'shadow') {
    // Once per distinct conclusion, for the same reason the row above is: this runs
    // every poll cycle and the answer rarely changes.
    const key = `${number}:${allPromote}:${firstRefusal}`
    if (shadowLogged.get(number) !== key) {
      shadowLogged.set(number, key)
      logEvent({
        level: 'info',
        kind: 'pr',
        message: `#${number}: model would ${allPromote ? 'treat this as routine' : 'defer to a human'}`,
        detail: `${firstRefusal} — shadow mode, nothing acted on it`,
      })
    }
    return fallbackTier()
  }

  return allPromote ? 'auto' : fallbackTier()
}

type EffectiveTierResolved = 'auto' | 'manual' | 'held' | 'skip'

/**
 * Where a refused update lands.
 *
 * Always `manual` — a human — and deliberately not the magnitude default. `model`
 * replaces whatever static label the service had, and shipshape cannot know what that
 * was, so deriving the fallback from magnitude silently rewrites the operator's intent:
 * a service pinned to `manual` that switches to `model` would land on `auto` for a
 * patch the moment a guard refused. That is the opposite of what asking for review
 * means, and it would be most wrong exactly where `manual` was chosen most carefully.
 *
 * So the contract is one sentence: routine if the model vouches for it, a human
 * otherwise.
 */
function fallbackTier(): EffectiveTierResolved {
  return 'manual'
}

function parseArray(v: string | null): string[] {
  if (!v) return []
  try {
    const p = JSON.parse(v)
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export interface AutoMergeResult {
  merged: number
  held: number
  decisions: MergeDecision[]
}

export async function runAutoMerge(dryRun = false): Promise<AutoMergeResult> {
  const out: AutoMergeResult = { merged: 0, held: 0, decisions: [] }
  const { policy } = loadPolicy()
  if (!policy.merge.auto && !dryRun) return out
  if (!env.githubToken) return out

  const open = getDb()
    .prepare(`SELECT id, number, scope, user_owned FROM prs WHERE state = 'open' ORDER BY number`)
    .all() as Candidate[]

  const [owner, repo] = env.githubRepo.split('/') as [string, string]

  for (const pr of open) {
    const decision = decide(pr.id, pr.number, pr.scope, !!pr.user_owned, policy)
    out.decisions.push(decision)
    if (!decision.merge) {
      out.held++
      continue
    }
    if (dryRun) {
      out.merged++
      continue
    }
    // A misconfiguration should merge a couple of things and stop, not the backlog.
    if (out.merged >= policy.merge.max_per_run) {
      out.decisions.push({
        number: pr.number,
        merge: false,
        reason: `held: ${policy.merge.max_per_run} already merged this run`,
      })
      out.held++
      continue
    }

    // A red check stops a merge even when policy is satisfied.
    const checks = await checksFailing(owner, repo, pr.number)
    if (checks) {
      out.held++
      out.decisions.push({ number: pr.number, merge: false, reason: `checks failing: ${checks}` })
      continue
    }

    try {
      await gh().rest.pulls.merge({
        owner,
        repo,
        pull_number: pr.number,
        merge_method: policy.merge_method,
      })
      out.merged++
      logEvent({
        level: 'info',
        kind: 'pr',
        message: `#${pr.number} auto-merged`,
        detail: decision.reason,
      })
    } catch (err) {
      out.held++
      logEvent({
        level: 'warn',
        kind: 'pr',
        message: `could not auto-merge #${pr.number}`,
        detail: (err as Error).message.slice(0, 200),
      })
    }
  }
  return out
}

/** The name of a failing check, or null when nothing is red. */
async function checksFailing(owner: string, repo: string, number: number): Promise<string | null> {
  try {
    const pr = await gh().rest.pulls.get({ owner, repo, pull_number: number })
    const ref = pr.data.head.sha
    const runs = await gh().rest.checks.listForRef({ owner, repo, ref })
    const bad = runs.data.check_runs.find(
      (c) => c.conclusion === 'failure' || c.conclusion === 'timed_out',
    )
    return bad ? bad.name : null
  } catch {
    // Unknown is not the same as passing. Refuse rather than assume.
    return 'could not read checks'
  }
}
