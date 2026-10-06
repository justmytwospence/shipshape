import { Octokit } from 'octokit'
import { env, loadPolicy, type Policy } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { MIN_CONFIDENCE, canAutoMerge, foldGroupTier, reviewMode, tierFor } from '../policy.ts'
import { budgetExhausted } from '../analyze/claude.ts'
import { llmConfigured } from '../analyze/client.ts'
import { scanRepo } from '../compose/scan.ts'
import type { Magnitude } from '../versions/patterns.ts'

/**
 * Merging what policy already allows, without a human.
 *
 * This is the only place in shipshape that can change the repository without someone
 * pressing something, so the gating is the feature and the merge call is an afterthought.
 *
 * Five conditions, all required:
 *
 * 1. Not paused. `paused` is the one switch for anything happening without a person.
 * 2. The pull request is still exactly what shipshape wrote — `scope = 'tag-only'` and
 *    not user-owned. A drafted proposal (`proposed`) or a human edit (`modified`)
 *    permanently disqualifies it, because nothing has reviewed those changes.
 * 3. `canAutoMerge()` passes for every update in it, asked member by member: the auto
 *    rung, a patch or minor, a review that is neither holding it nor still on its way.
 *    This is the same predicate the dashboard shows, so what merges is what the
 *    dashboard said would merge.
 * 4. GitHub's own checks are not failing. A red check is a reason to stop even when
 *    policy is satisfied.
 * 5. Under the per-run ceiling — so a misconfiguration merges a few things and then
 *    stops, rather than the entire backlog at 3am.
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

interface Candidate {
  id: number
  number: number
  scope: string
  user_owned: number
}

/**
 * Why this pull request is being held by something the operator said, or null.
 *
 * Two sources, and they are different things. A standing hold is a decision -- "don't
 * merge this yet" -- and lasts until it is released. An unanswered instruction is
 * merely unfinished: shipshape has been asked something and has not replied, and
 * merging underneath that would answer a question with a fait accompli.
 *
 * The quiet period is the third case, and it closes the one gap the ledger cannot: a
 * comment posted between the listing and the merge in the same tick. Five minutes of
 * "somebody is typing" costs nothing on a repository whose updates wait hours anyway.
 */
export function holdReason(prId: number): string | null {
  const db = getDb()
  const pr = db.prepare(`SELECT hold_reason FROM prs WHERE id = ?`).get(prId) as
    | { hold_reason: string | null }
    | undefined
  if (pr?.hold_reason) return pr.hold_reason

  const pending = db
    .prepare(
      `SELECT COUNT(*) c FROM instructions
        WHERE pr_id = ? AND status IN ('new', 'working')`,
    )
    .get(prId) as { c: number }
  if (pending.c > 0) {
    return pending.c === 1
      ? 'a comment is waiting on an answer'
      : `${pending.c} comments are waiting on an answer`
  }

  const fresh = db
    .prepare(
      `SELECT COUNT(*) c FROM instructions
        WHERE pr_id = ? AND status != 'ours' AND created_at > datetime('now', '-5 minutes')`,
    )
    .get(prId) as { c: number }
  return fresh.c > 0 ? 'somebody commented on it in the last few minutes' : null
}

/**
 * Decide, without merging. Exported so the dashboard and the dry run can show exactly
 * what would happen using the same code that does it.
 */
