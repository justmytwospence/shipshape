/**
 * The words an update's outcome is told in, in one place.
 *
 * The same event used to be named separately by the badge on a row, the Inbox's \"what
 * happened\" list, the Status page's deploy list and the merge preview -- and they had
 * started to disagree: a refusal in the merge preview read \"held\", the word the badge
 * reserves for the on-request rung. Each outcome now has one name, as a badge and as the
 * verb in a sentence, and every view that tells it reads it from here.
 *
 * Classes are whole literals: Tailwind only emits what it can see.
 */

export interface OutcomeWords {
  /** On a badge: \"Rolled back\". */
  badge: string
  /** In a sentence after the service name: \"was rolled back\". */
  verb: string
  /** The badge's colour. */
  badgeCls: string
  /** The dot beside a line in a list. */
  dotCls: string
}

export const OUTCOMES = {
  opened: { badge: 'Waiting on you', verb: 'opened', badgeCls: 'badge-warning', dotCls: 'bg-info' },
  merged: { badge: 'Merged', verb: 'merged', badgeCls: 'badge-info', dotCls: 'bg-info' },
  deployed: { badge: 'Soaking', verb: 'deployed', badgeCls: 'badge-info', dotCls: 'bg-info' },
  verified: { badge: 'Verified', verb: 'verified', badgeCls: 'badge-success', dotCls: 'bg-success' },
  'left-stopped': { badge: 'Left stopped', verb: 'left stopped', badgeCls: 'badge-ghost', dotCls: 'bg-base-300' },
  degraded: { badge: 'Degraded', verb: 'went degraded', badgeCls: 'badge-warning', dotCls: 'bg-warning' },
  failed: { badge: 'Deploy failed', verb: 'failed to deploy', badgeCls: 'badge-error', dotCls: 'bg-error' },
  'rolled-back': { badge: 'Rolled back', verb: 'was rolled back', badgeCls: 'badge-error', dotCls: 'bg-error' },
  skipped: { badge: 'Skipped', verb: 'skipped', badgeCls: 'badge-ghost', dotCls: 'bg-base-300' },
  superseded: { badge: 'Superseded', verb: 'superseded', badgeCls: 'badge-ghost', dotCls: 'bg-base-300' },
} as const satisfies Record<string, OutcomeWords>

export type Outcome = keyof typeof OUTCOMES
