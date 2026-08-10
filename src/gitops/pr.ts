import { Octokit } from 'octokit'
import { configured, env, loadPolicy, type Policy } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { scanRepo } from '../compose/scan.ts'
import { parseImageRef, formatImageRef } from '../images/ref.ts'
import { branchFor, groupUpdates, makeLookups, type GroupMember, type UpdateGroup } from '../groups.ts'
import { routine } from '../notify/digest.ts'
import { foldGroupMagnitude, shouldOpenPr, type EffectiveTier } from '../policy.ts'
import type { Magnitude } from '../versions/patterns.ts'
import { bumpImage } from './editor.ts'
import { prBody, short } from './body.ts'
import { resolveSource } from '../resolver/index.ts'
import { authorArgs, ensureWorkRepo, git, httpsUrl, withGitLock } from './repo.ts'
import { syncMain } from './sync.ts'

/**
 * Turning detected updates into pull requests.
 *
 * The PR is the review surface: it carries the diff, the changelog analysis, and the
 * merge decision. Merging one is what makes the change real.
 */

let octokit: Octokit | null = null
function gh(): Octokit {
  octokit ??= new Octokit({ auth: env.githubToken })
  return octokit
}

function repoParts(): { owner: string; repo: string } {
  const [owner, repo] = env.githubRepo.split('/') as [string, string]
  return { owner, repo }
}

const LABELS: Record<string, string> = {
  'image-update': '0e8a16',
  major: 'b60205',
  minor: 'fbca04',
  patch: 'c2e0c6',
  digest: 'c5def5',
  'needs-analysis': 'd4c5f9',
  'claude-hold': 'fbca04',
  'claude-block': 'b60205',
}

let labelsEnsured = false

async function ensureLabels(): Promise<void> {
  if (labelsEnsured) return
  labelsEnsured = true
  const { owner, repo } = repoParts()
  for (const [name, color] of Object.entries(LABELS)) {
    try {
      await gh().rest.issues.createLabel({ owner, repo, name, color })
    } catch {
      // Already exists, which is the expected case after the first run.
    }
  }
}

export interface PrRunResult {
  opened: number
  skipped: number
  failed: number
  paused?: string
  /** Superseded pull requests retired this pass. */
  closed: number
}

/**
 * One pass: sync, group what is eligible, and open a PR per group up to the configured
 * ceiling.
 */
export async function runPrPass(): Promise<PrRunResult> {
  return withGitLock('pr-pass', async () => {
    const { policy } = loadPolicy()
    const out: PrRunResult = { opened: 0, skipped: 0, failed: 0 , closed: 0}

    const setup = configured()
    if (!setup.ok) {
      out.paused = `not configured: ${setup.missing.map((m) => m.name).join(', ')}`
      return out
    }
    if (!env.githubToken) {
      out.paused = 'GITHUB_TOKEN is not set'
      return out
    }

    const sync = await syncMain()
    if (sync.status === 'paused' || sync.status === 'refused') {
      out.paused = sync.reason
      return out
    }

    // Before anything is opened: retire the pull requests whose target was overtaken.
    // Ordering matters twice. Any slot it frees is usable in this same pass, and the
    // successor's eligibility check excludes updates attached to an *open* pull request
    // -- so a corpse left open here would keep its replacement from ever being written.
    out.closed = await closeSupersededPrs(policy)

    const groups = eligibleGroups(policy)
    if (groups.length === 0) return out

    const openNow = countOpenPrs()
    // `null` is no ceiling: every eligible group opens this pass. Written as a branch
    // rather than folding null to Infinity so the arithmetic below never sees a
    // non-finite number and `groups.slice(0, room)` stays an honest integer slice.
    const room = policy.prs.max_open === null ? groups.length : Math.max(0, policy.prs.max_open - openNow)
    if (room === 0) {
      // Once per change of fact, not once per poll. The PR loop runs every 60s while
      // anything is open, and this branch is the steady state of a full queue -- logging
      // it unconditionally wrote 2,237 identical rows in two days and buried every event
      // that mattered underneath them. The scan path has always had this discipline
      // ("events fire on the first observation of a fact"); this is the same rule.
      noteOnce(
        `queue-full:${groups.length}:${openNow}`,
        `holding ${groups.length} update(s): ${openNow} pull requests already open`,
        'raise prs.max_open to open more at once',
      )
      out.skipped = groups.length
      return out
    }
    clearNote('queue-full')

    await ensureLabels()
    const repoDir = await ensureWorkRepo()

    for (const group of groups.slice(0, room)) {
      try {
        const created = await openPr(repoDir, group, policy)
        if (created) out.opened++
        else out.skipped++
      } catch (err) {
        out.failed++
        logEvent({
          level: 'error',
          kind: 'pr',
          stack: group.members[0]!.stack,
          message: 'failed to open a pull request',
          detail: (err as Error).message,
        })
      }
    }
    out.skipped += Math.max(0, groups.length - room)

    return out
  })
}

