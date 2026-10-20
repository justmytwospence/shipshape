import type { ScannedService } from './compose/scan.ts'
import { getDb, logEvent } from './db.ts'
import { notify, resolveIncident } from './notify/index.ts'
import {
  forkRefUrl,
  parseForkRef,
  releaseUrl,
  resolveForkRef,
  type ForkRefResolution,
  type ForkRefState,
} from './upstream/forks.ts'
import { releaseIndex } from './upstream/releases.ts'
import { compareKeys, sameVersion, versionKey, type VersionKey } from './versions/key.ts'
import { LIVE_STATES, sqlIn } from './updates/state.ts'

/**
 * What shipshape does about a fork, beyond listing its upstream's releases (FORKS.md).
 *
 * Once per scan per fork, after detection: each reference the fork waits on is resolved
 * upstream (`upstream/forks.ts`), the answer is kept in `fork_refs` so the Services page
 * never asks GitHub, and one incident is raised when the fork can go -- every fix has
 * shipped in a release newer than the fork's base -- or when it has nowhere to go, because
 * a reference was closed without a fix. Waiting is the healthy state and says nothing.
 *
 * The incident is keyed per service and sent once per conclusion: the evidence that
 * raised it is written to `images.fork_notified`, the same evidence on the next scan sends
 * nothing, and different evidence (a second reference shipped) edits the one message. It
 * is resolved, silently, when the condition stops holding or the fork labels go away.
 */

export const FORK_INCIDENT_PREFIX = 'shipshape-fork-retire:'

export const forkIncidentKey = (stack: string, service: string) => `${FORK_INCIDENT_PREFIX}${stack}/${service}`

/**
 * The one failure a rebase adds (src/forks/rebase.ts): a carried commit that no longer
 * applies to the new release. One incident per service, raised when the pull request pass
 * finds the conflict and resolved when a later replay succeeds or the update moves on.
 */
export const FORK_CONFLICT_PREFIX = 'shipshape-fork-conflict:'

export const forkConflictKey = (stack: string, service: string) => `${FORK_CONFLICT_PREFIX}${stack}/${service}`

export interface ForkConflict {
  /** The upstream version the replay was onto, as the update's `to_tag` spells it. */
  toTag: string
  /** The pinned sha the replay started from. */
  sha: string
  /** The commit that would not apply. */
  commit: string
  subject: string
  files: string[]
  /** The sentence the update and the service show. */
  detail: string
  at: string
}

/** The recorded conflict for a service, if a replay left one. */
export function forkConflictFor(stack: string, service: string): ForkConflict | null {
  const row = getDb()
    .prepare(`SELECT fork_conflict FROM images WHERE stack = ? AND service = ?`)
    .get(stack, service) as { fork_conflict: string | null } | undefined
  if (!row?.fork_conflict) return null
  try {
    return JSON.parse(row.fork_conflict) as ForkConflict
  } catch {
    return null
  }
}

/**
 * Write the conflict down and raise its incident. The same conflict found again -- the
 * same commit against the same target -- edits nothing and sends nothing; a different one
 * (a newer target, a different commit) edits the message in place.
 */
export async function recordForkConflict(
  stack: string,
  service: string,
  c: Omit<ForkConflict, 'at'>,
): Promise<void> {
  const db = getDb()
  const prev = forkConflictFor(stack, service)
  const same = prev && prev.toTag === c.toTag && prev.sha === c.sha && prev.commit === c.commit
  if (same) return
  const at = new Date().toISOString()
  db.prepare(`UPDATE images SET fork_conflict = ? WHERE stack = ? AND service = ?`).run(
    JSON.stringify({ ...c, at } satisfies ForkConflict),
    stack,
    service,
  )
  logEvent({
    level: 'warn',
    kind: 'pr',
    stack,
    service,
    message: `fork cannot be rebased onto ${c.toTag}`,
    detail: c.detail,
  })
  await notify({
    key: forkConflictKey(stack, service),
    title: `${service} fork conflicts with ${c.toTag}`,
    body: [
      `Replaying the ${service} fork's fixes onto upstream ${c.toTag} stopped at a conflict:`,
      '',
      `- ${c.detail}`,
      '',
      `Nothing was pushed and no pull request opened. Rebase the fork's homelab branch onto ${c.toTag} by hand and move the pinned sha in the compose file, or drop the commit -- FORKS.md, "When a rebase conflicts". shipshape tries again once the pin or the target changes.`,
    ].join('\n'),
    priority: 3,
    tags: ['fork'],
  })
}

