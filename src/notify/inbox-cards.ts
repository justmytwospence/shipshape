import { env, loadPolicy } from '../config.ts'
import { getDb } from '../db.ts'
import type { Verb } from '../updates/actions.ts'
import { inboxNeedsYou, type AttentionItem } from '../updates/queries.ts'
import { notify, resolveIncident, type IncidentAction } from './index.ts'

/**
 * One card per update waiting on you, in the router's Shipshape room: the Inbox, live.
 *
 * Each is an incident keyed `shipshape:update:<stack>/<service>` -- by service, not by
 * update, so a newer version that supersedes a waiting one edits its card in place -- priority 2 (a silent notice: a
 * decision never pushes), with its verbs as one-tap actions, and resolved the moment the
 * update stops waiting -- merged, skipped, superseded. Synced on every loop tick; a card
 * is re-sent only when what it says changed (an edit, which never pushes).
 *
 * Not every Inbox row is a card. Breakage has its own incident (`shipshape:deploy:*`), so
 * deploy-failed, rolled-back and degraded are left to it. On-request updates are parked
 * by design until asked for. An auto update's pull request merges itself unless the
 * review holds it or shipshape is paused, so it only waits on you then. A merge waits on
 * your deploy only on the attended rung.
 */

const PREFIX = 'shipshape:update:'
const sent = new Map<string, string>()

const VERB_UI: Partial<Record<Verb, [string, string]>> = {
  'merge-deploy': ['🚀', 'merge & deploy'],
  deploy: ['🚀', 'deploy'],
  redeploy: ['🔁', 'redeploy'],
  'open-pr': ['📬', 'open PR'],
  'release-hold': ['▶️', 'release hold'],
  'rerun-review': ['📖', 're-read changelog'],
  skip: ['⏭️', 'skip version'],
}

const WHY: Record<string, string> = {
  'pr-waiting': 'waits for your merge',
  'ready-to-deploy': 'merged, waits for your deploy',
  'rolling-moved': 'rolling tag moved',
  'review-failed': 'nobody could read the changelog',
}

export function waitsOnYou(item: AttentionItem, paused: boolean): boolean {
  const u = item.update
  switch (item.kind) {
    case 'pr-waiting':
      return u.tier !== 'auto' || paused || !!u.pr?.held || u.verdict?.recommendation === 'caution' || u.verdict?.recommendation === 'block'
    case 'ready-to-deploy':
      return u.tier === 'attended'
    case 'rolling-moved':
    case 'review-failed':
      return true
    default:
      return false
  }
}

export interface Card {
  key: string
  title: string
  body: string
  click?: string
  actions?: IncidentAction[]
}

export function cardFor(item: AttentionItem): Card {
  const u = item.update
  const name = u.stack === u.service ? u.service : `${u.stack}/${u.service}`
  const lines = [`${WHY[item.kind] ?? item.kind} · ${u.magnitude} · ${u.tier}${u.pr ? ` · #${u.pr.number}` : ''}`]
  const v = u.verdict
  if (v?.error) lines.push(`Review failed: ${v.error.slice(0, 200)}`)
  else if (v?.recommendation) {
    lines.push(`Review: ${v.recommendation}${v.confidence ? ` (${v.confidence})` : ''}${v.provisional ? ', screen only' : ''}${v.summary ? ` — ${v.summary.slice(0, 300)}` : ''}`)
    for (const b of v.breakingChanges.slice(0, 3)) lines.push(`- breaking: ${b.slice(0, 160)}`)
    for (const m of v.migrationSteps.slice(0, 3)) lines.push(`- step: ${m.slice(0, 160)}`)
  }
  if (u.pr?.held) lines.push(`Held: ${u.pr.held.slice(0, 200)}`)
  const origin = process.env.SHIPSHAPE_ALLOWED_ORIGIN
  const verbs = [u.primary, ...u.actions.filter((a) => a !== u.primary && a !== 'skip'), 'skip' as Verb]
    .filter((a, i, all): a is Verb => !!a && !!VERB_UI[a] && u.actions.includes(a) && all.indexOf(a) === i)
    .slice(0, 3)
  return {
    key: `${PREFIX}${u.stack}/${u.service}`,
    title: `${name} ${u.fromTag} → ${u.toTag}`,
    body: lines.join('\n'),
    click: u.pr?.url ?? (origin ? `${origin}/updates/${u.id}` : undefined),
    actions: env.actionsToken
      ? verbs.map((verb) => {
          const [emoji, label] = VERB_UI[verb]!
          return { emoji, label, do: { target: 'shipshape' as const, verb, update: u.id } }
        })
      : undefined,
  }
}

/** Bring the cards in line with the Inbox. Returns how many were sent or resolved. */
export async function syncInboxCards(items: AttentionItem[] = inboxNeedsYou()): Promise<number> {
  const { policy } = loadPolicy()
  let changed = 0
  const live = new Set<string>()
  for (const item of items) {
    if (!waitsOnYou(item, policy.paused)) continue
    const card = cardFor(item)
    // Newest first (inboxNeedsYou's order): a service's later rows are older versions.
    if (live.has(card.key)) continue
    live.add(card.key)
    const fingerprint = JSON.stringify(card)
    if (sent.get(card.key) === fingerprint) continue
    await notify({ key: card.key, title: card.title, body: card.body, click: card.click, actions: card.actions, priority: 2 })
    sent.set(card.key, fingerprint)
    changed++
  }
  const open = getDb()
    .prepare(`SELECT key FROM incidents WHERE open = 1 AND key LIKE ?`)
    .all(`${PREFIX}%`) as { key: string }[]
  for (const { key } of open) {
    if (live.has(key)) continue
    await resolveIncident(key)
    sent.delete(key)
    changed++
  }
  return changed
}