/**
 * Retiring pull requests whose target has been overtaken.
 *
 * When a scan finds a newer tag for a service that already has a pull request open, it
 * supersedes the update row and a *new* branch is cut -- the branch name carries the
 * target tag, so the successor can never be the same ref. That leaves two pull requests
 * rewriting the same `image:` line from the same base, of which exactly one can merge;
 * the other is guaranteed to conflict. Left alone they accumulate, and a rolling digest
 * leaks one per move.
 *
 * The successor replaces the loser rather than continuing it, so the right primitive is
 * to close, and the comment is what makes the closure legible afterwards. A branch
 * somebody has pushed to is never closed -- their commits are not ours to discard -- so
 * it gets the same comment once and is then left alone.
 */
export interface SupersededPr {
  id: number
  number: number
  branch: string
  user_owned: number
}

/**
 * Open pull requests for which EVERY linked update has been superseded.
 *
 * Every, not any: a group whose members have drifted apart still has live work in it, and
 * closing it would discard the member that is still current. Those refuse to auto-merge
 * instead (see the state filter in automerge.ts) and are left for a person.
 *
 * The first EXISTS is not redundant -- without it a pull request with no linked updates
 * at all would satisfy the NOT EXISTS vacuously and be closed.
 */
export function supersededPrs(): SupersededPr[] {
  return getDb()
    .prepare(
      `SELECT p.id, p.number, p.branch, p.user_owned
       FROM prs p
       WHERE p.state = 'open'
         AND EXISTS (SELECT 1 FROM pr_updates pu WHERE pu.pr_id = p.id)
         AND NOT EXISTS (
           SELECT 1 FROM pr_updates pu JOIN updates u ON u.id = pu.update_id
           WHERE pu.pr_id = p.id AND u.state != 'superseded')
       ORDER BY p.number`,
    )
    .all() as SupersededPr[]
}

/** What overtook it: the newest live update for the same service, and its PR if open. */
export function successorFor(prId: number): { toTag: string; number: number | null } | null {
  return (getDb()
    .prepare(
      `SELECT u2.to_tag AS toTag, p2.number AS number
       FROM pr_updates pu
       JOIN updates u ON u.id = pu.update_id
       JOIN updates u2 ON u2.stack = u.stack AND u2.service = u.service
                      AND u2.state IN ('detected','pr_open','held')
       LEFT JOIN pr_updates pu2 ON pu2.update_id = u2.id
       LEFT JOIN prs p2 ON p2.id = pu2.pr_id AND p2.state = 'open'
       WHERE pu.pr_id = ?
       ORDER BY u2.id DESC
       LIMIT 1`,
    )
    .get(prId) ?? null) as { toTag: string; number: number | null } | null
}

/** Marks our own note so it is written once rather than every poll. */
const SUPERSEDED_MARK = '<!-- shipshape:superseded -->'

function supersededNote(next: { toTag: string; number: number | null } | null, mine: boolean): string {
  const to = next
    ? next.number
      ? `**${next.toTag}**, in #${next.number}`
      : `**${next.toTag}**`
    : 'a newer version'
  return mine
    ? `${SUPERSEDED_MARK}\nSuperseded: the target moved on to ${to}, so this pull request bumps a version nothing is tracking any more.\n\n<sub>Left open because this branch carries your commits. Rebase it onto the new target or close it — shipshape will not touch it either way.</sub>`
    : `${SUPERSEDED_MARK}\nClosed: the target moved on to ${to}. Both change the same \`image:\` line from the same base, so only one of them can merge.\n\n<sub>Nothing is lost — the newer pull request carries this bump too.</sub>`
}