/** Forget a conflict and resolve its incident, silently. No-op when there is none. */
export async function clearForkConflict(stack: string, service: string): Promise<void> {
  const db = getDb()
  const row = db
    .prepare(`SELECT fork_conflict FROM images WHERE stack = ? AND service = ?`)
    .get(stack, service) as { fork_conflict: string | null } | undefined
  if (!row?.fork_conflict) return
  db.prepare(`UPDATE images SET fork_conflict = NULL WHERE stack = ? AND service = ?`).run(stack, service)
  logEvent({ level: 'info', kind: 'pr', stack, service, message: 'fork conflict cleared' })
  await resolveIncident(forkConflictKey(stack, service))
}

/** What the last replay for a service produced, for the update page. */
export interface ForkPrepared {
  kind: 'bump' | 'retire'
  toTag: string
  /** The pin the replay started from. */
  fromSha: string
  /** The replayed head and its tag, for a bump. */
  sha: string | null
  tag: string | null
  /** The fork repository, as `build.context` names it. */
  forkUrl: string
  /** The `shipshape.fork.upstream` value (bump) or `image:` (retire) the file moves to. */
  upstreamRef: string
  carried: { sha: string; short: string; subject: string; author: string }[]
  dropped: { sha: string; short: string; subject: string; author: string; reason: string }[]
  waitsOn: { ref: string; state: ForkRefState; releasedIn: string | null }[]
  at: string
}

export function forkPreparedFor(stack: string, service: string): ForkPrepared | null {
  const row = getDb()
    .prepare(`SELECT fork_prepared FROM images WHERE stack = ? AND service = ?`)
    .get(stack, service) as { fork_prepared: string | null } | undefined
  if (!row?.fork_prepared) return null
  try {
    return JSON.parse(row.fork_prepared) as ForkPrepared
  } catch {
    return null
  }
}

export function recordForkPrepared(stack: string, service: string, p: Omit<ForkPrepared, 'at'>): void {
  getDb()
    .prepare(`UPDATE images SET fork_prepared = ? WHERE stack = ? AND service = ?`)
    .run(JSON.stringify({ ...p, at: new Date().toISOString() } satisfies ForkPrepared), stack, service)
}

export interface ForkRefRow {
  ref: string
  state: ForkRefState
  fixSha: string | null
  releasedIn: string | null
  comparedTo: string | null
  detail: string | null
  checkedAt: string
}

/** The stored answers for one service, in the order the label lists them. */
export function forkRefs(stack: string, service: string): ForkRefRow[] {
  return (
    getDb()
      .prepare(
        `SELECT ref, state, fix_sha, released_in, compared_to, detail, checked_at
           FROM fork_refs WHERE stack = ? AND service = ? ORDER BY rowid`,
      )
      .all(stack, service) as {
      ref: string
      state: ForkRefState
      fix_sha: string | null
      released_in: string | null
      compared_to: string | null
      detail: string | null
      checked_at: string
    }[]
  ).map((r) => ({
    ref: r.ref,
    state: r.state,
    fixSha: r.fix_sha,
    releasedIn: r.released_in,
    comparedTo: r.compared_to,
    detail: r.detail,
    checkedAt: r.checked_at,
  }))
}

/**
 * The newest upstream release the fix could be in.
 *
 * The newest target shipshape has recorded for this service, or the base tag when there is
 * none -- and the newest stable GitHub release of the repository the reference lives in,
 * because a digest-pinned fork (the common shape: `pattern: digest`) never records newer
 * tags at all, and would otherwise only ever be compared against its own base. The release
 * spelling is preferred for the version that wins, since that is the name `compare` needs.
 */
