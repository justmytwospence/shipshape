import { runProposePass } from '../propose/run.ts'
import { mergeUpdatePr, openPrForUpdate } from '../web/server.ts'
import { actionsFor, refusalFor, type Verb } from './actions.ts'
import { contextFor, runVerb, type VerbResult } from './verbs.ts'

/**
 * Every verb an operator can apply to one update, from any front door: the dashboard,
 * an alert card (the actions listener) or an agent (the MCP server). One dispatcher, so
 * each door differs only in which verbs it offers, never in what a verb does or when it
 * is allowed -- every one goes through {@link actionsFor} first.
 */
export const OPERATOR_VERBS = [
  'merge-deploy',
  'open-pr',
  'deploy',
  'redeploy',
  'retry',
  'rollback',
  'rerun-review',
  'propose',
  'skip',
  'release-hold',
  'ack',
] as const satisfies readonly Verb[]
export type OperatorVerb = (typeof OPERATOR_VERBS)[number]

export const isOperatorVerb = (v: string): v is OperatorVerb => (OPERATOR_VERBS as readonly string[]).includes(v)

export async function runOperatorVerb(id: number, verb: OperatorVerb): Promise<VerbResult> {
  const found = contextFor(id)
  if (!found) return { ok: false, message: 'that update no longer exists' }
  if (!actionsFor(found.ctx).includes(verb)) return { ok: false, message: refusalFor(verb, found.ctx) }
  if (verb === 'merge-deploy') {
    if (!found.ctx.prNumber) return { ok: false, message: 'there is no pull request to merge' }
    return mergeUpdatePr(found.ctx.prNumber, id)
  }
  if (verb === 'open-pr') return openPrForUpdate(id)
  if (verb === 'propose') {
    if (!found.ctx.prNumber) return { ok: false, message: 'there is no pull request to draft changes for' }
    return proposeForPr(found.ctx.prNumber)
  }
  return runVerb(id, verb)
}

/** Draft config changes for one pull request, and say what came of it. */
export async function proposeForPr(number: number): Promise<VerbResult> {
  const r = await runProposePass(number)
  if (r.drafted > 0) return { ok: true, message: 'Drafted. The changes are on the pull request.' }
  if (r.failed > 0) return { ok: false, message: 'Could not draft; see the activity log.' }
  // Drafting costs a model call, so a spent budget refuses before it looks at the pull
  // request at all. Saying "nothing to draft" there would tell the operator the opposite
  // of what happened -- that the pull request needed no change.
  if (r.reason === 'budget') {
    return { ok: false, message: 'The analysis budget for this window is spent, so nothing was drafted.' }
  }
  if (r.reason === 'unconfigured') {
    return { ok: false, message: 'Drafting needs an Anthropic key and a GitHub token; one of them is missing.' }
  }
  return { ok: false, message: 'Nothing to draft for this pull request.' }
}