/** True when we have already said this on this pull request. */
async function alreadyNoted(number: number): Promise<boolean> {
  const { owner, repo } = repoParts()
  try {
    const { data } = await gh().rest.issues.listComments({ owner, repo, issue_number: number, per_page: 100 })
    return data.some((c) => (c.body ?? '').includes(SUPERSEDED_MARK))
  } catch {
    // Unreadable comments must not cause a double-post, and must not block the close.
    return true
  }
}

export async function closeSupersededPrs(policy: Policy): Promise<number> {
  if (!policy.prs.close_superseded) return 0
  const candidates = supersededPrs()
  if (candidates.length === 0) return 0

  const { owner, repo } = repoParts()
  const db = getDb()
  let closed = 0
  // ensureWorkRepo fetches over the network every call, so resolve it once and only if
  // something actually needs its branch deleted -- a pass that finds only user-owned
  // candidates should cost no git at all.
  let workRepo: string | null = null

  for (const pr of candidates) {
    const next = successorFor(pr.id)
    try {
      if (pr.user_owned) {
        // Their branch, their call. Say it once and leave it.
        if (await alreadyNoted(pr.number)) continue
        await gh().rest.issues.createComment({
          owner,
          repo,
          issue_number: pr.number,
          body: supersededNote(next, true),
        })
        logEvent({
          level: 'info',
          kind: 'pr',
          message: `#${pr.number} is superseded but is yours`,
          detail: 'left open; rebase it onto the new target or close it',
        })
        continue
      }

      await gh().rest.issues.createComment({
        owner,
        repo,
        issue_number: pr.number,
        body: supersededNote(next, false),
      })
      await gh().rest.pulls.update({ owner, repo, pull_number: pr.number, state: 'closed' })

      // Best effort. The pull request is closed either way, and a left-behind branch is
      // cosmetic -- whereas failing here would retry the whole close every poll.
      workRepo ??= await ensureWorkRepo()
      await git(workRepo, ['push', httpsUrl(), '--delete', pr.branch], {
        remote: true,
        allowFail: true,
      })

      db.prepare(`UPDATE prs SET state = 'closed' WHERE id = ?`).run(pr.id)
      closed++

      const detail = next
        ? next.number
          ? `superseded by ${next.toTag} in #${next.number}`
          : `superseded by ${next.toTag}`
        : 'superseded'
      logEvent({ level: 'info', kind: 'pr', message: `#${pr.number} closed as superseded`, detail })
      await routine({
        category: 'superseded',
        summary: `#${pr.number} closed — ${detail}`,
        url: `https://github.com/${env.githubRepo}/pull/${pr.number}`,
      })
    } catch (err) {
      logEvent({
        level: 'warn',
        kind: 'pr',
        message: `could not close superseded #${pr.number}`,
        detail: (err as Error).message.slice(0, 200),
      })
    }
  }
  return closed
}

