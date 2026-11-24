import { getDb } from '../db/index.ts'
import { type Outcome } from './vocabulary.ts'
import { LIVE_STATES, sqlIn } from './state.ts'
import { type UpdateView, SELECT_UPDATE, type RawUpdate, toView } from './view.ts'

/** Why an update is in the inbox. The order here is the order the page shows them in. */
export const ATTENTION_KINDS = [
  'broken', // a deploy failed, rolled back, or degraded, and nothing newer has replaced it
  'decision', // an update waiting on you: the question on its card
  'ready-to-deploy', // v1: merged and waiting on the button
  'rolling-moved', // a rolling tag moved under us
] as const


export type AttentionKind = (typeof ATTENTION_KINDS)[number]


export interface AttentionItem {
  kind: AttentionKind
  update: UpdateView
}


/**
 * What is actually waiting on a person.
 *
 * Deliberately not "everything not finished": an update that will ship itself tonight is
 * not waiting on you, and putting it in the same list as a service that is down is how a
 * list stops being read.
 */
export function inboxNeedsYou(): AttentionItem[] {
  const db = getDb()
  const rows = db
    .prepare(
      `${SELECT_UPDATE}
        WHERE u.state IN ${sqlIn([...LIVE_STATES, 'merged', 'deployed', 'verified', 'failed'])}
        ORDER BY u.updated_at DESC`,
    )
    .all() as RawUpdate[]

  const items: AttentionItem[] = []
  for (const raw of rows) {
    const v = toView(raw)
    const kind = attentionKind(v)
    if (kind) items.push({ kind, update: v })
  }
  const rank = (k: AttentionKind) => ATTENTION_KINDS.indexOf(k)
  return items.sort((a, b) => rank(a.kind) - rank(b.kind) || b.update.updatedAt.localeCompare(a.update.updatedAt))
}


/** Broken rows leave the inbox on their own after this long. */
const BROKEN_EXPIRY_MS = 14 * 24 * 60 * 60_000


/**
 * A failure stops being news once something newer has replaced it: a later update of the
 * same service that merged, deployed or verified, or a fortnight of nobody caring. Without
 * this a rollback from September sat in the inbox for as long as nobody pressed Ack, long
 * after the version it was about had been overtaken.
 */
function brokenExpired(v: UpdateView): boolean {
  if (Date.now() - Date.parse(v.updatedAt) > BROKEN_EXPIRY_MS) return true
  const newer = getDb()
    .prepare(
      `SELECT 1 FROM updates WHERE stack = ? AND service = ? AND id > ?
          AND state IN ('merged', 'deployed', 'verified') LIMIT 1`,
    )
    .get(v.stack, v.service, v.id)
  return !!newer
}


function attentionKind(v: UpdateView): AttentionKind | null {
  // Merged and nothing more is owed: the service was not running, so nothing was started,
  // and that is the outcome rather than a problem. It is checked before the deploy status
  // because a group's running half can go degraded on the same row, and that half is the
  // one the inbox is about -- not the member that was left exactly as it was.
  if (v.state === 'left-stopped') return null
  const d = v.deploy?.status
  const seen = !!v.ackedAt

  const broken =
    (v.state === 'failed' && !seen) ||
    (v.state === 'merged' && (d === 'failed' || d === 'error') && !seen) ||
    (d === 'degraded' && !seen)
  if (broken) return brokenExpired(v) ? null : 'broken'
  // `ready` waits for the button (v1's attended rung). `pending` is queued and starts on the
  // next tick by itself, so it is not waiting on you.
  if (v.state === 'merged' && d === 'ready') return 'ready-to-deploy'
  if (v.state === 'detected' && v.rolling) return 'rolling-moved'
  if (v.state === 'detected' && v.shipStatus === 'decision' && !v.snoozedUntil) return 'decision'
  return null
}


/**
 * Updates that are tracked but parked: frozen services, and decisions that were snoozed.
 * Informational -- they are the answer to "why is this not in the list", which is
 * otherwise unanswerable from the interface.
 */
export function inboxParked(): UpdateView[] {
  const rows = getDb()
    .prepare(
      `${SELECT_UPDATE}
        WHERE u.state = 'frozen'
           OR (u.state = 'detected' AND u.snoozed_until > ? AND COALESCE(u.detail, '') != 'rolling')
        ORDER BY u.stack, u.service`,
    )
    .all(new Date().toISOString()) as RawUpdate[]
  return rows.map((r) => toView(r))
}


