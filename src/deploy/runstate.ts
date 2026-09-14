import { short } from '../gitops/body.ts'
import { parseImageRef } from '../images/ref.ts'
import { missing, type ServiceObservation, type ServiceSnapshot } from './probe.ts'

/**
 * Whether a deploy may start anything, decided before it runs a single command.
 *
 * **An update never changes whether a service is running.** It changes which version a
 * service runs. Starting a service is the operator's act -- `bin/homelab up`, compose by
 * hand -- and every shipshape verb (Deploy, Redeploy, Try again, Roll back, the queue
 * drain) chooses a version, none of them means "start my service". So each target service
 * is read from live docker immediately before acting, and only one that is running is
 * brought up. Anything else is left exactly as it was: no create, no pull, no start, no
 * rm. The merge still stands and the compose file still carries the new version.
 *
 * It was not always so. `docker compose up -d bitwarden` does not care that someone
 * stopped bitwarden: #101 merged 1.37.3 at 09:02 on 2026-09-14 and started a service the
 * operator had deliberately parked, and the digest reported it as a routine deploy.
 *
 * **The docker-state table.** Read from `State.Status`, never `State.Running`:
 *
 *   running, restarting       up -- the restart policy is still trying to run it, and
 *                             the new version may be exactly the fix it needs
 *   paused                    left ("left paused") -- recreating would unpause it
 *   created, exited, dead     left
 *   removing, absent          left, "no container"
 *   docker could not be asked the deploy fails in phase `inspect` and touches nothing
 *
 * `docker stop`, `compose stop` and a crash under `restart: no` all read `exited`, so the
 * reason a service is down cannot be recovered from docker, and leaving it is the only
 * answer that is never wrong. There is no one-shot exception either: a job container that
 * exited 0 under `restart: "no"` is indistinguishable from a long-running service that
 * was parked, so n8n-import is left like anything else and a deploy of n8n's group brings
 * up n8n alone.
 *
 * **Carry: undoing shipshape's own damage.** The rule must not read back a stop that
 * shipshape itself caused as though a person had asked for it. minuspod #79 and #93 both
 * failed mid-"Recreate" after an rm-first removed the old container; without an exception,
 * Try again on that DOWN alert would find nothing running and politely leave it down. So a
 * service the caller says is *carried* -- its newest recorded plan put it up, in an attempt
 * that failed, or in this very row before it was interrupted (see `carriedFor`) -- is
 * brought back up unless it is *visibly* stopped since. Visibly means paused, removing, or
 * exited under `always`/`unless-stopped`: under those policies a crash shows as
 * `restarting`, so `exited` there is a person or the backup tool.
 *
 * **Namespaces.** A follower on `network_mode: service:<owner>` is pinned to the owner's
 * container id. `up --no-deps` on a follower whose owner is stopped destroys the follower
 * and leaves it stuck in `created` (compose probe 4f), so a follower comes up only when
 * its owner does or is already running outside the target. A follower left stopped while
 * its owner is recreated is *stranded*: its pinned id is gone, `docker start` on it would
 * fail, and only compose recovers it (probe 4a3/4a5) -- so its text says so.
 *
 * **Backup stops.** docker-volume-backup stops bitwarden, sftpgo, actual, readeck and
 * shelfmark around its nightly archive and restarts the same container ids afterwards.
 * Recreating a container it holds stopped would make that restart fail and leave the
 * service down, which is one of the reasons stopped services are left rather than staged
 * with `up --no-start`.
 *
 * **The `docker start` trap.** A service left stopped keeps its old container, and that
 * container was created from the old image. Compose brings it up on the new version;
 * `docker start` -- or Portainer's Start -- resumes the old one, and under `restart:
 * always` so does the next daemon restart. Nothing here can close that trap without
 * changing container state, so every left clause names it instead.
 *
 * Everything in this module is pure: the reads happen in `deploy()`, and every decision
 * about them is testable against scripted observations.
 */

/** Why a service was left as it was. */
export type LeftWhy = 'not-running' | 'owner-down' | 'stopped-since'