/** Pending updates that policy says deserve a PR, grouped so companions travel together. */
function eligibleGroups(policy: Policy): UpdateGroup[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT u.id, u.stack, u.service, u.image, u.from_tag, u.to_tag, u.magnitude, u.tier,
              u.detail
       FROM updates u
       WHERE u.state = 'detected'
         AND NOT EXISTS (SELECT 1 FROM pr_updates pu JOIN prs p ON p.id = pu.pr_id
                         WHERE pu.update_id = u.id AND p.state = 'open')
       ORDER BY u.id`,
    )
    .all() as (GroupMember & { detail: string | null })[]

  const candidates = rows.filter((r) =>
    shouldOpenPr({
      scope: policy.prs.scope,
      tier: r.tier as EffectiveTier,
      magnitude: r.magnitude as Magnitude,
      rolling: r.detail === 'rolling',
    }),
  )
  if (candidates.length === 0) return []

  const services = scanRepo(env.repoDir, policy.exclude_stacks)
  const { sourceRepoFor, groupLabelFor } = makeLookups(services)
  return groupUpdates(candidates, sourceRepoFor, groupLabelFor)
}

/**
 * Log a standing condition once, and again only when it changes.
 *
 * In-memory rather than in the database on purpose: the point is to keep a *repeating*
 * observation out of the log, and a restart is a good moment to restate one. Keyed by
 * a prefix so the condition can be cleared when it stops being true.
 */
const noted = new Map<string, string>()

function noteOnce(key: string, message: string, detail?: string): void {
  const prefix = key.split(':')[0]!
  if (noted.get(prefix) === key) return
  noted.set(prefix, key)
  logEvent({ level: 'info', kind: 'pr', message, detail })
}

function clearNote(prefix: string): void {
  noted.delete(prefix)
}

function countOpenPrs(): number {
  return (getDb().prepare(`SELECT COUNT(*) c FROM prs WHERE state = 'open'`).get() as { c: number })
    .c
}

async function openPr(repoDir: string, group: UpdateGroup, policy: Policy): Promise<boolean> {
  const branch = branchFor(group)
  const members = group.members
  const stack = members[0]!.stack

  // Always cut from the freshly-fetched origin tip, never from whatever the work clone
  // happened to be on.
  await git(repoDir, ['checkout', '-B', branch, 'origin/main'])

  const files = new Map<string, string>()
  for (const m of members) {
    const file = composeFileFor(m.stack, m.service)
    if (!file) return failGroup(group, `no compose file recorded for ${m.stack}/${m.service}`)
    const oldRef = m.image
    const newRef = rewriteRef(oldRef, m.to_tag)
    if (!newRef) return failGroup(group, `cannot build a new reference from "${m.to_tag}"`)

    const edit = await bumpImage({
      repoDir,
      composeFile: file,
      service: m.service,
      expectedOldRef: oldRef,
      newRef,
    })
    if (!edit.ok) return failGroup(group, edit.reason)
    files.set(file, file)
  }

  const title = prTitle(group)
  await git(repoDir, [...authorArgs(), 'commit', '-am', title])
  const sha = (await git(repoDir, ['rev-parse', 'HEAD'])).stdout

  const push = await pushBranch(repoDir, branch)
  if (!push.ok) return failGroup(group, push.reason)

  // After the push, so a registry being slow or down delays the body's links rather
  // than the branch. sourceRepos never throws; unresolved members simply lose theirs.
  const sources = await sourceRepos(group)

  const { owner, repo } = repoParts()
  const created = await gh().rest.pulls.create({
    owner,
    repo,
    base: 'main',
    head: branch,
    title,
    body: prBody(group, policy, sources),
  })
  const number = created.data.number

  await gh().rest.issues.addLabels({
    owner,
    repo,
    issue_number: number,
    labels: ['image-update', foldGroupMagnitude(members.map((m) => m.magnitude as Magnitude)), 'needs-analysis'],
  })

  recordPr({ number, branch, sha, groupKey: group.key, memberIds: members.map((m) => m.id) })
  // Recorded per pull request rather than as one "N opened" message at the end of the
  // pass: a pass is an implementation detail of the poll loop, and batching is now the
  // digest's job. Each item names what moved, so the digest can list them.
  const one = members.length === 1 ? members[0]! : null
  await routine({
    category: 'opened',
    stack,
    service: one?.service,
    // The digest prefixes every line with stack/service, so naming the service again
    // here reads as "servarr/radarr: radarr 5.28 -> 5.29". A group has no single
    // service to prefix with, so there the names belong in the summary.
    summary: one
      ? `${short(one.from_tag)} -> ${short(one.to_tag)} (#${number})`
      : `${describe(group)} (#${number})`,
    url: `https://github.com/${env.githubRepo}/pull/${number}`,
  })
  logEvent({
    level: 'info',
    kind: 'pr',
    stack,
    service: members.length === 1 ? members[0]!.service : undefined,
    message: `opened #${number}: ${describe(group)}`,
    detail: members.length > 1 ? `${members.length} services move together` : undefined,
  })
  return true
}

async function pushBranch(
  repoDir: string,
  branch: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const known = getDb()
    .prepare(`SELECT head_sha_pushed, user_owned FROM prs WHERE branch = ? AND state = 'open'`)
    .get(branch) as { head_sha_pushed: string; user_owned: number } | undefined

  const remote = await git(repoDir, ['ls-remote', httpsUrl(), `refs/heads/${branch}`], {
    remote: true,
    allowFail: true,
  })
  const remoteSha = remote.stdout.split('\t')[0] ?? ''

  if (remoteSha) {
    // The branch exists upstream. Only overwrite it if it is still exactly what we last
    // pushed -- anything else means a human has been editing it.
    if (!known || known.head_sha_pushed !== remoteSha || known.user_owned) {
      return {
        ok: false,
        reason: `branch ${branch} has been modified upstream; leaving it alone`,
      }
    }
    const forced = await git(repoDir, ['push', '--force-with-lease', httpsUrl(), branch], {
      remote: true,
      allowFail: true,
    })
    if (forced.exitCode !== 0) return { ok: false, reason: forced.stderr.slice(0, 200) }
    return { ok: true }
  }

  const pushed = await git(repoDir, ['push', '-u', httpsUrl(), branch], {
    remote: true,
    allowFail: true,
  })
  if (pushed.exitCode !== 0) return { ok: false, reason: pushed.stderr.slice(0, 200) }
  return { ok: true }
}

