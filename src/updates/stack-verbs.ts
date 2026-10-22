import { getDb } from '../db.ts'
import { actionsFor, refusalFor } from './actions.ts'
import { contextFor, runVerb, type VerbResult } from './verbs.ts'

/**
 * Verbs addressed to a stack rather than to an update: what a deploy incident
 * (`shipshape:deploy:<stack>`) can offer, because an alert card knows its stack and not
 * which update rows its deploy carried.
 *
 * The verb lands on the updates of the stack's newest deploy, the deploy the incident is
 * about, and goes through {@link actionsFor} exactly like a button would: offered on a
 * card is not the same as allowed now, and the answer to "no longer available" is the
 * same sentence the interface would give.
 */
export const STACK_VERBS = ['retry', 'rollback'] as const
export type StackVerb = (typeof STACK_VERBS)[number]

export function isStackVerb(v: string): v is StackVerb {
  return (STACK_VERBS as readonly string[]).includes(v)
}

/** The update rows of a stack's newest deploy, lowest id first. */
export function latestDeployUpdates(stack: string): number[] {
  const rows = getDb()
    .prepare(
      `SELECT du.update_id AS id FROM deploy_updates du
        WHERE du.deploy_id = (SELECT id FROM deploys WHERE stack = ? ORDER BY id DESC LIMIT 1)
        ORDER BY du.update_id`,
    )
    .all(stack) as { id: number }[]
  return rows.map((r) => r.id)
}

export async function runStackVerb(stack: string, verb: StackVerb): Promise<VerbResult> {
  const ids = latestDeployUpdates(stack)
  if (!ids.length) return { ok: false, message: `there is no deploy of ${stack} to ${verb}` }
  let first: ReturnType<typeof contextFor> = null
  for (const id of ids) {
    const found = contextFor(id)
    if (!found) continue
    first ??= found
    if (actionsFor(found.ctx).includes(verb)) return runVerb(id, verb)
  }
  return {
    ok: false,
    message: first ? refusalFor(verb, first.ctx) : `the updates of ${stack}'s last deploy no longer exist`,
  }
}