export interface LeftService {
  service: string
  /** The docker state it was read in; `absent` when docker listed no container. */
  state: string
  why: LeftWhy
  /** The namespace owner, for `owner-down` and `stranded`. */
  owner?: string
  /** Left stopped while its namespace owner is recreated: `docker start` would fail. */
  stranded?: boolean
  restartPolicy: string
  /** The image the stopped container was created from -- what `docker start` resumes. */
  oldRef: string | null
}

export interface RunPlan {
  /** Brought up, in target order. */
  up: string[]
  left: LeftService[]
  /** The carried services among `up`: brought back up after shipshape's own attempt. */
  restored: string[]
}

/**
 * The plan as `deploys.snapshot` stores it, written before the first command runs.
 *
 * Re-runs, carry, the soak and the views all need it after the fact, and by then the
 * container it was read from may be gone.
 */
export interface RecordedPlan extends RunPlan {
  v: 1
  at: string
  /** What each target service was, as read just before acting. */
  seen: ServiceSnapshot[]
}

/** Running or restarting: either way docker is still trying to run it. */
export const countsAsRunning = (state: string): boolean => state === 'running' || state === 'restarting'

/**
 * Stopped in a way only a person, or a tool acting for one, produces.
 *
 * Under `always` and `unless-stopped` docker restarts a crashed container, which reads
 * `restarting`, so an `exited` one there was stopped on purpose. Under `no` and
 * `on-failure` a crash and a stop look the same, so they do not count.
 */
export function visiblyStopped(o: ServiceObservation): boolean {
  return (
    o.state === 'paused' ||
    o.state === 'removing' ||
    (o.state === 'exited' && (o.restartPolicy === 'always' || o.restartPolicy === 'unless-stopped'))
  )
}

/** Every service the plan must read: the target, deduped in order, then owners outside it. */
export function observeSet(services: string[], ownerOf: (s: string) => string | null): string[] {
  const out = [...new Set(services)]
  for (const s of [...out]) {
    const w = ownerOf(s)
    if (w && !out.includes(w)) out.push(w)
  }
  return out
}

/** Which service's network namespace each service joins, from the scanned peers. */
export function ownerFrom(
  peers: { service: string; network_mode: string | null }[],
): (s: string) => string | null {
  const owners = new Map<string, string>()
  for (const p of peers) {
    const m = /^service:(.+)$/.exec(p.network_mode ?? '')
    if (m?.[1]) owners.set(p.service, m[1])
  }
  return (s) => owners.get(s) ?? null
}

/**
 * Decide, per service, whether it comes up or is left as it was.
 *
 * A service with no entry in `seen` is read as having no container: the caller observed
 * everything it could, so a gap means docker listed nothing.
 */
export function planRun(i: {
  services: string[]
  seen: Map<string, ServiceObservation>
  ownerOf: (s: string) => string | null
  carried: ReadonlySet<string>
}): RunPlan {
  const services = [...new Set(i.services)]
  const obsOf = (s: string): ServiceObservation => i.seen.get(s) ?? missing(s)

  type Decision = { up: true; restored: boolean } | { up: false; why: LeftWhy; owner?: string; stranded?: boolean }

  // Each service's own answer first, from nothing but its own container.
  const own = new Map<string, Decision>()
  for (const s of services) {
    const o = obsOf(s)
    if (countsAsRunning(o.state)) own.set(s, { up: true, restored: false })
    else if (i.carried.has(s)) {
      own.set(s, visiblyStopped(o) ? { up: false, why: 'stopped-since' } : { up: true, restored: true })
    } else own.set(s, { up: false, why: 'not-running' })
  }

  // Then the namespace pass, against the owners' own answers. One level is all there is:
  // docker will not let a container join a namespace that is itself borrowed.
  const final = new Map(own)
  for (const s of services) {
    const w = i.ownerOf(s)
    if (!w) continue
    const ownerUp = services.includes(w) ? own.get(w)!.up : countsAsRunning(i.seen.get(w)?.state ?? 'absent')
    const d = own.get(s)!
    if (d.up && !ownerUp) {
      final.set(s, { up: false, why: 'owner-down', owner: w })
    } else if (!d.up && services.includes(w) && ownerUp) {
      // A follower with no container has no pinned id to lose -- compose simply creates
      // it next time -- and a removing one is about to have none.
      const state = obsOf(s).state
      if (state !== 'absent' && state !== 'removing') final.set(s, { ...d, owner: w, stranded: true })
    }
  }

  const plan: RunPlan = { up: [], left: [], restored: [] }
  for (const s of services) {
    const d = final.get(s)!
    if (d.up) {
      plan.up.push(s)
      if (d.restored) plan.restored.push(s)
      continue
    }
    const o = obsOf(s)
    plan.left.push({
      service: s,
      state: o.state,
      why: d.why,
      ...(d.owner ? { owner: d.owner } : {}),
      ...(d.stranded ? { stranded: true } : {}),
      restartPolicy: o.restartPolicy,
      oldRef: o.imageRef,
    })
  }
  return plan
}

