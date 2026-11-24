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
  opened: { badge: 'Waiting on you', verb: 'drafted', badgeCls: 'badge-warning', dotCls: 'bg-info' },
  merged: { badge: 'Shipped', verb: 'shipped', badgeCls: 'badge-info', dotCls: 'bg-info' },
  deployed: { badge: 'Soaking', verb: 'deployed', badgeCls: 'badge-info', dotCls: 'bg-info' },
  verified: { badge: 'Verified', verb: 'verified', badgeCls: 'badge-success', dotCls: 'bg-success' },
  'left-stopped': {
    badge: 'Left stopped',
    verb: 'left stopped',
    badgeCls: 'badge-ghost',
    dotCls: 'bg-base-content/50',
  },
  degraded: { badge: 'Degraded', verb: 'went degraded', badgeCls: 'badge-warning', dotCls: 'bg-warning' },
  failed: { badge: 'Deploy failed', verb: 'failed to deploy', badgeCls: 'badge-error', dotCls: 'bg-error' },
  'rolled-back': { badge: 'Rolled back', verb: 'was rolled back', badgeCls: 'badge-error', dotCls: 'bg-error' },
  skipped: { badge: 'Skipped', verb: 'skipped', badgeCls: 'badge-ghost', dotCls: 'bg-base-content/50' },
  superseded: { badge: 'Superseded', verb: 'superseded', badgeCls: 'badge-ghost', dotCls: 'bg-base-content/50' },
} as const satisfies Record<string, OutcomeWords>

export type Outcome = keyof typeof OUTCOMES

/** What a review's recommendation means, in the words the interface uses for it. */
export const VERDICT_LABEL: Record<'approve' | 'caution' | 'block', string> = {
  approve: 'Safe to apply',
  caution: 'Read first',
  block: 'Breaking changes',
}

/** Digest refs are unreadable at full length; keep the tag and 12 hex. */
export function short(ref: string): string {
  const at = ref.indexOf('@sha256:')
  return at === -1 ? ref : `${ref.slice(0, at)}@${ref.slice(at + 8, at + 20)}`
}

/**
 * The versions a set of updates moves between, as one line: `1.37.2 -> 1.37.3`.
 *
 * One function, so the line a pull request opened with, the line it was retargeted with
 * and the line its deploy records cannot drift apart. They were three hand-written
 * template strings once, and the deploy's said something else entirely -- "jackett up in
 * 47s" -- which answers how long it took when the reader wanted to know what landed.
 *
 * A group whose members all move between the same two tags is written once, after their
 * names, because that is what a group almost always is. Members on different tags are
 * each written out: folding them onto the first member's tags would state a version one
 * of them never ran. `named` puts the service in front of a lone update too, for the
 * places that have nothing else saying which service it is.
 */
export function changeText(
  members: readonly { service: string; from_tag: string; to_tag: string }[],
  opts: { named?: boolean } = {},
): string | null {
  const m = members[0]
  if (!m) return null
  const shared = members.every((x) => x.from_tag === m.from_tag && x.to_tag === m.to_tag)
  if (shared) {
    const arrow = `${short(m.from_tag)} -> ${short(m.to_tag)}`
    if (members.length === 1) return `${opts.named ? `${m.service} ` : ''}${arrow}`
    return `${members.map((x) => x.service).join(', ')} ${arrow}`
  }
  return members.map((x) => `${x.service} ${short(x.from_tag)} -> ${short(x.to_tag)}`).join(', ')
}