export async function newestUpstreamTag(
  svc: Pick<ScannedService, 'stack' | 'service' | 'ref'>,
  repo: string | null,
): Promise<string | null> {
  const base = svc.ref?.tag ?? null
  const candidates: { tag: string; key: VersionKey | null }[] = []
  if (base) candidates.push({ tag: base, key: versionKey(base) })

  const rows = getDb()
    .prepare(`SELECT to_tag FROM updates WHERE stack = ? AND service = ? AND state IN ${sqlIn(LIVE_STATES)}`)
    .all(svc.stack, svc.service) as { to_tag: string }[]
  for (const r of rows) {
    const tag = r.to_tag.split('@')[0]!
    if (tag) candidates.push({ tag, key: versionKey(tag) })
  }

  let releases: { tag: string; key: VersionKey | null }[] = []
  if (repo) {
    const index = await releaseIndex(repo, { maxPages: 1 })
    if (index.ok) releases = index.releases.filter((r) => !r.prerelease).map((r) => ({ tag: r.tag, key: r.key }))
    candidates.push(...releases)
  }

  let best: { tag: string; key: VersionKey | null } | null = null
  for (const c of candidates) {
    if (!c.key || c.key.partial) continue
    if (!best?.key) best = c
    else if ((compareKeys(c.key, best.key) ?? -1) > 0) best = c
  }
  if (!best) return base
  const release = best.key ? releases.find((r) => r.key && sameVersion(r.key, best!.key!)) : undefined
  return release?.tag ?? best.tag
}

/**
 * Resolve every reference a fork waits on, record the answers, and decide the incident.
 * Called from the scan for each fork after its detection; a throw is the caller's to
 * isolate, and only this service's status is at stake.
 */
export async function checkFork(svc: ScannedService): Promise<void> {
  if (!svc.fork) return
  const db = getDb()
  const now = new Date().toISOString()
  const previous = new Map(forkRefs(svc.stack, svc.service).map((r) => [r.ref, r]))

  // One newest-tag lookup per repository, not per reference.
  const newestByRepo = new Map<string, string | null>()
  const newestFor = async (repo: string | null): Promise<string | null> => {
    const k = repo ?? ''
    if (!newestByRepo.has(k)) newestByRepo.set(k, await newestUpstreamTag(svc, repo))
    return newestByRepo.get(k)!
  }

  const resolved: ForkRefRow[] = []
  for (const ref of svc.fork.waitsOn) {
    const repo = parseForkRef(ref)?.repo ?? null
    const r = await resolveForkRef(ref, await newestFor(repo))
    resolved.push(keep(r, previous.get(ref) ?? null, now))
  }

  const upsert = db.prepare(
    `INSERT INTO fork_refs (stack, service, ref, state, fix_sha, released_in, compared_to, detail, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(stack, service, ref) DO UPDATE SET
       state = excluded.state, fix_sha = excluded.fix_sha, released_in = excluded.released_in,
       compared_to = excluded.compared_to, detail = excluded.detail, checked_at = excluded.checked_at`,
  )
  db.transaction(() => {
    for (const r of resolved) {
      upsert.run(svc.stack, svc.service, r.ref, r.state, r.fixSha, r.releasedIn, r.comparedTo, r.detail, r.checkedAt)
    }
    // A reference removed from the label is forgotten with it.
    const keepRefs = new Set(resolved.map((r) => r.ref))
    for (const old of previous.keys()) {
      if (!keepRefs.has(old)) {
        db.prepare(`DELETE FROM fork_refs WHERE stack = ? AND service = ? AND ref = ?`).run(svc.stack, svc.service, old)
      }
    }
  })()

  for (const r of resolved) {
    const was = previous.get(r.ref)?.state
    if (was !== r.state) {
      logEvent({
        level: 'info',
        kind: 'scan',
        stack: svc.stack,
        service: svc.service,
        message: `fork waits on ${r.ref}: ${describeState(r)}`,
        detail: r.detail ?? undefined,
      })
    }
  }

  await settleIncident(svc, resolved)
}

/**
 * A lookup that failed does not unlearn what an earlier one found: the previous row stands
 * with the failure in its detail. Only a reference never resolved reads `unknown`.
 */
