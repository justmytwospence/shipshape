import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configured, env, loadPolicy, type Policy } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { scanRepo } from '../compose/scan.ts'
import { bumpFork, readForkPin, retireFork } from '../compose/fork-edit.ts'
import { clearForkConflict, forkConflictFor, forkRefs, recordForkConflict, recordForkPrepared } from '../forks.ts'
import { prepareFork as realPrepareFork, upstreamUrlFor, type PrepareForkInput, type PrepareForkResult } from '../forks/rebase.ts'
import { headDigest } from '../registry/index.ts'
import { sameVersion, versionKey } from '../versions/key.ts'
import { parseImageRef, formatImageRef, displayName } from '../images/ref.ts'
import { rewriteFroms } from '../compose/dockerfile.ts'
import { groupUpdates, makeLookups, type GroupMember, type UpdateGroup } from '../groups.ts'
import { foldGroupMagnitude } from '../policy.ts'
import type { Magnitude } from '../versions/patterns.ts'
import { sourceFor } from '../resolver/index.ts'
import { applyForkEdit, bumpImage } from './editor.ts'
import { changeText, carriedFixesSection, baseImageSection, short, type BasePrInfo, type ForkPrInfo } from './body.ts'
import { authorArgs, ensureWorkRepo, git, httpsUrl, withGitLock } from './repo.ts'
import { syncMain } from './sync.ts'
import { buildableServices, stackPeers, withNamespacePeers, type DeployTarget } from '../deploy/run.ts'
import { enqueueDeploy } from '../deploy/queue.ts'
import { logRetired, retireOvertaken, type Retired } from '../updates/overtaken.ts'
import { holdsForRow, HOLD_COLUMNS, type HoldRow, type UpdateHolds } from '../updates/holds.ts'
import { restorePointsFor, stackHasSnapshot, takeRestorePoint } from '../restore/index.ts'
import { notify } from '../notify/index.ts'

/**
 * Shipping updates.
 *
 * An update ships on its own unless a hold says a person is needed (src/policy.ts). When
 * one ships, shipshape builds a branch in its own work clone, merges it into `main` with a
 * merge commit -- so the log keeps the branch shape and a one-line `git revert -m 1` undoes
 * it -- pushes `main`, and queues the deploy. The branch itself is never pushed and there
 * is no pull request: the review that used to live on one is in the merge commit's message
 * and on the update's page. A drafted config change (src/propose) is the one thing that
 * still travels as a branch, because it is a diff a person should read before shipping.
 */

/**
 * Updates that may be considered for shipping, grouped so companions travel together.
 * Exported for the tests, which check what never reaches it rather than what does.
 *
 * Detected updates, and frozen ones the operator has approved. Never a rolling tag (there
 * is nothing to change in git) and never one a legacy pull request still carries.
 */
