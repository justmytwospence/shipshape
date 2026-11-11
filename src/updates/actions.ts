import type { Hold, ServiceClass } from '../policy.ts'
import type { UpdateState } from './state.ts'

/**
 * What can be done to an update right now.
 *
 * One list, derived from state rather than restated per view, because the alternative is
 * a button that renders and a route that refuses -- or worse, a route that does not
 * refuse. The views render exactly what this returns and the routes check it before
 * acting, so "the button was there" and "the action was allowed" cannot come apart.
 */
export type Verb =
  | 'ship' // merge it into main now and bring it up, whatever is holding it
  | 'snooze' // not now: ask again in a week
  | 'always-ship' // ship, and write the rule that stops this question coming back
  | 'skip' // not this version
  | 'deploy' // merged, waiting: bring it up now
  | 'redeploy' // a rolling tag moved: pull and bring it up
  | 'retry' // it failed or was skipped: go round again
  | 'rollback' // put the previous version back
  | 'rerun-review' // read the changelog again
  | 'propose' // draft the config changes this update needs
  | 'ack' // seen; stop showing it as needing attention

/**
 * Verbs that can carry a state on their own. Which one actually does is positional --
 * `actionsFor` returns them in priority order and the first of these is the button --
 * because prominence is a property of the situation, not of the verb: re-reading a
 * changelog is the whole point when the review failed, and a footnote when there is a
 * merge in front of you.
 */
const PROMINENT: ReadonlySet<Verb> = new Set<Verb>([
  'ship',
  'deploy',
  'redeploy',
  'retry',
  'rollback',
  'rerun-review',
])

/** The one action the interface puts a button on, if there is one. */
export function primaryVerb(verbs: readonly Verb[]): Verb | null {
  return verbs.find((v) => PROMINENT.has(v)) ?? null
}

/** Deploy rows this update points at, newest first, as far as the verbs care. */
export type DeployStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'deployed'
  | 'verified'
  | 'left-stopped'
  | 'degraded'
  | 'failed'
  | 'rolled-back'
  | 'error'
  | 'superseded'

export interface ActionContext {
  state: UpdateState
  /** `rolling` marks a tag that moved under us: there is nothing to change in git. */
  detail?: string | null
  /** The service's class (src/policy.ts). */
  cls?: ServiceClass
  /** Holds that still ask for a person; empty when nothing is in the way. */
  holds?: Hold[]
  /** Put off by a Snooze that has not run out. */
  snoozed?: boolean
  prScope?: 'tag-only' | 'proposed' | 'modified' | null
  mergeCommitSha?: string | null
  deployStatus?: DeployStatus | null
  verdictError?: boolean
  hasVerdict?: boolean
  /** A reader has read it -- not only the screen. */
  hasReaderVerdict?: boolean
  hasProposal?: boolean
  ackedAt?: string | null
  /** From `images.current_tag`: whether the file still sits on the version we came from. */
  atFromTag?: boolean
  /**
   * The service is a fork of its upstream image (FORKS.md). It changes no verb: shipping
   * a fork rebases our fixes onto the new release, or retires the fork, and the deploy
   * builds it -- so every stage offers what it offers a plain image.
   */
  fork?: boolean
}

const ROLLING = (c: ActionContext) => c.detail === 'rolling'