function keep(r: ForkRefResolution, prev: ForkRefRow | null, now: string): ForkRefRow {
  if (r.state === 'unknown' && prev && prev.state !== 'unknown') {
    return { ...prev, detail: `could not check (${r.detail ?? 'lookup failed'}); last known ${prev.checkedAt.slice(0, 10)}`, checkedAt: now }
  }
  return { ...r, checkedAt: now }
}

export function describeState(r: Pick<ForkRefRow, 'state' | 'releasedIn'>): string {
  switch (r.state) {
    case 'open':
      return 'open'
    case 'merged-unreleased':
      return 'merged, not released'
    case 'released':
      return `released in ${r.releasedIn}`
    case 'closed-unfixed':
      return 'closed without a fix'
    case 'unknown':
      return 'could not be looked up'
  }
}

export type ForkVerdict =
  | { kind: 'waiting' }
  | { kind: 'retire'; refs: ForkRefRow[] }
  | { kind: 'unfixed'; refs: ForkRefRow[] }

/**
 * Whether the fork can go. Pure, so the two sentences the incident can say are decided
 * once and tested without a database: every reference shipped in a release newer than the
 * base, or any reference closed with no fix on the way. Anything else is waiting.
 */
export function forkVerdict(baseTag: string | null, refs: ForkRefRow[]): ForkVerdict {
  const unfixed = refs.filter((r) => r.state === 'closed-unfixed')
  if (unfixed.length > 0) return { kind: 'unfixed', refs: unfixed }
  if (refs.length === 0) return { kind: 'waiting' }
  const base = versionKey(baseTag)
  const newer = (tag: string | null) => {
    const k = versionKey(tag)
    if (!k) return false
    if (!base) return true
    return (compareKeys(k, base) ?? 0) > 0
  }
  if (refs.every((r) => r.state === 'released' && newer(r.releasedIn))) return { kind: 'retire', refs }
  return { kind: 'waiting' }
}

/** The evidence as one string: the same conclusion twice sends nothing. */
function fingerprint(v: ForkVerdict): string | null {
  if (v.kind === 'waiting') return null
  return `${v.kind}:${v.refs.map((r) => `${r.ref}=${r.state}${r.releasedIn ? `@${r.releasedIn}` : ''}`).sort().join(',')}`
}

async function settleIncident(svc: ScannedService, refs: ForkRefRow[]): Promise<void> {
  const db = getDb()
  const key = forkIncidentKey(svc.stack, svc.service)
  const row = db
    .prepare(`SELECT fork_notified FROM images WHERE stack = ? AND service = ?`)
    .get(svc.stack, svc.service) as { fork_notified: string | null } | undefined
  const verdict = forkVerdict(svc.ref?.tag ?? null, refs)
  const print = fingerprint(verdict)
  const setNotified = (v: string | null) =>
    db.prepare(`UPDATE images SET fork_notified = ? WHERE stack = ? AND service = ?`).run(v, svc.stack, svc.service)

  if (verdict.kind === 'waiting') {
    if (row?.fork_notified) {
      setNotified(null)
      await resolveIncident(key)
    }
    return
  }
  if (row?.fork_notified === print) return

  const base = svc.ref?.tag ?? 'its base'
  const lines =
    verdict.kind === 'retire'
      ? [
          `Every fix the ${svc.service} fork carries has shipped upstream, past ${base}:`,
          ...verdict.refs.map((r) => `- ${r.ref}: released in ${r.releasedIn}`),
          '',
          `Put the upstream image back at ${newestOf(verdict.refs)?.tag ?? 'that release'} and drop the fork labels -- FORKS.md, "Retiring a fork".`,
        ]
      : [
          `The ${svc.service} fork has no upstream path for ${verdict.refs.length === 1 ? 'a fix it carries' : 'fixes it carries'}:`,
          ...verdict.refs.map((r) => `- ${r.ref}: closed without a fix${r.detail ? ` (${r.detail})` : ''}`),
          '',
          'Nothing upstream will release this. Decide whether to keep carrying it, resubmit, or drop it -- FORKS.md.',
        ]
  // Where to go: the release that carries the last fix, or the reference that has none.
  const newest = verdict.kind === 'retire' ? newestOf(verdict.refs) : null
  const click =
    (newest ? releaseUrl(newest.ref, newest.tag) : null) ?? forkRefUrl(verdict.refs[0]!.ref) ?? undefined
  setNotified(print)
  logEvent({
    level: 'info',
    kind: 'scan',
    stack: svc.stack,
    service: svc.service,
    message: verdict.kind === 'retire' ? 'fork can retire' : 'fork has no upstream fix',
    detail: verdict.refs.map((r) => `${r.ref}: ${describeState(r)}`).join(', '),
  })
  await notify({
    key,
    title: verdict.kind === 'retire' ? `${svc.service} fork can retire` : `${svc.service} fork has no upstream fix`,
    body: lines.join('\n'),
    priority: 3,
    tags: ['fork'],
    click,
  })
}