export function eligibleGroups(policy: Policy): UpdateGroup[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT u.id, u.stack, u.service, u.image, u.from_tag, u.to_tag, u.magnitude, u.tier,
              u.detail
       FROM updates u
       WHERE (u.state = 'detected' OR (u.state = 'frozen' AND u.approved_at IS NOT NULL))
         AND COALESCE(u.detail, '') != 'rolling'
         AND NOT EXISTS (SELECT 1 FROM pr_updates pu JOIN prs p ON p.id = pu.pr_id
                         WHERE pu.update_id = u.id AND p.state = 'open' AND p.kind = 'github')
       ORDER BY u.id`,
    )
    .all() as (GroupMember & { detail: string | null })[]

  const wanted = rows.filter((r) => r.tier !== 'skip')
  if (wanted.length === 0) return []

  const services = scanRepo(env.repoDir, policy.exclude_stacks)
  // A fork whose last replay onto this very target conflicted, from this very pin, is
  // left alone: the replay would fail identically every poll. A changed pin or a newer
  // target is a new attempt (FORKS.md, "When a rebase conflicts").
  const candidates = wanted.filter((r) => {
    if (!isFork(r.stack, r.service)) return true
    const conflict = forkConflictFor(r.stack, r.service)
    if (!conflict) return true
    const live = services.find((s) => s.stack === r.stack && s.service === r.service)
    const pinned = /#([0-9a-f]{7,40})$/.exec(live?.buildContext ?? '')?.[1] ?? null
    return !(conflict.toTag === r.to_tag.split('@')[0] && pinned === conflict.sha)
  })
  if (candidates.length === 0) return []

  const { sourceRepoFor, groupLabelFor } = makeLookups(services)
  return groupUpdates(candidates, sourceRepoFor, groupLabelFor)
}

/** The local branch a group ships from. Never pushed. */
export function shipBranchFor(g: UpdateGroup): string {
  const base = g.members.length > 1 ? g.members[0]!.stack + '--group' : `${g.members[0]!.stack}--${g.members[0]!.service}`
  const tag = g.members[0]!.to_tag.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return `shipshape/${base}--${tag}`.slice(0, 120)
}

/** The merge commit's body: what moved, what the review said, what waived a hold. */
export function commitBody(
  group: UpdateGroup,
  built: { forks: Map<number, ForkPrInfo>; bases: Map<number, BasePrInfo> },
  statuses: UpdateHolds[],
): string {
  const lines: string[] = []
  for (const m of group.members) {
    lines.push(`- ${m.stack}/${m.service}: ${short(m.from_tag)} -> ${short(m.to_tag)} (${m.magnitude})`)
  }
  const v = getDb()
    .prepare(`SELECT recommendation, confidence, summary FROM verdicts WHERE image = ? AND from_tag = ? AND to_tag = ? AND error IS NULL`)
    .get(group.members[0]!.image, group.members[0]!.from_tag, group.members[0]!.to_tag) as
    | { recommendation: string | null; confidence: string | null; summary: string | null }
    | undefined
  if (v?.recommendation) {
    lines.push('', `Review: ${v.recommendation} (${v.confidence ?? 'unknown'} confidence)`)
    if (v.summary) lines.push(v.summary.replace(/\s+/g, ' ').trim().slice(0, 600))
  }
  const rules = [...new Set(statuses.flatMap((s) => s.waived.map((h) => h.waivedBy!)))]
  if (rules.length > 0) lines.push('', `Shipped under rule ${rules.join(', ')}.`)
  if (statuses.some((s) => s.row.approved_at)) lines.push('', 'Approved by the operator.')
  if (built.forks.size > 0) lines.push('', carriedFixesSection(group, built.forks))
  if (built.bases.size > 0) lines.push('', baseImageSection(group, built.bases))
  return lines.join('\n')
}


/**
 * Write the bump onto `branch` and commit it, returning the new head.
 *
 * Used by the ship pass and by drafting a config change. It always cuts from the freshly-fetched origin tip rather than from whatever the
 * work clone happened to be on -- which for a retarget is also what discards the previous
 * target's commit, and any config draft written on top of it.
 *
 * Nothing is logged here. The two ways this fails mean different things to each caller.
 */
/**
 * What `buildBranch` reaches outside the work clone, replaceable so a test can hand it a
 * replay that already happened and a registry that answers.
 */
export interface BuildDeps {
  prepareFork: (input: PrepareForkInput) => Promise<PrepareForkResult>
  /** The digest of an upstream tag, for a fork whose pin carries one. */
  digestFor: (registry: string, repository: string, tag: string) => Promise<string | null>
  /** The upstream repository (`owner/repo`) an image comes from. */
  sourceRepoFor: (m: GroupMember) => Promise<string | null>
}

const realDeps: BuildDeps = {
  prepareFork: realPrepareFork,
  digestFor: headDigest,
  sourceRepoFor: async (m) => {
    const ref = parseImageRef(m.image)
    try {
      const r = await sourceFor(
        { registry: ref.registry, repository: ref.repository },
        { service: { stack: m.stack, service: m.service }, tag: ref.tag ?? m.from_tag },
      )
      return r.repo
    } catch {
      return null
    }
  },
}

export type BuildResult =
  | { ok: true; sha: string; forks: Map<number, ForkPrInfo>; bases: Map<number, BasePrInfo> }
  | { ok: false; alreadyApplied?: boolean; conflict?: boolean; reason: string }

export async function buildBranch(
  repoDir: string,
  group: UpdateGroup,
  branch: string,
  deps: BuildDeps = realDeps,
): Promise<BuildResult> {
  await git(repoDir, ['checkout', '-B', branch, 'origin/main'])
  const forks = new Map<number, ForkPrInfo>()
  const bases = new Map<number, BasePrInfo>()

  for (const m of group.members) {
    const file = composeFileFor(m.stack, m.service)
    if (!file) return { ok: false, reason: `no compose file recorded for ${m.stack}/${m.service}` }

    if (isFork(m.stack, m.service)) {
      const r = await buildForkMember(repoDir, file, m, deps)
      if (!r.ok) return r
      forks.set(m.id, r.info)
      continue
    }

    const dockerfile = baseDockerfileFor(m.stack, m.service)
    if (dockerfile) {
      const r = await buildBaseMember(repoDir, dockerfile, m, deps)
      if (!r.ok) return r
      bases.set(m.id, r.info)
      continue
    }

    const oldRef = m.image
    const newRef = rewriteRef(oldRef, m.to_tag)
    if (!newRef) return { ok: false, reason: `cannot build a new reference from "${m.to_tag}"` }

    const edit = await bumpImage({
      repoDir,
      composeFile: file,
      service: m.service,
      expectedOldRef: oldRef,
      newRef,
    })
    if (!edit.ok) return { ok: false, alreadyApplied: edit.alreadyApplied, reason: edit.reason }
  }

  await git(repoDir, [...authorArgs(), 'commit', '-am', prTitle(group, forks, bases)])
  return { ok: true, sha: (await git(repoDir, ['rev-parse', 'HEAD'])).stdout, forks, bases }
}

/**
 * Our own build's bump: the final stage's `FROM` moves to the new base (compose/dockerfile.ts),
 * and nothing else in the Dockerfile or the compose file changes. A digest pin is kept: the
 * new tag's digest is looked up, and the edit refused rather than written without it.
 */
async function buildBaseMember(
  repoDir: string,
  dockerfile: string,
  m: GroupMember,
  deps: BuildDeps,
): Promise<{ ok: true; info: BasePrInfo } | Extract<BuildResult, { ok: false }>> {
  const who = `${m.stack}/${m.service}`
  const abs = join(repoDir, dockerfile)
  let text: string
  try {
    text = readFileSync(abs, 'utf8')
  } catch (err) {
    return { ok: false, reason: `cannot read ${dockerfile}: ${(err as Error).message}` }
  }
  const next = await upstreamRefAt(m.image, m.to_tag, deps.digestFor)
  if (!next.ok) return { ok: false, reason: `${who}: ${next.reason}` }
  // `m.image` is the base exactly as the final stage named it when this update was found:
  // the same assertion bumpImage makes on an image line. Past it means done; anything
  // else means a person edited the Dockerfile and should look.
  const edit = rewriteFroms(text, m.image, next.ref)
  if (!edit.ok) return { ok: false, alreadyApplied: edit.alreadyApplied, reason: `${dockerfile}: ${edit.reason}` }
  writeFileSync(abs, edit.text)
  const diff = await git(repoDir, ['diff', '--quiet', '--', dockerfile], { allowFail: true })
  if (diff.exitCode === 0) return { ok: false, reason: `${dockerfile}: the edit produced no diff` }
  return { ok: true, info: { dockerfile, fromRef: m.image, toRef: next.ref, lines: edit.count } }
}

/**
 * A fork's bump is a replay of our fixes onto the new release (src/forks/rebase.ts),
 * then the compose edit that moves its pins onto the result (compose/fork-edit.ts) --
 * or, when nothing is left to carry, the edit that puts the plain upstream image back.
 *
 * A conflict is written down and raised as an incident here, because this is where it is
 * found; the pass leaves the update alone afterwards until the pin or the target changes
 * (see `eligibleGroups`). A successful replay clears whatever conflict was recorded.
 */
async function buildForkMember(
  repoDir: string,
  file: string,
  m: GroupMember,
  deps: BuildDeps,
): Promise<{ ok: true; info: ForkPrInfo } | Extract<BuildResult, { ok: false }>> {
  const who = `${m.stack}/${m.service}`
  let text: string
  try {
    text = readFileSync(join(repoDir, file), 'utf8')
  } catch (err) {
    return { ok: false, reason: `cannot read ${file}: ${(err as Error).message}` }
  }
  const targetTag = m.to_tag.split('@')[0]!
  const fromTag = m.from_tag.split('@')[0]!
  const upstreamRef = await upstreamRefAt(m.image, m.to_tag, deps.digestFor)
  if (!upstreamRef.ok) return { ok: false, reason: `${who}: ${upstreamRef.reason}` }

  const read = readForkPin(text, m.service)
  if (!read.ok) {
    // No fork pin to read: retired already -- by an earlier pass, or by hand -- is done,
    // and anything else is a shape to look at.
    const retired = retireFork(text, m.service, { expectedSha: '', upstreamRef: upstreamRef.ref })
    if (!retired.ok && retired.alreadyApplied) return { ok: false, alreadyApplied: true, reason: `${who}: ${retired.reason}` }
    return { ok: false, reason: `${who}: ${read.reason}` }
  }
  const pin = read.pin
  // The same assertion bumpImage makes on an image line: the file must still be where
  // this update was computed from. Past it means done; anywhere else means a person.
  if (sameTag(pin.baseTag, targetTag)) {
    return { ok: false, alreadyApplied: true, reason: `${file} already builds ${m.service} from ${targetTag} (${pin.sha.slice(0, 7)})` }
  }
  if (!sameTag(pin.baseTag, fromTag)) {
    return { ok: false, reason: `${file} now builds ${m.service} from ${pin.baseTag}, expected ${fromTag}` }
  }

  const refs = forkRefs(m.stack, m.service)
  const waitsOn = refs.map((r) => ({ ref: r.ref, state: r.state, releasedIn: r.releasedIn }))
  const upstreamUrl = upstreamUrlFor(await deps.sourceRepoFor(m), refs.map((r) => r.ref))
  if (!upstreamUrl) {
    return {
      ok: false,
      reason: `${who}: no upstream repository is known to rebase onto -- add a shipshape.source label naming it`,
    }
  }
  const prepared = await deps.prepareFork({
    forkUrl: pin.contextUrl,
    upstreamUrl,
    pinnedSha: pin.sha,
    baseTag: pin.baseTag,
    targetTag,
    waitsOn,
    shortLength: pin.shortSha.length,
  })

  switch (prepared.kind) {
    case 'refused':
      return { ok: false, reason: `${who}: ${prepared.reason}` }
    case 'conflict':
      await recordForkConflict(m.stack, m.service, {
        toTag: targetTag,
        sha: pin.sha,
        commit: prepared.commit.sha,
        subject: prepared.commit.subject,
        files: prepared.files,
        detail: prepared.detail,
      })
      return { ok: false, conflict: true, reason: `${who}: ${prepared.detail}` }
    case 'retire':
    case 'bump':
      break
  }

  const edit =
    prepared.kind === 'retire'
      ? retireFork(text, m.service, { expectedSha: pin.sha, upstreamRef: upstreamRef.ref })
      : bumpFork(text, m.service, {
          expectedSha: pin.sha,
          newSha: prepared.sha,
          newTag: targetTag,
          newUpstream: upstreamRef.ref,
        })
  if (!edit.ok) return { ok: false, alreadyApplied: edit.alreadyApplied, reason: `${who}: ${edit.reason}` }
  const landed = await applyForkEdit({ repoDir, composeFile: file, text: edit.text })
  if (!landed.ok) return { ok: false, reason: `${who}: ${landed.reason}` }

  const info: ForkPrInfo = {
    kind: prepared.kind,
    fromSha: pin.sha,
    sha: prepared.kind === 'bump' ? prepared.sha : null,
    tag: prepared.kind === 'bump' ? prepared.tag : null,
    forkUrl: pin.contextUrl,
    upstreamRef: upstreamRef.ref,
    carried: prepared.kind === 'bump' ? prepared.carried : [],
    dropped: prepared.dropped,
    waitsOn,
  }
  recordForkPrepared(m.stack, m.service, { ...info, waitsOn, forkUrl: pin.contextUrl, toTag: targetTag })
  await clearForkConflict(m.stack, m.service)
  return { ok: true, info }
}

/** The same version in either spelling (`v3.5.1` / `3.5.1`), or the same string. */
function sameTag(a: string, b: string): boolean {
  if (a === b) return true
  const ka = versionKey(a)
  const kb = versionKey(b)
  return !!ka && !!kb && sameVersion(ka, kb)
}

/**
 * The upstream reference at the new version: the tag, keeping a digest pin when the
 * current reference has one. A `to_tag` that carries its own digest is used as is; one that
 * does not, on a digest-pinned upstream, has its digest looked up -- and the edit is refused
 * rather than written without the pin when the registry does not answer.
 */
export async function upstreamRefAt(
  currentRef: string,
  toTag: string,
  digestFor: BuildDeps['digestFor'],
): Promise<{ ok: true; ref: string } | { ok: false; reason: string }> {
  const ref = parseImageRef(currentRef)
  const at = toTag.indexOf('@')
  if (at !== -1 || !ref.digest) {
    const out = rewriteRef(currentRef, toTag)
    return out ? { ok: true, ref: out } : { ok: false, reason: `cannot build a new reference from "${toTag}"` }
  }
  let digest: string | null = null
  try {
    digest = await digestFor(ref.registry, ref.repository, toTag)
  } catch (err) {
    return { ok: false, reason: `could not resolve the digest of ${ref.repository}:${toTag} (${(err as Error).message}); the digest pin would be lost` }
  }
  if (!digest) {
    return { ok: false, reason: `could not resolve the digest of ${ref.repository}:${toTag}; the digest pin would be lost` }
  }
  return { ok: true, ref: formatImageRef(ref, toTag, digest) }
}


/**
 * The update turned out to be done already.
 *
 * Not a failure: nothing went wrong and nothing needs a person. Superseding it stops the
 * ship pass reconsidering it every cycle, which it otherwise would until the
 * next scan noticed the file had moved.
 */
export function retireGroup(group: UpdateGroup, reason: string): boolean {
  const db = getDb()
  const now = new Date().toISOString()
  const stmt = db.prepare(
    `UPDATE updates SET state = 'superseded', detail = 'applied elsewhere', updated_at = ?
     WHERE id = ?`,
  )
  db.transaction(() => {
    for (const m of group.members) stmt.run(now, m.id)
  })()
  logEvent({
    level: 'info',
    kind: 'pr',
    stack: group.members[0]!.stack,
    message: 'update already applied',
    detail: reason,
  })
  return false
}

export function failGroup(group: UpdateGroup, reason: string): boolean {
  logEvent({
    level: 'warn',
    kind: 'pr',
    stack: group.members[0]!.stack,
    message: 'could not build the change',
    detail: reason,
  })
  return false
}


/** The group and its versions, named even when it is one service. See `changeText`. */
export function describe(g: UpdateGroup): string {
  return changeText(g.members, { named: true }) ?? ''
}

export function prTitle(g: UpdateGroup, forks?: Map<number, ForkPrInfo>, bases?: Map<number, BasePrInfo>): string {
  const m = g.members[0]!
  const names = g.members.map((x) => x.service).join(', ')
  // A retire is still a version change, but "bump" would undersell what the diff does.
  if (forks && g.members.every((x) => forks.get(x.id)?.kind === 'retire')) {
    return `chore(deps): ${m.stack}: retire the ${names} fork, back to upstream ${short(m.to_tag)}`
  }
  // The version in the title is the base's, so the title says it is the base that moves:
  // "bump obsidian-sync 22-slim -> 24-slim" would read as a release of obsidian-sync.
  if (bases && g.members.every((x) => bases.has(x.id))) {
    const base = displayName(parseImageRef(m.image))
    return `chore(deps): ${m.stack}: rebuild ${names} on ${base} ${short(m.from_tag)} -> ${short(m.to_tag)}`
  }
  return `chore(deps): ${m.stack}: bump ${names} ${short(m.from_tag)} -> ${short(m.to_tag)}`
}


/** The Dockerfile of our own build watched through its base image, or null (compose/scan.ts). */
export function baseDockerfileFor(stack: string, service: string): string | null {
  const row = getDb()
    .prepare(`SELECT base_dockerfile FROM images WHERE stack = ? AND service = ?`)
    .get(stack, service) as { base_dockerfile: string | null } | undefined
  return row?.base_dockerfile ?? null
}

/** Whether the compose file runs our own build of this service's upstream image. */
export function isFork(stack: string, service: string): boolean {
  const row = getDb()
    .prepare(`SELECT fork_upstream FROM images WHERE stack = ? AND service = ?`)
    .get(stack, service) as { fork_upstream: string | null } | undefined
  return !!row?.fork_upstream
}

export function composeFileFor(stack: string, service: string): string | null {
  const row = getDb()
    .prepare(`SELECT compose_file FROM images WHERE stack = ? AND service = ?`)
    .get(stack, service) as { compose_file: string } | undefined
  return row?.compose_file ?? null
}

export function rewriteRef(currentRef: string, toTag: string): string | null {
  const ref = parseImageRef(currentRef)
  const at = toTag.indexOf('@')
  if (at === -1) return formatImageRef(ref, toTag, null)
  const tag = toTag.slice(0, at) || ref.tag
  return formatImageRef(ref, tag, toTag.slice(at + 1))
}


// ------------------------------------------------------------------ the ship pass

export interface ShipRun {
  shipped: number
  /** Groups waiting on a person. */
  decisions: number
  /** Groups left for later: cooldown, review pending, snoozed, paused. */
  waiting: number
  failed: number
  paused?: string
}

function membersRows(group: UpdateGroup): HoldRow[] {
  const db = getDb()
  const stmt = db.prepare(`SELECT ${HOLD_COLUMNS} FROM updates u WHERE u.id = ?`)
  return group.members.map((m) => stmt.get(m.id) as HoldRow)
}

/** Every member's own status; a group ships only when all are ready. */
function statusesFor(group: UpdateGroup, policy: Policy): UpdateHolds[] {
  return membersRows(group).map((r) => holdsForRow(r, policy))
}

/** What the group as a whole is: ready, waiting, or a decision. */
function groupStatus(statuses: UpdateHolds[]): 'ready' | 'decision' | 'waiting' {
  if (statuses.every((s) => s.status.status === 'ready')) return 'ready'
  if (statuses.some((s) => s.status.status === 'decision')) return 'decision'
  return 'waiting'
}

/** A drafted config change left an open local branch for these updates, if one did. */
function draftFor(group: UpdateGroup): { id: number; branch: string } | null {
  const ids = group.members.map((m) => m.id)
  const row = getDb()
    .prepare(
      `SELECT p.id, p.branch FROM prs p JOIN pr_updates pu ON pu.pr_id = p.id
        WHERE p.kind = 'local' AND p.state = 'open' AND p.scope = 'proposed' AND pu.update_id IN (${ids.map(() => '?').join(',')})
        ORDER BY p.id DESC LIMIT 1`,
    )
    .get(...ids) as { id: number; branch: string } | undefined
  return row ?? null
}

/**
 * One pass: work out which groups are ready, and ship them, up to `ship.max_per_run`.
 *
 * Groups that need a person get `decision_since` stamped so the card can escalate; groups
 * that are only waiting (cooldown, review on its way, snoozed, paused) are left alone.
 * Restore points are taken before the git lock, because a dump can take minutes and
 * nothing else should wait behind it; readiness is checked again inside the lock.
 */
let passRunning = false

export async function runShipPass(): Promise<ShipRun> {
  const out: ShipRun = { shipped: 0, decisions: 0, waiting: 0, failed: 0 }
  // One pass at a time: a verb wakes the loop, and a second pass beside a running one
  // would ship the same group twice.
  if (passRunning) {
    out.paused = 'a ship pass is already running'
    return out
  }
  passRunning = true
  try {
    return await passBody(out)
  } finally {
    passRunning = false
  }
}

async function passBody(out: ShipRun): Promise<ShipRun> {
  const { policy } = loadPolicy()

  const setup = configured()
  if (!setup.ok) {
    out.paused = `not configured: ${setup.missing.map((m) => m.name).join(', ')}`
    return out
  }
  if (!env.githubToken) {
    out.paused = 'GITHUB_TOKEN is not set'
    return out
  }

  const groups = eligibleGroups(policy)
  const now = new Date().toISOString()
  const stamp = getDb().prepare(`UPDATE updates SET decision_since = COALESCE(decision_since, ?) WHERE id = ?`)

  for (const group of groups) {
    if (out.shipped >= policy.ship.max_per_run) break
    const statuses = statusesFor(group, policy)
    const verdict = groupStatus(statuses)
    if (verdict === 'decision') {
      for (const s of statuses) if (s.status.status === 'decision') stamp.run(now, s.row.id)
      out.decisions++
      continue
    }
    if (verdict === 'waiting') {
      out.waiting++
      continue
    }

    try {
      if (await shipGroup(group, policy)) out.shipped++
      else out.waiting++
    } catch (err) {
      out.failed++
      logEvent({
        level: 'error',
        kind: 'pr',
        stack: group.members[0]!.stack,
        message: 'failed to ship an update',
        detail: (err as Error).message.slice(0, 300),
      })
    }
  }
  return out
}

/** Does a restore point need taking before this group ships? */
function wantsRestorePoint(statuses: UpdateHolds[]): boolean {
  if (!statuses[0]) return false
  const stack = statuses[0].row.stack
  if (!stackHasSnapshot(stack)) return false
  return statuses.some((s) => s.cls === 'stateful' || s.waived.some((h) => h.kind === 'irreversible'))
}

async function shipGroup(group: UpdateGroup, policy: Policy): Promise<boolean> {
  const stack = group.members[0]!.stack

  // Before the lock: a dump of a large database must not hold every other git operation.
  const before = statusesFor(group, policy)
  let restoreIds: number | null = null
  if (wantsRestorePoint(before)) {
    const r = await takeRestorePoint(stack, undefined)
    if (!r.ok) {
      const mark = getDb().prepare(`UPDATE updates SET restore_error = ? WHERE id = ?`)
      for (const m of group.members) mark.run(r.reason.slice(0, 300), m.id)
      return false
    }
    restoreIds = r.points.length
    const clear = getDb().prepare(`UPDATE updates SET restore_error = NULL WHERE id = ?`)
    for (const m of group.members) clear.run(m.id)
  }

  const shipped = await withGitLock('ship', async () => {
    const sync = await syncMain()
    if (sync.status === 'paused' || sync.status === 'refused') {
      logEvent({ level: 'warn', kind: 'sync', stack, message: 'not shipping: the checkout could not be synced', detail: sync.reason })
      return null
    }
    // Asked again with the lock held: a verb or a scan may have moved things since.
    const statuses = statusesFor(group, policy)
    if (groupStatus(statuses) !== 'ready') return null
    // Not already shipped, skipped or superseded since the pass looked.
    if (!statuses.every((s) => s.row.state === 'detected' || (s.row.state === 'frozen' && s.row.approved_at))) return null

    const repoDir = await ensureWorkRepo()
    const draft = draftFor(group)
    let branch = draft?.branch ?? shipBranchFor(group)
    let built: { forks: Map<number, ForkPrInfo>; bases: Map<number, BasePrInfo> } = { forks: new Map(), bases: new Map() }
    let title = prTitle(group)

    const hasDraft =
      draft &&
      (await git(repoDir, ['rev-parse', '--verify', `refs/heads/${draft.branch}`], { allowFail: true })).exitCode === 0
    if (!hasDraft) {
      if (draft) {
        // The work clone was recreated: the draft is gone. Close it and let the update be
        // drafted again rather than ship something that was meant to carry more.
        closeLocalChange(draft.id, 'the drafted branch no longer exists in the work clone')
        branch = shipBranchFor(group)
      }
      const b = await buildBranch(repoDir, group, branch)
      if (!b.ok) {
        if (b.alreadyApplied) retireGroup(group, b.reason)
        else failGroup(group, b.reason)
        return null
      }
      built = b
      title = prTitle(group, b.forks, b.bases)
    }

    const merged = await mergeAndPush(repoDir, branch, title, commitBody(group, built, statuses), group, hasDraft ? undefined : async () => (await buildBranch(repoDir, group, branch)).ok)
    if (!merged.ok) {
      failGroup(group, merged.reason)
      return null
    }

    const prId = recordLocalChange({ group, branch, sha: merged.branchSha, draftId: hasDraft ? draft!.id : null, scope: hasDraft ? 'proposed' : 'tag-only' })
    const rules = statuses.flatMap((s) => s.waived.map((h) => h.waivedBy!))
    if (rules.length > 0) {
      const mark = getDb().prepare(`UPDATE updates SET waived_by = ? WHERE id = ?`)
      for (const s of statuses) mark.run([...new Set(s.waived.map((h) => h.waivedBy!))].join(','), s.row.id)
    }
    if (restoreIds !== null) {
      getDb().prepare(`UPDATE restore_points SET pr_id = ? WHERE pr_id IS NULL AND stack = ? AND created_at >= ?`).run(prId, stack, new Date(Date.now() - 3 * 60 * 60_000).toISOString())
    }
    return { prId, mergeSha: merged.mergeSha, title }
  })
  if (!shipped) return false

  await recordShipped(shipped.prId, shipped.mergeSha, group, shipped.title)
  return true
}

/**
 * Merge `branch` into main with a merge commit and push main.
 *
 * The merge commit is what keeps the history branch-shaped; `-m 1` on a revert undoes it.
 * On a lost race with origin the branch is rebuilt (when this pass built it) and merged
 * once more.
 */
async function mergeAndPush(
  repoDir: string,
  branch: string,
  title: string,
  body: string,
  _group: UpdateGroup,
  rebuild?: () => Promise<boolean>,
): Promise<{ ok: true; mergeSha: string; branchSha: string } | { ok: false; reason: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const branchSha = (await git(repoDir, ['rev-parse', branch])).stdout
    await git(repoDir, ['checkout', '-B', 'main', 'origin/main'])
    const merge = await git(repoDir, [...authorArgs(), 'merge', '--no-ff', '-m', title, '-m', body, branch], { allowFail: true })
    if (merge.exitCode !== 0) {
      await git(repoDir, ['merge', '--abort'], { allowFail: true })
      await git(repoDir, ['checkout', '-f', 'main'], { allowFail: true })
      return { ok: false, reason: `merging ${branch} failed: ${(merge.stderr || merge.stdout).slice(0, 200)}` }
    }
    const mergeSha = (await git(repoDir, ['rev-parse', 'HEAD'])).stdout
    const push = await git(repoDir, ['push', httpsUrl(), 'main:main'], { remote: true, allowFail: true })
    if (push.exitCode === 0) {
      await git(repoDir, ['branch', '-D', branch], { allowFail: true })
      return { ok: true, mergeSha, branchSha }
    }
    if (!/non-fast-forward|fetch first|rejected/i.test(push.stderr)) {
      return { ok: false, reason: `push failed: ${push.stderr.slice(0, 200)}` }
    }
    // Origin moved under us: refresh and go round once more.
    await git(repoDir, ['fetch', '--prune', httpsUrl(), '+refs/heads/*:refs/remotes/origin/*'], { remote: true })
    if (rebuild && !(await rebuild())) return { ok: false, reason: 'the branch could not be rebuilt on the new main' }
  }
  return { ok: false, reason: 'push kept losing a race with origin' }
}

/** Close a local change record that will never merge, deleting its branch in the work clone. */
export function closeLocalChange(prId: number, why: string): void {
  const db = getDb()
  const now = new Date().toISOString()
  db.transaction(() => {
    db.prepare(`UPDATE prs SET state = 'closed' WHERE id = ?`).run(prId)
    db.prepare(`DELETE FROM proposals WHERE pr_id = ?`).run(prId)
  })()
  logEvent({ level: 'info', kind: 'pr', message: 'a drafted change was closed', detail: `${why} (${now.slice(0, 10)})` })
}

/** The change record for a branch shipshape merged itself: a `prs` row with `kind = 'local'`. */
function recordLocalChange(o: {
  group: UpdateGroup
  branch: string
  sha: string
  draftId: number | null
  scope: 'tag-only' | 'proposed'
}): number {
  const db = getDb()
  const now = new Date().toISOString()
  return db.transaction(() => {
    if (o.draftId !== null) {
      db.prepare(`UPDATE prs SET head_sha_pushed = ?, group_key = ? WHERE id = ?`).run(o.sha, o.group.key, o.draftId)
      const link = db.prepare(`INSERT OR IGNORE INTO pr_updates (pr_id, update_id) VALUES (?, ?)`)
      for (const m of o.group.members) link.run(o.draftId, m.id)
      return o.draftId
    }
    const info = db
      .prepare(
        `INSERT INTO prs (number, branch, head_sha_pushed, state, group_key, scope, kind, created_at)
         VALUES (0, ?, ?, 'open', ?, ?, 'local', ?)`,
      )
      .run(o.branch, o.sha, o.group.key, o.scope, now)
    const id = Number(info.lastInsertRowid)
    const link = db.prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`)
    for (const m of o.group.members) link.run(id, m.id)
    return id
  })()
}

