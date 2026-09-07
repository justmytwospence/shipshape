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
  | 'merge-deploy' // squash-merge the pull request, then bring it up
  | 'open-pr' // the on-request rung: ask for the pull request
  | 'deploy' // merged, waiting: bring it up now
  | 'redeploy' // a rolling tag moved: pull and bring it up
  | 'retry' // it failed or was skipped: go round again
  | 'rollback' // put the previous version back
  | 'rerun-review' // read the changelog again
  | 'propose' // draft the config changes this update needs
  | 'skip' // not this version
  | 'release-hold' // you asked shipshape to hold this; let it go again
  | 'ack' // seen; stop showing it as needing attention

/**
 * Verbs that can carry a state on their own. Which one actually does is positional --
 * `actionsFor` returns them in priority order and the first of these is the button --
 * because prominence is a property of the situation, not of the verb: re-reading a
 * changelog is the whole point when the review failed, and a footnote when there is a
 * merge in front of you.
 */
const PROMINENT: ReadonlySet<Verb> = new Set<Verb>([
  'merge-deploy',
  'open-pr',
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
  | 'degraded'
  | 'failed'
  | 'rolled-back'
  | 'error'
  | 'superseded'

export interface ActionContext {
  state: UpdateState
  /** `rolling` marks a tag that moved under us: there is nothing to change in git. */
  detail?: string | null
  prNumber?: number | null
  prState?: 'open' | 'merged' | 'closed' | null
  prScope?: 'tag-only' | 'proposed' | 'modified' | null
  userOwned?: boolean
  mergeCommitSha?: string | null
  deployStatus?: DeployStatus | null
  verdictError?: boolean
  hasVerdict?: boolean
  hasProposal?: boolean
  ackedAt?: string | null
  /** From `images.current_tag`: whether the file still sits on the version we came from. */
  atFromTag?: boolean
  /** Why this pull request is being held, when somebody asked shipshape to hold it. */
  held?: string | null
}

const ROLLING = (c: ActionContext) => c.detail === 'rolling'

export function actionsFor(c: ActionContext): Verb[] {
  const out: Verb[] = []
  const deploy = c.deployStatus ?? null

  switch (c.state) {
    case 'detected':
      // A rolling tag has no version to bump: the only way to adopt it is to bring the
      // service up again, and the only way to refuse is to say so.
      if (ROLLING(c)) out.push('redeploy', 'skip')
      else out.push('skip')
      break

    case 'held':
      out.push('open-pr', 'skip')
      break

    case 'pr_open':
      // A review that failed outright is the thing to deal with first: merging is still
      // offered, but the button asks for the reading rather than the merge.
      if (c.verdictError) out.push('rerun-review')
      if (c.prNumber) out.push('merge-deploy')
      // Only offered when there is one. A hold is set by asking for it in a comment
      // rather than by pressing anything -- somebody who does not want a merge simply
      // does not press Merge -- so this is the half that needs a button.
      if (c.held) out.push('release-hold')
      if (c.prScope === 'tag-only' && !c.userOwned && !c.hasProposal) out.push('propose')
      if (!c.verdictError && !c.hasVerdict) out.push('rerun-review')
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
    case 'merge-deploy':
      return c.prNumber ? `this update is ${stage}, not waiting on a merge` : 'there is no pull request to merge'
    case 'open-pr':
      return `a pull request is not what ${stage} needs next`
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
      return 'the changelog review runs on an open pull request'
    case 'propose':
      return 'config changes can only be drafted onto a pull request shipshape still owns'
    case 'skip':
      return `this update is already ${stage}`
    case 'release-hold':
      return 'nothing is holding this pull request'
    case 'ack':
      return 'there is nothing outstanding to acknowledge'
  }
}