export function decide(prId: number, number: number, scope: string, userOwned: boolean, policy: Policy): MergeDecision {
  if (userOwned) return { number, merge: false, reason: 'the branch has been edited by hand' }
  // Before the scope test, because a comment on a still-tag-only pull request is the
  // whole case this exists for. `holdReason` reads rows written by ingestion, which runs
  // with no model and no git, so this is decided from facts that were already true when
  // the tick started rather than from work that may still be in flight.
  const held = holdReason(prId)
  if (held) return { number, merge: false, reason: held }
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
              u.detected_at, p.created_at AS pr_created_at,
              v.image AS verdict_row,
              v.recommendation, v.confidence, v.error AS verdict_error,
              v.sources, v.breaking_changes, v.migration_steps
       FROM updates u
       JOIN pr_updates pu ON pu.update_id = u.id
       JOIN prs p ON p.id = pu.pr_id
       LEFT JOIN verdicts v ON v.image = u.image AND v.from_tag = u.from_tag AND v.to_tag = u.to_tag
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
    detected_at: string
    pr_created_at: string
    verdict_row: string | null
    recommendation: string | null
    confidence: string | null
    verdict_error: string | null
    sources: string | null
    breaking_changes: string | null
    migration_steps: string | null
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
      dormant: svcFor(r)?.dormant ?? false,
      defaults: policy.defaults,
    }),
  )

  // `shipshape.claude: required` flips a service to fail-closed: rather than falling back
  // to static policy when no verdict exists, it stalls. This was previously hardcoded
  // false here, which made the label parse, store, and render while changing nothing --
  // the most expensive kind of inert, because the operator believes they opted in.
  // One required member is enough: a group is only as merge-able as its strictest.
  //
  // Compared after trimming and lowercasing, because this is the one label whose failure
  // direction is *open*. Everywhere else an unrecognised value narrows to `manual` and a
  // typo costs the operator nothing; here `Required`, or a trailing space, silently
  // reverts the service to falling back on static policy -- the same inert-label failure
  // this line was already fixed for once, in the same direction.
  const claudeRequired = rows.some(
    (r) => svcFor(r)?.claudeLabel?.trim().toLowerCase() === 'required',
  )

  // The group merges only if every member would merge on its own. This replaced a fold
  // that reduced the group to its "worst" verdict and carried that verdict's confidence
  // -- except that it started from approve/high and only replaced it on a strictly worse
  // recommendation, so an approve at low confidence kept `high` and `min_confidence` was
  // never enforced at all, on groups or on single pull requests. Asking each member is
  // the same question the gate asks of one update, which is the only form that cannot
  // drift from it.
  const tier = foldGroupTier(tiers)
  const reviewCanRun = reviewExpected(policy)
  for (const r of rows) {
    const d = canAutoMerge({
      tier,
      magnitude: r.magnitude,
      verdict: memberVerdict(r, reviewCanRun) as never,
      confidence: (r.confidence ?? 'low') as never,
      claudeRequired,
      claudeMode: reviewMode(policy),
      minConfidence: MIN_CONFIDENCE,
      prScope: 'tag-only',
    })
    if (!d.merge) {
      return { number, merge: false, reason: rows.length > 1 ? `${r.service}: ${d.reason}` : d.reason }
    }
  }
  return { number, merge: true, reason: 'policy allows it' }

}

/**
 * How long an update on an open pull request waits for its first review before the
 * static policy is allowed to merge it without one.
 *
 * The analysis pass reads three updates a tick, and the merge pass runs at the end of
 * the same tick -- so before this, the fourth pull request opened in a scan was judged
 * "unavailable" and merged unread while its review was still queued. Six hours is long
 * enough to cover a backlog draining at three a minute and a provider having a bad hour,
 * and short enough that an outage still degrades to today's behaviour rather than
 * freezing every update.
 */
export const REVIEW_WAIT_MS = 6 * 60 * 60_000

/** Whether a review can be expected to arrive at all: it is on, a provider is set, money is left. */
function reviewExpected(policy: Policy): boolean {
  return reviewMode(policy) !== 'off' && llmConfigured() && !budgetExhausted()
}

/**
 * What the gate should treat one member's review as.
 *
 * A row with an error is a review that was tried and failed: `unavailable`, which follows
 * the static policy (or holds, for a fail-closed service) exactly as before. No row at all
 * is a review that has not been tried -- `pending` while one can still be expected and the
 * wait has not run out, and `unavailable` after that. Exported for the tests.
 */
export function memberVerdict(
  r: {
    verdict_row: string | null
    verdict_error: string | null
    recommendation: string | null
    detected_at: string
    pr_created_at: string
  },
  reviewCanRun: boolean,
  now = Date.now(),
): string {
  if (r.verdict_row !== null) {
    return r.verdict_error ? 'unavailable' : (r.recommendation ?? 'unavailable')
  }
  if (!reviewCanRun) return 'unavailable'
  // When this update joined the pull request: a retargeted one joins long after the pull
  // request was opened, so the later of the two is the clock that matters.
  const joined = Math.max(Date.parse(r.pr_created_at) || 0, Date.parse(r.detected_at) || 0)
  return now - joined < REVIEW_WAIT_MS ? 'pending' : 'unavailable'
}

export interface AutoMergeResult {
  merged: number
  held: number
  decisions: MergeDecision[]
}