/**
 * The change landed on main: mark it merged, retire what it overtook, and queue the
 * deploy. All in one transaction, so a crash cannot leave a merged change with nothing
 * queued -- which is how merges used to be lost, silently and permanently.
 */
export async function recordShipped(prId: number, mergeSha: string, group: UpdateGroup, title: string): Promise<void> {
  const { policy } = loadPolicy()
  const db = getDb()
  const now = new Date().toISOString()
  const members = group.members
  const stack = members[0]?.stack ?? 'unknown'
  const target: DeployTarget = {
    stack,
    // Plus anything that shares a namespace with them: recreating the owner strands its
    // followers on a dead one, and they go on looking perfectly healthy while it happens.
    services: withNamespacePeers(stack, [...new Set(members.map((m) => m.service))], stackPeers),
    strategy: members.some((m) => deployLabelFor(m.stack, m.service) === 'rm-first') ? 'rm-first' : 'up',
  }
  target.build = buildableServices(stack, target.services, policy)

  let retired: Retired[] = []
  db.transaction(() => {
    db.prepare(`UPDATE prs SET state = 'merged', merged_at = ?, merge_commit_sha = ? WHERE id = ?`).run(now, mergeSha, prId)
    const mark = db.prepare(`UPDATE updates SET state = 'merged', updated_at = ? WHERE id = ?`)
    for (const m of members) mark.run(now, m.id)
    retired = retireOvertaken(now)
    enqueueDeploy({ prId, prNumber: 0, target, now, status: 'pending' })
  })()
  logRetired(retired)

  // Land it in the live checkout so the deploy runs against merged content.
  const sync = await withGitLock('post-merge-sync', () => syncMain())
  const names = members.map((m) => m.service).join(', ')
  if (sync.status === 'paused' || sync.status === 'refused') {
    logEvent({
      level: 'warn',
      kind: 'pr',
      stack,
      message: `${title} shipped, but the checkout could not be updated`,
      detail: sync.reason,
    })
    await notify({
      key: 'shipshape:sync',
      title: `shipshape: ${stack} shipped, sync blocked`,
      body: `${title}\n\n${sync.reason}\n\nThe deploy stays queued and runs once the checkout is clean.`,
      priority: 4,
      tags: ['warning'],
      eventClass: 'system',
    })
    return
  }
  logEvent({
    level: 'info',
    kind: 'pr',
    stack,
    message: `shipped ${stack}: ${changeText(members, { named: true })}`,
    detail: `deploying ${names}${restorePointsFor(prId).length > 0 ? ', restore point taken' : ''}`,
  })
}

/** The service's `shipshape.deploy` label, as recorded by the last scan. */
function deployLabelFor(stack: string, service: string): string | null {
  const row = getDb()
    .prepare(`SELECT deploy_label FROM images WHERE stack = ? AND service = ?`)
    .get(stack, service) as { deploy_label: string | null } | undefined
  return row?.deploy_label ?? null
}