/** The version part of an image ref, as a person reads it: the tag, or a short digest pin. */
export function versionOf(ref: string | null): string | null {
  if (ref === null) return null
  const r = parseImageRef(ref)
  if (r.digest) return short(`${r.tag ?? ''}@${r.digest}`)
  return r.tag
}

/**
 * One left service, in the operator's terms: what state it was left in, and what each
 * way of starting it would actually run.
 *
 * `pinnedRef` is what the compose file pins now. The resume clause appears only when the
 * old container's version is known and differs, because "docker start would resume
 * 1.37.3" about a container already on 1.37.3 is noise that reads like a warning.
 */
export function leftClause(l: LeftService, pinnedRef: string | null): string {
  const s = l.service
  const n = versionOf(pinnedRef)
  const o = versionOf(l.oldRef)
  const upOn = n ? `compose brings it up on ${n}` : 'compose brings it up on the version in the compose file'
  const resume = o !== null && n !== null && o !== n
  const word = l.state === 'created' ? 'created, never started' : l.state

  if (l.why === 'owner-down') {
    return `${s} left as it was — it lives in ${l.owner}'s network, and ${l.owner} is not running`
  }
  if (l.why === 'stopped-since') {
    return l.state === 'paused'
      ? `${s} left paused — it was paused after shipshape's last attempt on it`
      : `${s} left stopped (${word}) — it was stopped after shipshape's last attempt on it`
  }
  if (l.stranded) {
    return `${s} left stopped (${word}) — ${l.owner} was recreated, so bring ${s} up with compose; docker start would fail`
  }
  if (l.state === 'paused') {
    return `${s} left paused — ${upOn}${resume ? `; unpausing resumes ${o}` : ''}`
  }
  if (l.state === 'absent' || l.state === 'removing') {
    return `${s} left stopped (no container) — ${upOn}`
  }
  return (
    `${s} left stopped (${word}) — ${upOn}` +
    (resume ? `; docker start would resume ${o}` : '') +
    (l.restartPolicy === 'always' && o ? `; docker restarts it on ${o} when the daemon restarts` : '')
  )
}

/** A carried service that came back up. */
export const restoredClause = (s: string): string =>
  `${s} brought back up — shipshape's last attempt left it down`

/**
 * A recorded plan, or null for anything that is not one.
 *
 * Tolerant because it reads a column that was never written before this format existed
 * and could be written by a later one: an unreadable plan is treated as no plan, which
 * every reader already handles, rather than as an error on a page or in the queue.
 */
export function readRecordedPlan(json: string | null): RecordedPlan | null {
  if (!json) return null
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const p = raw as Partial<RecordedPlan>
  if (p.v !== 1 || !Array.isArray(p.up) || !Array.isArray(p.left)) return null
  return {
    v: 1,
    at: typeof p.at === 'string' ? p.at : '',
    seen: Array.isArray(p.seen) ? p.seen : [],
    up: p.up,
    left: p.left,
    restored: Array.isArray(p.restored) ? p.restored : [],
  }
}

/**
 * What the soak should look at: what came up, when the row recorded it.
 *
 * A row from before plans were recorded looks at every service it names, as it always did.
 */
export function recheckServices(services: string, snapshot: string | null): string[] {
  return readRecordedPlan(snapshot)?.up ?? services.split(' ').filter(Boolean)
}
