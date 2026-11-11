import { closeLocalChange } from '../gitops/ship.ts'
import { runProposePass } from '../propose/run.ts'
import { appendRule, describeRule, inferRule, publishRule } from '../rules.ts'
import { wakeLoop } from '../scheduler.ts'
import { getDb, logEvent } from '../db.ts'
import { changeText } from '../gitops/body.ts'
import { actionsFor, refusalFor, type Verb } from './actions.ts'
import { decisionMembers, type HoldRow } from './holds.ts'
import { setState } from './state.ts'
import { contextFor, runVerb, type VerbResult } from './verbs.ts'

/**
 * Every verb an operator can apply to one update, from any front door: the dashboard,
 * an alert card (the actions listener), a signed link or an agent (the MCP server). One
 * dispatcher, so each door differs only in which verbs it offers, never in what a verb
 * does or when it is allowed -- every one goes through {@link actionsFor} first.
 */
export const OPERATOR_VERBS = [
  'ship',
  'snooze',
  'always-ship',
  'skip',
  'deploy',
  'redeploy',
  'retry',
  'rollback',
  'rerun-review',
  'propose',
  'ack',
] as const satisfies readonly Verb[]
export type OperatorVerb = (typeof OPERATOR_VERBS)[number]

export const isOperatorVerb = (v: string): v is OperatorVerb => (OPERATOR_VERBS as readonly string[]).includes(v)

const SNOOZE_MS = 7 * 24 * 60 * 60_000

export async function runOperatorVerb(id: number, verb: OperatorVerb): Promise<VerbResult> {
  const found = contextFor(id)
  if (!found) return { ok: false, message: 'that update no longer exists' }
  if (!actionsFor(found.ctx).includes(verb)) return { ok: false, message: refusalFor(verb, found.ctx) }
  switch (verb) {
    case 'ship':
      return shipDecision(id)
    case 'snooze':
      return snoozeDecision(id)
    case 'always-ship':
      return alwaysShip(id)
    case 'skip':
      return skipDecision(id)
    case 'propose':
      return proposeForUpdate(id)
    default:
      return runVerb(id, verb)
  }
}

const names = (members: HoldRow[]) => changeText(members, { named: true }) ?? 'the update'

/**
 * Approve every update this decision covers, then wake the loop. The ship pass itself is
 * not run here: it can take minutes (a restore point, a build), a tap must not sit on that,
 * and two passes at once is exactly what the loop's own guard is for.
 */
function approve(id: number): HoldRow[] {
  const members = decisionMembers(id)
  const db = getDb()
  const now = new Date().toISOString()
  const mark = db.prepare(`UPDATE updates SET approved_at = ?, snoozed_until = NULL WHERE id = ?`)
  db.transaction(() => {
    for (const m of members) mark.run(now, m.id)
  })()
  wakeLoop()
  return members
}

function shipDecision(id: number): VerbResult {
  const members = approve(id)
  logEvent({
    level: 'info',
    kind: 'pr',
    stack: members[0]?.stack,
    message: `ship approved: ${names(members)}`,
  })
  return { ok: true, transient: true, message: `Shipping ${names(members)}. It lands on main within a minute, then deploys.` }
}

function snoozeDecision(id: number): VerbResult {
  const members = decisionMembers(id)
  const until = new Date(Date.now() + SNOOZE_MS).toISOString()
  const db = getDb()
  const mark = db.prepare(`UPDATE updates SET snoozed_until = ?, decision_since = ? WHERE id = ?`)
  db.transaction(() => {
    for (const m of members) mark.run(until, until, m.id)
  })()
  wakeLoop()
  return { ok: true, message: `Snoozed until ${until.slice(0, 10)}.` }
}

async function alwaysShip(id: number): Promise<VerbResult> {
  let rule
  try {
    rule = await inferRule(id)
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
  let sha: string
  try {
    sha = appendRule(rule).sha
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
  void publishRule()
  const members = approve(id)
  return {
    ok: true,
    transient: true,
    message:
      `Always ship: ${describeRule(rule)}. Rule ${rule.id} committed (${sha}). ` +
      `Shipping ${names(members)} now. I will still ask if a release is unsafe or needs a change from you.`,
  }
}

/** Not this version: every update the decision covers, and any drafted branch that carried them. */
function skipDecision(id: number): VerbResult {
  const members = decisionMembers(id)
  const db = getDb()
  for (const m of members) {
    setState(m.id, 'skipped', 'dismissed')
    const open = db
      .prepare(
        `SELECT p.id FROM prs p JOIN pr_updates pu ON pu.pr_id = p.id
          WHERE pu.update_id = ? AND p.kind = 'local' AND p.state = 'open'`,
      )
      .all(m.id) as { id: number }[]
    for (const p of open) closeLocalChange(p.id, 'skipped by the operator')
  }
  logEvent({ level: 'info', kind: 'pr', stack: members[0]?.stack, message: `${names(members)} dismissed by the operator` })
  return { ok: true, message: 'Skipped. It will not be offered again unless you ask for it.' }
}

/** Draft config changes for one update, and say what came of it. */
export async function proposeForUpdate(id: number): Promise<VerbResult> {
  const r = await runProposePass(id)
  if (r.drafted > 0) return { ok: true, message: 'Drafted. The changes are on the update; shipping it merges them too.' }
  if (r.failed > 0) return { ok: false, message: 'Could not draft; see the activity log.' }
  // Drafting costs a model call, so a spent budget refuses before it looks at the update
  // at all. Saying "nothing to draft" there would tell the operator the opposite of what
  // happened -- that the update needed no change.
  if (r.reason === 'budget') {
    return { ok: false, message: 'The analysis budget for this window is spent, so nothing was drafted.' }
  }
  if (r.reason === 'unconfigured') {
    return { ok: false, message: 'Drafting needs an Anthropic or OpenRouter key; neither is set.' }
  }
  return { ok: false, message: 'Nothing to draft for this update.' }
}
