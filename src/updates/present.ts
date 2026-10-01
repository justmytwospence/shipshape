import type { Policy } from '../config.ts'
import { deployNeedsYou, type EffectiveTier } from '../policy.ts'
import type { Verb } from './actions.ts'

/**
 * What a button says, and what its confirmation promises.
 *
 * Both used to be constants. The merge button read "Merge & deploy" on a service whose
 * deploy waits for a person, and the dialog behind it listed "squash, watch it for five
 * minutes, soak for thirty more, put the old version back automatically" whatever
 * policy.yaml said -- including for a pull request carrying drafted config, which is
 * reported rather than rolled back when it fails. A confirmation that describes some
 * other configuration is worse than none: it is the one sentence read right before acting.
 *
 * Derived here, from the same facts the code that acts reads, and nowhere else.
 */

export interface PresentFacts {
  stack: string
  service: string
  fromTag: string
  toTag: string
  pr: { number: number; scope: 'tag-only' | 'proposed' | 'modified' } | null
  /** Every live update the pull request carries, this one included. */
  members: { stack: string; service: string; tier: EffectiveTier }[]
}

export interface Presentation {
  label: string
  /** The confirmation's "what happens" list, for verbs that ask before acting. */
  steps?: string[]
}

/**
 * Whether merging this starts the deploy by itself.
 *
 * The same rule `deployWaits` applies when the merge lands: one member whose rung wants a
 * person present makes the whole invocation wait, because bringing a stack up recreates
 * every service named in it.
 */
export function mergeDeploys(f: Pick<PresentFacts, 'members'>): boolean {
  return f.members.length > 0 && !f.members.some((m) => deployNeedsYou(m.tier))
}

/** A number of seconds as a person would say it. */
export function spoken(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return minutes === 1 ? 'a minute' : `${minutes} minutes`
  const hours = Math.round(minutes / 60)
  return hours === 1 ? 'an hour' : `${hours} hours`
}

const METHOD: Record<Policy['merge_method'], (n: number) => string> = {
  squash: (n) => `squash #${n} into main`,
  merge: (n) => `merge #${n} into main`,
  rebase: (n) => `rebase #${n} onto main`,
}

function mergeSteps(f: PresentFacts, policy: Policy): string[] {
  const n = f.pr?.number ?? 0
  const steps = [METHOD[policy.merge_method](n)]
  const others = f.members.filter((m) => !(m.stack === f.stack && m.service === f.service))
  if (others.length > 0) {
    steps.push(`which also updates ${others.map((m) => m.service).join(', ')}`)
  }
  steps.push('sync the checkout on this host')
  if (!mergeDeploys(f)) {
    const waiting = f.members.filter((m) => deployNeedsYou(m.tier)).map((m) => m.service)
    steps.push(`stop there: ${waiting.join(', ')} ${waiting.length === 1 ? 'is' : 'are'} deployed by hand, so press Deploy when you are ready`)
    return steps
  }
  const d = policy.deploy
  steps.push(`bring ${f.stack} up with docker compose, or leave it stopped if it is not running`)
  steps.push(`watch it for up to ${spoken(d.verify_window_s)}`)
  if (d.soak_s > 0) steps.push(`look again ${spoken(d.soak_s)} later before calling it verified`)
  if (f.pr && f.pr.scope !== 'tag-only') {
    steps.push('if it fails, tell you rather than roll back — this pull request changes more than an image tag')
  } else if (d.rollback === 'auto') {
    steps.push('put the old version back automatically if it fails')
  } else if (d.rollback === 'suggest') {
    steps.push('if it fails, tell you how to put the old version back')
  } else {
    steps.push('if it fails, tell you — nothing is rolled back')
  }
  return steps
}

function rollbackSteps(f: PresentFacts): string[] {
  return [
    `revert the commit that landed ${f.toTag}`,
    `put ${f.stack} back on ${f.fromTag}, running only if it is running now`,
    'publish the revert so the next scan does not re-offer it',
  ]
}

/** The label and, where it asks first, the confirmation for each verb on offer. */
export function present(verbs: Verb[], f: PresentFacts, policy: Policy): Partial<Record<Verb, Presentation>> {
  const out: Partial<Record<Verb, Presentation>> = {}
  for (const verb of verbs) {
    if (verb === 'merge-deploy') {
      out[verb] = { label: mergeDeploys(f) ? 'Merge & deploy' : 'Merge', steps: mergeSteps(f, policy) }
    } else if (verb === 'rollback') {
      out[verb] = { label: 'Roll back', steps: rollbackSteps(f) }
    }
  }
  return out
}
