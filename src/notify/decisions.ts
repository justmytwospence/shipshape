import { loadPolicy } from '../config.ts'
import { getDb } from '../db.ts'
import { env } from '../config.ts'
import { short } from '../gitops/body.ts'
import { shortRepository } from '../policy.ts'
import { currentDecisions, type Decision } from '../updates/holds.ts'
import { notify, resolveIncident, type IncidentAction } from './index.ts'

/**
 * One card per decision waiting on you, live.
 *
 * A decision is a stack: everything in it waiting on you, answered with one tap and
 * shipped as one merge commit. A bump fanned out across stacks with nothing else waiting
 * (nineteen sidecars on one agentgateway release) is one card keyed by its image instead
 * (`currentDecisions`, src/updates/holds.ts). Each card leads with the question, offers
 * its verbs as one-tap actions, escalates once if it waits, and is resolved -- removed
 * from the room -- the moment the update stops waiting: shipped, skipped, snoozed,
 * superseded. The record of what was decided is git and the Activity page.
 *
 * Synced every loop tick; a card is re-sent only when what it says changed (an edit,
 * which never pushes). Not every Inbox row is a card: breakage has its own incident
 * (`shipshape:deploy:*`), and a snoozed or frozen update is parked by design.
 */

export const DECISION_PREFIX = 'shipshape:decision:'
const LEGACY_PREFIX = 'shipshape:update:'
const sent = new Map<string, string>()

export { currentDecisions, type Decision }

const VERB_UI: Record<string, [string, string]> = {
  ship: ['🚀', 'ship'],
  snooze: ['💤', 'snooze 1w'],
  'always-ship': ['♾️', 'always ship'],
  skip: ['⏭️', 'skip'],
}

export interface Card {
  key: string
  title: string
  body: string
  priority: 3 | 4
  click?: string
  actions?: IncidentAction[]
}

export function cardFor(d: Decision, now = Date.now()): Card {
  const policy = loadPolicy().policy
  const first = d.members[0]!
  const db = getDb()
  const lines: string[] = []

  if (d.members.length === 1 || d.repository) {
    // One bump: the question, its holds, and what the review said.
    lines.push(`Ship? ${d.holds[0]?.text ?? 'this update needs a decision'}`)
    for (const h of d.holds.slice(1)) lines.push(`- ${h.text}`)
    if (d.repository && d.members.length > 1) {
      lines.push('', `In ${[...new Set(d.members.map((m) => m.stack))].join(', ')}.`)
    }
    const v = db
      .prepare(`SELECT summary FROM verdicts WHERE image = ? AND from_tag = ? AND to_tag = ? AND error IS NULL`)
      .get(first.image, first.from_tag, first.to_tag) as { summary: string | null } | undefined
    if (v?.summary) lines.push('', v.summary.replace(/\s+/g, ' ').trim().slice(0, 300))
  } else {
    // A stack: one line per update, each with what holds it.
    lines.push(`Ship these together? One merge commit, one deploy of ${d.stack}.`)
    for (const m of d.members) {
      const why = d.holdsOf.get(m.id)?.[0]?.text ?? 'needs a decision'
      lines.push(`- ${m.service} ${short(m.from_tag)} → ${short(m.to_tag)}: ${why}`)
    }
  }

  const drafted = db
    .prepare(`SELECT changed FROM proposals WHERE update_id IN (${d.members.map(() => '?').join(',')}) AND error IS NULL AND retryable = 0 ORDER BY id DESC LIMIT 1`)
    .get(...d.members.map((m) => m.id)) as { changed: string } | undefined
  if (drafted) {
    try {
      const c = JSON.parse(drafted.changed) as string[]
      if (c.length > 0) lines.push('', `Drafted: ${c.join('; ')}`)
    } catch {
      /* ignore */
    }
  }

  const where = first.stack === first.service ? first.service : `${first.stack}/${first.service}`
  const title =
    d.members.length === 1
      ? `${where} ${short(first.from_tag)} → ${short(first.to_tag)}`
      : d.repository
        ? `${shortRepository(first.image)} ${short(first.from_tag)} → ${short(first.to_tag)} · ${d.members.length} services`
        : `${d.stack}: ${d.members.length} updates`

  const verbs = ['ship', 'snooze', ...(d.holds.every((h) => h.waivable) ? ['always-ship'] : []), 'skip']
  const escalate = now - Date.parse(d.since) > policy.notify.escalate_after_days * 86_400_000
  const origin = process.env.SHIPSHAPE_ALLOWED_ORIGIN
  return {
    key: `${DECISION_PREFIX}${d.key}`,
    title,
    body: lines.join('\n'),
    priority: escalate ? 4 : 3,
    click: origin ? `${origin.replace(/\/$/, '')}/updates/${first.id}` : undefined,
    actions: env.mcpPort
      ? verbs.map((verb) => {
          const [emoji, label] = VERB_UI[verb]!
          return { emoji, label, do: { target: 'shipshape' as const, verb, update: first.id } }
        })
      : undefined,
  }
}

/** Bring the cards in line with what is waiting. Returns how many were sent or resolved. */
export async function syncDecisionCards(): Promise<number> {
  let changed = 0
  const live = new Set<string>()
  for (const d of currentDecisions()) {
    const card = cardFor(d)
    live.add(card.key)
    const fingerprint = JSON.stringify(card)
    if (sent.get(card.key) === fingerprint) continue
    await notify({
      key: card.key,
      title: card.title,
      body: card.body,
      click: card.click,
      actions: card.actions,
      priority: card.priority,
      eventClass: 'decision',
    })
    sent.set(card.key, fingerprint)
    changed++
  }
  const open = getDb()
    .prepare(`SELECT key FROM incidents WHERE open = 1 AND (key LIKE ? OR key LIKE ?)`)
    .all(`${DECISION_PREFIX}%`, `${LEGACY_PREFIX}%`) as { key: string }[]
  for (const { key } of open) {
    if (live.has(key)) continue
    await resolveIncident(key, { redact: true, eventClass: 'decision' })
    sent.delete(key)
    changed++
  }
  return changed
}

/** For the tests. */
export function resetDecisionCards(): void {
  sent.clear()
}
