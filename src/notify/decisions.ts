import { loadPolicy } from '../config.ts'
import { getDb } from '../db.ts'
import { env } from '../config.ts'
import { short } from '../gitops/body.ts'
import { repositoryOf, shortRepository, type Hold } from '../policy.ts'
import { HOLD_COLUMNS, holdsForRow, type HoldRow } from '../updates/holds.ts'
import { notify, resolveIncident, type IncidentAction } from './index.ts'

/**
 * One card per decision waiting on you, live.
 *
 * A decision is one image repository at one target tag, across every stack that runs it
 * (nineteen sidecars on one agentgateway bump are one card, not nineteen). The key is per
 * repository, so a newer target edits the same card. Each card leads with the question,
 * offers its verbs as one-tap actions, escalates once if it waits, and is resolved the
 * moment the update stops waiting -- shipped, skipped, snoozed, superseded.
 *
 * Synced every loop tick; a card is re-sent only when what it says changed (an edit,
 * which never pushes). Not every Inbox row is a card: breakage has its own incident
 * (`shipshape:deploy:*`), and a snoozed or frozen update is parked by design.
 */

export const DECISION_PREFIX = 'shipshape:decision:'
const LEGACY_PREFIX = 'shipshape:update:'
const sent = new Map<string, string>()

export interface Decision {
  repository: string
  members: HoldRow[]
  /** Blocking holds, de-duplicated across members, in first-seen order. */
  holds: Hold[]
  since: string
}

/** Every decision currently waiting, newest target per repository. */
export function currentDecisions(): Decision[] {
  const { policy } = loadPolicy()
  const rows = getDb()
    .prepare(
      `SELECT ${HOLD_COLUMNS} FROM updates u
        WHERE u.state = 'detected' AND COALESCE(u.detail, '') != 'rolling'
        ORDER BY u.detected_at DESC, u.id DESC`,
    )
    .all() as HoldRow[]

  const byRepo = new Map<string, { rows: HoldRow[]; holds: Map<string, Hold> }>()
  const targetOf = new Map<string, string>()
  for (const r of rows) {
    let repo: string
    try {
      repo = repositoryOf(r.image)
    } catch {
      continue
    }
    // Newest detection first: the first row seen for a repository names its target.
    if (!targetOf.has(repo)) targetOf.set(repo, r.to_tag)
    if (targetOf.get(repo) !== r.to_tag) continue
    const h = holdsForRow(r, policy)
    if (h.status.status !== 'decision') continue
    const e = byRepo.get(repo) ?? { rows: [], holds: new Map<string, Hold>() }
    e.rows.push(r)
    for (const hold of h.holds) if (!e.holds.has(hold.kind)) e.holds.set(hold.kind, hold)
    byRepo.set(repo, e)
  }

  return [...byRepo.entries()].map(([repository, e]) => {
    const members = e.rows.sort((a, b) => a.id - b.id)
    const since = members.map((m) => m.decision_since ?? m.detected_at).sort()[0]!
    return { repository, members, holds: [...e.holds.values()], since }
  })
}

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
  const name = shortRepository(first.image)
  const lines: string[] = [`Ship? ${d.holds[0]?.text ?? 'this update needs a decision'}`]
  for (const h of d.holds.slice(1)) lines.push(`- ${h.text}`)

  const db = getDb()
  const v = db
    .prepare(`SELECT summary FROM verdicts WHERE image = ? AND from_tag = ? AND to_tag = ? AND error IS NULL`)
    .get(first.image, first.from_tag, first.to_tag) as { summary: string | null } | undefined
  if (v?.summary) lines.push('', v.summary.replace(/\s+/g, ' ').trim().slice(0, 300))

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

  const services = d.members.length === 1 ? first.service : `${d.members.length} services`
  const title =
    d.members.length === 1
      ? `${first.stack === first.service ? first.service : `${first.stack}/${first.service}`} ${short(first.from_tag)} → ${short(first.to_tag)}`
      : `${name} ${short(first.from_tag)} → ${short(first.to_tag)} · ${services}`

  const verbs = ['ship', 'snooze', ...(d.holds.every((h) => h.waivable) ? ['always-ship'] : []), 'skip']
  const escalate = now - Date.parse(d.since) > policy.notify.escalate_after_days * 86_400_000
  const origin = process.env.SHIPSHAPE_ALLOWED_ORIGIN
  return {
    key: `${DECISION_PREFIX}${d.repository}`,
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
    await resolveIncident(key)
    sent.delete(key)
    changed++
  }
  return changed
}

/** For the tests. */
export function resetDecisionCards(): void {
  sent.clear()
}