/** Live updates nothing holds but Pause: what would ship the moment Pause is off. */
export function inboxPausedOnly(): UpdateView[] {
  const rows = getDb()
    .prepare(
      `${SELECT_UPDATE}
        WHERE u.state = 'detected' AND COALESCE(u.detail, '') != 'rolling'
        ORDER BY u.stack, u.service`,
    )
    .all() as RawUpdate[]
  return rows.map((r) => toView(r)).filter((v) => v.shipStatus === 'waiting' && v.shipWhy === 'paused')
}


export interface RecentItem {
  at: string
  kind: Outcome
  stack: string
  service: string
  fromTag: string
  toTag: string
  updateId: number
  detail: string | null
}


/** What happened lately, so "did last night go fine" is one glance rather than a hunt. */
export function inboxRecent(hours = 24, limit = 20): RecentItem[] {
  const since = new Date(Date.now() - hours * 3600_000).toISOString()
  const db = getDb()

  const opened = db
    .prepare(
      `SELECT p.created_at AS at, 'opened' AS kind, u.stack, u.service, u.from_tag AS fromTag, u.to_tag AS toTag,
              u.id AS updateId, NULL AS detail
         FROM prs p JOIN pr_updates pu ON pu.pr_id = p.id JOIN updates u ON u.id = pu.update_id
        -- Only a drafted change was "drafted": a ship's own record is created as it ships,
        -- and reading that as a draft put a phantom "drafted" line beside every "shipped".
        WHERE p.created_at >= ? AND p.scope = 'proposed'`,
    )
    .all(since) as RecentItem[]

  const merged = db
    .prepare(
      `SELECT p.merged_at AS at, 'merged' AS kind, u.stack, u.service, u.from_tag AS fromTag, u.to_tag AS toTag,
              u.id AS updateId, NULL AS detail
         FROM prs p JOIN pr_updates pu ON pu.pr_id = p.id JOIN updates u ON u.id = pu.update_id
        WHERE p.merged_at >= ?`,
    )
    .all(since) as RecentItem[]

  // A left-stopped update is named by its own state, not by the row's status, on the newest
  // deploy that carried it: in a group the running half can verify on the same row, and
  // reading the status alone would say the member that was never started "verified". An
  // older row it was linked to keeps saying what that row did. Anything unrecognised still
  // falls to `failed`, which is why the new status has to be named here at all.
  //
  // The row's recorded plan says it too, and outlasts the state: once a later merge
  // overtakes the update it reads superseded, and without the plan arm Recently turned the
  // member that was never started into "verified". A row that rolled back or could not be
  // run keeps its own word. The CASE inside json_each keeps a malformed snapshot from
  // failing the whole list.
  const deployed = db
    .prepare(
      `SELECT d.finished_at AS at,
              CASE WHEN d.status = 'left-stopped' THEN 'left-stopped'
                   WHEN u.state = 'left-stopped'
                        AND d.id = (SELECT MAX(du2.deploy_id) FROM deploy_updates du2 WHERE du2.update_id = u.id)
                     THEN 'left-stopped'
                   WHEN d.status NOT IN ('rolled-back', 'error')
                        AND EXISTS (SELECT 1
                                      FROM json_each(CASE WHEN json_valid(d.snapshot) THEN d.snapshot ELSE '{}' END, '$.left') j
                                     WHERE json_extract(j.value, '$.service') = u.service)
                     THEN 'left-stopped'
                   WHEN d.status = 'verified' THEN 'verified' WHEN d.status = 'degraded' THEN 'degraded'
                   WHEN d.status = 'rolled-back' THEN 'rolled-back' WHEN d.status = 'deployed' THEN 'deployed'
                   ELSE 'failed' END AS kind,
              u.stack, u.service, u.from_tag AS fromTag, u.to_tag AS toTag,
              u.id AS updateId, d.detail
         FROM deploys d JOIN deploy_updates du ON du.deploy_id = d.id
         JOIN updates u ON u.id = du.update_id
        WHERE d.finished_at >= ? AND d.status NOT IN ('pending','ready','running','superseded')`,
    )
    .all(since) as RecentItem[]

  const closed = db
    .prepare(
      `SELECT u.updated_at AS at,
              CASE u.state WHEN 'skipped' THEN 'skipped' ELSE 'superseded' END AS kind,
              u.stack, u.service, u.from_tag AS fromTag, u.to_tag AS toTag,
              u.id AS updateId, u.detail
         FROM updates u
        WHERE u.updated_at >= ? AND u.state IN ('skipped','superseded')`,
    )
    .all(since) as RecentItem[]

  return [...opened, ...merged, ...deployed, ...closed]
    .filter((r) => r.at)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit)
}