export async function runAutoMerge(dryRun = false): Promise<AutoMergeResult> {
  const out: AutoMergeResult = { merged: 0, held: 0, decisions: [] }
  const { policy } = loadPolicy()
  // Paused means shipshape starts nothing. The preview still runs: the point of it is to
  // show what would happen, which is exactly the question a paused operator is asking.
  if (policy.paused && !dryRun) return out
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
    // A misconfiguration should merge a couple of things and stop, not the backlog.
    // Counted in the preview too, or it claims a backlog would land in one pass.
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
    //
    // The preview runs this too, and that is the point of the change: it used to answer
    // `dryRun` before reaching here, so it reported "would merge" for pull requests the
    // real pass then refused on an unreadable checks API. A page whose whole job is
    // "what would merge if nothing were holding it" was the last place to learn that
    // something was.
    const checks = await checksFailing(owner, repo, pr.number)
    if (checks) {
      out.held++
      out.decisions.push({ number: pr.number, merge: false, reason: `checks failing: ${checks}` })
      // Said out loud, because this is the one refusal that is not a policy decision the
      // operator already made. Everything else that holds a merge is visible on the
      // update -- a tier, a verdict, a hold. This was only ever a row in a preview
      // nobody had reason to open.
      if (!dryRun) {
        logEvent({
          level: 'warn',
          kind: 'pr',
          message: `#${pr.number} not merged: ${checks}`,
          detail: 'policy allowed it; the checks gate did not',
        })
      }
      continue
    }

    if (dryRun) {
      out.merged++
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

/**
 * What a check-runs response means for a merge.
 *
 * The distinction that matters is **"a check is red"** versus **"this token is not
 * allowed to look"**, and the original code could not draw it: every failure went
 * through one catch and came back as `could not read checks`, which read as red.
 *
 * That is a deadlock, not a safeguard. A fine-grained token scoped to Contents and Pull
 * requests -- which is what the README asks for, and all shipshape otherwise needs --
 * gets 403 from `checks.listForRef`. On a repository with no CI at all, there are no
 * checks to read, never will be, and every auto-merge refuses forever with no log line
 * to say why. It cost this lab a full day of a migration before anyone noticed, because
 * the symptom is silence.
 *
 * So it fails open on `not-visible`, and that is the same asymmetry the changelog review
 * already uses: an unavailable verdict falls back to static policy rather than freezing
 * every update, because a provider outage must not stop the world. A 403 here is not
 * evidence about the state of a check -- it is evidence about the token, which is the
 * operator's own deliberate configuration.
 *
 * Everything else still fails closed. A 5xx or a network error genuinely means "a check
 * may be red and I could not see it", and refusing is right.
 */
export type ChecksVerdict =
  | { kind: 'clear' }
  | { kind: 'red'; name: string }
  | { kind: 'not-visible'; why: string }
  | { kind: 'unknown'; why: string }

export function classifyChecks(
  status: number | null,
  runs: { conclusion: string | null; name: string }[],
  message = '',
): ChecksVerdict {
  // No status at all means no HTTP response came back -- a network failure, which is
  // the one case where "a check may be red and I could not see it" is literally true.
  // Checked first, and deliberately not folded in with the codes below: reading `null`
  // as "no error status, therefore fine" is how a connection reset becomes a merge.
  if (status === null) {
    return { kind: 'unknown', why: `could not reach the checks API${message ? `: ${message}` : ''}` }
  }
  // 403: the token has no Checks permission. 404: the repository exposes no check API to
  // it. Neither says anything about whether a check is red.
  if (status === 403 || status === 404) {
    return { kind: 'not-visible', why: `GitHub returned ${status} for the checks API` }
  }
  if (status < 200 || status >= 300) {
    return { kind: 'unknown', why: `checks API returned ${status}${message ? `: ${message}` : ''}` }
  }
  const bad = runs.find((c) => c.conclusion === 'failure' || c.conclusion === 'timed_out')
  return bad ? { kind: 'red', name: bad.name } : { kind: 'clear' }
}

/** Said once per process, not once per pull request per minute. */
let announcedInvisible = false

/** Whether a red check stands in the way of merging this pull request. */
async function checksFailing(owner: string, repo: string, number: number): Promise<string | null> {
  let verdict: ChecksVerdict
  try {
    const pr = await gh().rest.pulls.get({ owner, repo, pull_number: number })
    const runs = await gh().rest.checks.listForRef({ owner, repo, ref: pr.data.head.sha })
    verdict = classifyChecks(runs.status, runs.data.check_runs)
  } catch (err) {
    const e = err as { status?: number; message?: string }
    verdict = classifyChecks(e.status ?? null, [], e.message ?? '')
  }

  switch (verdict.kind) {
    case 'clear':
      return null
    case 'red':
      return verdict.name
    case 'not-visible':
      // Fail open, but never silently -- an operator who does have CI needs to know the
      // guard is not running, and the reason is a one-line fix on the token.
      if (!announcedInvisible) {
        announcedInvisible = true
        logEvent({
          level: 'warn',
          kind: 'pr',
          message: 'merging without checking CI -- this token cannot read check runs',
          detail: `${verdict.why}. Harmless when the repository has no CI. If it does, grant the token Checks: read, or shipshape will merge over a red check.`,
        })
      }
      return null
    case 'unknown':
      return verdict.why
  }
}