/** The highest release among the ones named, and which reference it answers. */
function newestOf(refs: ForkRefRow[]): { ref: string; tag: string } | null {
  let best: { ref: string; tag: string; key: VersionKey } | null = null
  for (const r of refs) {
    const k = versionKey(r.releasedIn)
    if (!r.releasedIn || !k) continue
    if (!best || (compareKeys(k, best.key) ?? 0) > 0) best = { ref: r.ref, tag: r.releasedIn, key: k }
  }
  return best ? { ref: best.ref, tag: best.tag } : null
}

/**
 * Close what no longer applies: a service whose fork labels are gone, or which is gone
 * itself, has its incident resolved and its reference rows dropped. Run once per scan,
 * after the inventory has been synced, so it sees the files as they are now.
 */
export async function reconcileForks(services: Pick<ScannedService, 'stack' | 'service' | 'fork'>[]): Promise<void> {
  const db = getDb()
  const current = new Set(services.filter((s) => s.fork).map((s) => `${s.stack}/${s.service}`))

  const stale = (
    db.prepare(`SELECT DISTINCT stack, service FROM fork_refs`).all() as { stack: string; service: string }[]
  ).filter((r) => !current.has(`${r.stack}/${r.service}`))
  for (const r of stale) {
    db.prepare(`DELETE FROM fork_refs WHERE stack = ? AND service = ?`).run(r.stack, r.service)
  }
  // The incident table is the memory of what was sent, so a service removed from the
  // compose files -- whose images row went with it -- is still resolved.
  const open = db
    .prepare(`SELECT key FROM incidents WHERE key LIKE ? AND open = 1`)
    .all(`${FORK_INCIDENT_PREFIX}%`) as { key: string }[]
  for (const { key } of open) {
    const name = key.slice(FORK_INCIDENT_PREFIX.length)
    if (current.has(name)) continue
    const [stack, service] = name.split('/') as [string, string]
    db.prepare(`UPDATE images SET fork_notified = NULL WHERE stack = ? AND service = ?`).run(stack, service)
    logEvent({ level: 'info', kind: 'scan', stack, service, message: 'fork retired', detail: 'the fork labels are gone' })
    await resolveIncident(key)
  }
  db.prepare(`UPDATE images SET fork_notified = NULL WHERE fork_upstream IS NULL AND fork_notified IS NOT NULL`).run()

  // A conflict whose update has moved on -- superseded, skipped, caught up, or the service
  // retired -- has nothing left to retry, so its incident closes with it.
  const conflicted = db
    .prepare(`SELECT stack, service, fork_conflict FROM images WHERE fork_conflict IS NOT NULL`)
    .all() as { stack: string; service: string; fork_conflict: string }[]
  for (const r of conflicted) {
    let c: ForkConflict | null = null
    try {
      c = JSON.parse(r.fork_conflict) as ForkConflict
    } catch {
      c = null
    }
    const live = c
      ? (db
          .prepare(
            `SELECT 1 FROM updates WHERE stack = ? AND service = ? AND state IN ${sqlIn(LIVE_STATES)}
               AND (to_tag = ? OR to_tag LIKE ?) LIMIT 1`,
          )
          .get(r.stack, r.service, c.toTag, `${c.toTag}@%`) as unknown)
      : null
    if (!current.has(`${r.stack}/${r.service}`) || !live) await clearForkConflict(r.stack, r.service)
  }
  db.prepare(`UPDATE images SET fork_prepared = NULL WHERE fork_upstream IS NULL AND fork_prepared IS NOT NULL`).run()
}