function failGroup(group: UpdateGroup, reason: string): boolean {
  logEvent({
    level: 'warn',
    kind: 'pr',
    stack: group.members[0]!.stack,
    message: 'skipped opening a pull request',
    detail: reason,
  })
  return false
}

function recordPr(opts: {
  number: number
  branch: string
  sha: string
  groupKey: string | null
  memberIds: number[]
}): void {
  const db = getDb()
  const now = new Date().toISOString()
  db.transaction(() => {
    const info = db
      .prepare(
        // Explicitly tag-only: the editor's gates guarantee the commit touched nothing
        // else. A compose-editing feature would set 'modified' here instead.
        `INSERT INTO prs (number, branch, head_sha_pushed, state, group_key, scope, created_at)
         VALUES (?, ?, ?, 'open', ?, 'tag-only', ?)`,
      )
      .run(opts.number, opts.branch, opts.sha, opts.groupKey, now)
    const link = db.prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`)
    const mark = db.prepare(`UPDATE updates SET state = 'pr_open', updated_at = ? WHERE id = ?`)
    for (const id of opts.memberIds) {
      link.run(info.lastInsertRowid, id)
      mark.run(now, id)
    }
  })()
}

// ------------------------------------------------------------------ rendering

function describe(g: UpdateGroup): string {
  const m = g.members[0]!
  const names = g.members.map((x) => x.service).join(', ')
  return `${names} ${short(m.from_tag)} -> ${short(m.to_tag)}`
}

function prTitle(g: UpdateGroup): string {
  const m = g.members[0]!
  const names = g.members.map((x) => x.service).join(', ')
  return `chore(deps): ${m.stack}: bump ${names} ${short(m.from_tag)} -> ${short(m.to_tag)}`
}

/**
 * The upstream repository for each member, resolved before the body is written.
 *
 * Resolving here rather than reading the cache is deliberate. The cache is populated by
 * `analyze()`, which runs a minute *after* the pull request opens, so at this point most
 * images have no row -- and a reference section that said "no upstream resolved" for
 * almost every pull request would be worse than none. Nothing extra is spent: the answer
 * is cached permanently and analysis would have made the identical call moments later.
 *
 * Note it is not read through groups.ts's `sourceRepoFor`, which falls back to the
 * image's own repository path when nothing resolves. That fallback is right for deciding
 * what to group -- two services sharing an image share an identity -- and wrong here,
 * where it would render as a GitHub link that 404s.
 */
async function sourceRepos(g: UpdateGroup): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>()
  for (const m of g.members) {
    const ref = parseImageRef(m.image)
    try {
      const r = await resolveSource({
        registry: ref.registry,
        repository: ref.repository,
        tag: ref.tag ?? m.from_tag,
        sourceLabel: sourceLabelFor(m.stack, m.service),
      })
      out.set(m.id, r.sourceRepo)
    } catch {
      // A pull request must open whether or not a registry is reachable. Links are the
      // one part of it that is genuinely optional.
      out.set(m.id, null)
    }
  }
  return out
}

/** The service's `shipshape.source` label, as recorded by the last scan. */
function sourceLabelFor(stack: string, service: string): string | null {
  const row = getDb()
    .prepare(`SELECT source_label FROM images WHERE stack = ? AND service = ?`)
    .get(stack, service) as { source_label: string | null } | undefined
  return row?.source_label ?? null
}


function composeFileFor(stack: string, service: string): string | null {
  const row = getDb()
    .prepare(`SELECT compose_file FROM images WHERE stack = ? AND service = ?`)
    .get(stack, service) as { compose_file: string } | undefined
  return row?.compose_file ?? null
}

function rewriteRef(currentRef: string, toTag: string): string | null {
  const ref = parseImageRef(currentRef)
  const at = toTag.indexOf('@')
  if (at === -1) return formatImageRef(ref, toTag, null)
  const tag = toTag.slice(0, at) || ref.tag
  return formatImageRef(ref, tag, toTag.slice(at + 1))
}
