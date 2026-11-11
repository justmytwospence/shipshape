import type { Policy } from '../config.ts'
import type { ServiceClass } from '../policy.ts'
import type { Verb } from './actions.ts'

/**
 * What a button says, and what its confirmation promises.
 *
 * Both used to be constants, and a confirmation that describes some other configuration
 * than the one in force is worse than none: it is the one sentence read right before
 * acting. So the steps are derived from the same facts the code that acts reads --
 * including that a change carrying drafted config is reported rather than rolled back
 * when it fails.
 *
 * Derived here, from the same facts the code that acts reads, and nowhere else.
 */

export interface PresentFacts {
  stack: string
  service: string
  fromTag: string
  toTag: string
  /** `proposed` when the change carries drafted config edits. */
  scope: 'tag-only' | 'proposed' | 'modified' | null
  /** Every live update the decision covers, this one included. */
  members: { stack: string; service: string; cls: ServiceClass }[]
  /** A restore point will be taken first. */
  restorePoint: boolean
}

export interface Presentation {
  label: string
  /** The confirmation's "what happens" list, for verbs that ask before acting. */
  steps?: string[]
}

/** A number of seconds as a person would say it. */
export function spoken(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return minutes === 1 ? 'a minute' : `${minutes} minutes`
  const hours = Math.round(minutes / 60)
  return hours === 1 ? 'an hour' : `${hours} hours`
}

function shipSteps(f: PresentFacts, policy: Policy): string[] {
  const steps = ['merge it into main with a merge commit']
  const others = f.members.filter((m) => !(m.stack === f.stack && m.service === f.service))
  if (others.length > 0) {
    const names = others.length > 4 ? `${others.slice(0, 4).map((m) => m.service).join(', ')} and ${others.length - 4} more` : others.map((m) => m.service).join(', ')
    steps.push(`which also updates ${names}`)
  }
  if (f.restorePoint) steps.push('take a restore point of the data first')
  steps.push('sync the checkout on this host')
  const d = policy.deploy
  steps.push(`bring ${f.stack} up with docker compose, or leave it stopped if it is not running`)
  steps.push(`watch it for up to ${spoken(d.verify_window_s)}`)
  if (d.soak_s > 0) steps.push(`look again ${spoken(d.soak_s)} later before calling it verified`)
  if (f.scope && f.scope !== 'tag-only') {
    steps.push('if it fails, tell you rather than roll back — this change carries more than an image tag')
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
    if (verb === 'ship') {
      out[verb] = { label: 'Ship', steps: shipSteps(f, policy) }
    } else if (verb === 'always-ship') {
      out[verb] = {
        label: 'Always ship',
        steps: ['write a standing rule to policy.yaml, as a commit, for this kind of update', ...shipSteps(f, policy)],
      }
    } else if (verb === 'snooze') {
      out[verb] = { label: 'Snooze 1 week' }
    } else if (verb === 'rollback') {
      out[verb] = { label: 'Roll back', steps: rollbackSteps(f) }
    }
  }
  return out
}