export function actionsFor(c: ActionContext): Verb[] {
  const out: Verb[] = []
  const deploy = c.deployStatus ?? null

  switch (c.state) {
    case 'detected': {
      // A rolling tag has no version to bump: the only way to adopt it is to bring the
      // service up again, and the only way to refuse is to say so.
      if (ROLLING(c)) {
        out.push('redeploy', 'skip')
        break
      }
      const holds = c.holds ?? []
      // Ship is always offered: it is the operator saying yes, which outranks a hold, the
      // cooldown and pause alike. The rest depend on there being something to answer.
      out.push('ship')
      if (holds.length > 0 && !c.snoozed) out.push('snooze')
      // Only when every hold is one a rule may waive: a lifeline, an unsafe verdict and a
      // list of work are never waivable, so there is nothing for "always" to mean.
      if (holds.length > 0 && holds.every((h) => h.waivable)) out.push('always-ship')
      // Read again when there is no reading, or when the reading is what is in the way: a
      // verdict that approved is not re-read on a whim -- each read is a model call -- but
      // one that says unsafe, or lists work, is exactly the one worth disputing.
      if (c.verdictError || !c.hasVerdict || holds.some((h) => h.kind === 'unsafe' || h.kind === 'needs-action')) {
        out.push('rerun-review')
      }
      if (holds.some((h) => h.kind === 'needs-action') && !c.hasProposal) out.push('propose')
      out.push('skip')
      break
    }

    case 'frozen':
      out.push('ship', 'skip')
      break

    case 'pr_open':
      // A v1 pull request the cutover has not closed yet. Nothing to do but skip it.
      out.push('skip')
      break

    case 'merged':
      // Either it is waiting for the button, or the last attempt did not land.
      if (deploy === 'ready' || deploy === 'pending') out.push('deploy')
      else if (deploy === 'failed' || deploy === 'error') out.push('retry')
      break

    case 'deploying':
      // Nothing to offer: it is happening. The view polls instead.
      break

    case 'deployed':
    case 'verified':
      if (c.mergeCommitSha) out.push('rollback')
      if (deploy === 'degraded' && !c.ackedAt) out.push('ack')
      // A version that is running and that nothing has read: the reading is still worth
      // having, and it is the only way to get one for a patch that applied on its own.
      if (!c.hasReaderVerdict && !ROLLING(c)) out.push('rerun-review')
      break

    case 'left-stopped':
      // The merge stands and nothing was started, so there is nothing to retry and nothing
      // to acknowledge -- only the version itself to take back. Roll back reads the service
      // again before it acts, the same as every deploy, so a stopped service stays stopped:
      // it puts the old version in the file without bringing anything up.
      //
      // A rolling tag has no merge to take back, and its move is not in any file: a Redeploy
      // that found the service stopped pulled nothing, and the scan has already advanced its
      // baseline, so nothing would ever offer this digest again. Redeploy stays on offer --
      // once the service is running it pulls and recreates, and while it is still stopped
      // it just reads Left stopped again.
      if (ROLLING(c)) out.push('redeploy')
      if (c.mergeCommitSha) out.push('rollback')
      break

    case 'failed':
      // The tombstone stands until someone decides otherwise. Retrying is only honest
      // when the file is back on the version we started from -- otherwise the change is
      // still in the tree and "try again" would mean something else.
      if (c.atFromTag !== false) out.push('retry')
      if (!c.ackedAt) out.push('ack')
      break

    case 'skipped':
      out.push('retry')
      break

    case 'superseded':
      break
  }

  return out
}

/** Whether the update is mid-flight, so the interface should keep asking. */
export function isTransient(c: ActionContext): boolean {
  return c.state === 'deploying' || c.deployStatus === 'running'
}

/**
 * Why a verb is not on offer, for the route that was asked for it anyway. A stale page,
 * a double tap, a bookmarked action: the answer is a sentence, never a 404.
 */
export function refusalFor(verb: Verb, c: ActionContext): string {
  const stage = c.detail === 'rolling' ? 'a rolling tag' : c.state
  switch (verb) {
    case 'ship':
      return `nothing to ship: this update is ${stage}`
    case 'snooze':
      return c.snoozed ? 'this update is already snoozed' : `there is nothing to put off while this update is ${stage}`
    case 'always-ship': {
      const stuck = (c.holds ?? []).find((h) => !h.waivable)
      return stuck
        ? `a hold here cannot be waived by a rule: ${stuck.text}`
        : `there is nothing for a rule to waive while this update is ${stage}`
    }
    case 'deploy':
      return c.state === 'merged'
        ? 'the deploy is already running or finished'
        : `nothing is waiting to be deployed for this update (${stage})`
    case 'redeploy':
      return 'redeploying is for a rolling tag that moved'
    case 'retry':
      return c.state === 'failed' && c.atFromTag === false
        ? 'the change is still in the tree, so there is nothing to re-land'
        : `there is nothing to retry while this update is ${stage}`
    case 'rollback':
      return c.mergeCommitSha
        ? `nothing has been deployed to roll back (${stage})`
        : 'the merge commit is unknown, so there is nothing to revert'
    case 'rerun-review':
      return 'the changelog review runs on an update that has not shipped yet'
    case 'propose':
      return 'config changes can only be drafted for an update that is waiting and has steps to take'
    case 'skip':
      return `this update is already ${stage}`
    case 'ack':
      return 'there is nothing outstanding to acknowledge'
  }
}
