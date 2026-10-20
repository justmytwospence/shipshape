import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '../config.ts'
import { authorArgs, git } from '../gitops/repo.ts'
import { parseForkRef } from '../upstream/forks.ts'
import { compareKeys, sameVersion, versionKey } from '../versions/key.ts'

/**
 * Carrying a fork's fixes onto a new upstream release (FORKS.md).
 *
 * A fork is the upstream release we already run plus the commits we carry on top of it.
 * Moving it to a newer release means replaying exactly those commits onto the new tag,
 * dropping the ones upstream has since taken, and publishing the result to our fork so
 * compose can build it from a pinned sha. This module is that, and only that: git in a
 * work clone of its own, no database and no GitHub API, so the whole thing runs against
 * two temporary repositories in a test.
 *
 * The work clone lives under `data/forks/<owner>-<repo>` with two remotes, `fork` (ours,
 * the `build.context` URL) and `upstream` (the repository the fork is based on). Each
 * side's tags are fetched into a namespace of its own, so an upstream `v3.5.1` and a
 * fork's copy of it never shadow each other.
 *
 * What a run decides:
 *
 *   carried  = the commits between the base release and the pinned sha
 *   dropped  = the ones whose patch upstream already has (`git cherry`), plus the ones
 *              whose `waits-on` reference shipped in the target release or earlier
 *   nothing left to carry -> the fork can retire
 *   otherwise the kept commits are replayed one at a time onto the target tag; the
 *   first that conflicts aborts everything and is named, and nothing is pushed
 *
 * The replay is reproducible: each commit keeps its author and its committer date, and
 * shipshape is the committer, so the same inputs give the same sha and the same tag --
 * a second run for the same update pushes nothing new. Every deployed commit stays
 * reachable through its `homelab/<version>-<sha>` tag, so a rollback can rebuild the
 * previous pin, and the `homelab` branch is moved to the newest replay with a lease on
 * the tip that was fetched, never a bare force.
 */

export interface CarriedCommit {
  sha: string
  short: string
  subject: string
  author: string
}

export interface DroppedCommit extends CarriedCommit {
  /** Why it is not carried any more. */
  reason: string
}

export interface WaitsOnState {
  ref: string
  state: 'open' | 'merged-unreleased' | 'released' | 'closed-unfixed' | 'unknown'
  releasedIn: string | null
}

export interface PrepareForkInput {
  /** The fork repository, as `build.context` names it (without `#<sha>`). */
  forkUrl: string
  /** The upstream repository's git URL. */
  upstreamUrl: string
  /** The commit the compose file builds now. */
  pinnedSha: string
  /** The upstream version the fork is based on, as `image:` spells it. */
  baseTag: string
  /** The upstream version to move to, as the update's `to_tag` spells it (no digest). */
  targetTag: string
  /** Where each reference the fork waits on stands, from the last scan. */
  waitsOn: WaitsOnState[]
  /** The length of the short sha `image:` uses. */
  shortLength?: number
  /** Where the work clone goes. Defaults under the data directory. */
  workDir?: string
  /** Only decide and replay; never push. The tests' and the preview's mode. */
  dryRun?: boolean
}

export type PrepareForkResult =
  | {
      kind: 'bump'
      /** The replayed head, pushed to the fork as `tag` and as the `homelab` branch. */
      sha: string
      short: string
      tag: string
      /** The upstream tag's spelling in git, which may differ from the image tag's. */
      upstreamTag: string
      carried: CarriedCommit[]
      dropped: DroppedCommit[]
      /** True when the fork already had this exact commit under this tag. */
      alreadyPushed: boolean
    }
  | { kind: 'retire'; upstreamTag: string; dropped: DroppedCommit[] }
  | {
      kind: 'conflict'
      commit: CarriedCommit
      files: string[]
      /** The sentence the update shows. */
      detail: string
      carried: CarriedCommit[]
      dropped: DroppedCommit[]
    }
  | { kind: 'refused'; reason: string }

/** `data/forks/<owner>-<repo>` for a GitHub URL, or a sanitised form of anything else. */
export function forkWorkDir(forkUrl: string, dataDir = env.dataDir): string {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(forkUrl)
  const name = m ? `${m[1]}-${m[2]}` : forkUrl.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(-80)
  return join(dataDir, 'forks', name)
}

/** The upstream repository's URL from `owner/repo`, or from the first waits-on reference. */
export function upstreamUrlFor(sourceRepo: string | null, waitsOn: readonly string[]): string | null {
  const repo = sourceRepo ?? waitsOn.map((r) => parseForkRef(r)?.repo ?? null).find((r) => r) ?? null
  return repo ? `https://github.com/${repo}.git` : null
}

/** A refusal a push gets when the token can read the fork but not write it. */
const NO_WRITE = /403|write access|permission to|not granted|denied|not authorized|authentication failed/i

const UP = 'refs/rtags/upstream/'
const FK = 'refs/rtags/fork/'

export async function prepareFork(input: PrepareForkInput): Promise<PrepareForkResult> {
  const dir = input.workDir ?? forkWorkDir(input.forkUrl)
  const refuse = (reason: string): PrepareForkResult => ({ kind: 'refused', reason })

  // 1. The work clone, with both remotes current.
  try {
    await ensureClone(dir, input.forkUrl, input.upstreamUrl)
  } catch (err) {
    return refuse(`could not fetch the fork or its upstream: ${(err as Error).message.slice(0, 300)}`)
  }

  // The pinned commit must be in the fork: through its branches and tags, or fetched by
  // sha when it is reachable but on neither (GitHub serves reachable commits by sha).
  if (!(await hasCommit(dir, input.pinnedSha))) {
    await git(dir, ['fetch', '--no-tags', 'fork', input.pinnedSha], { remote: true, allowFail: true })
    if (!(await hasCommit(dir, input.pinnedSha))) {
      return refuse(`the pinned commit ${input.pinnedSha.slice(0, 7)} is not in the fork ${input.forkUrl}`)
    }
  }

  // 2. The two upstream tags, in whatever spelling the repository uses.
  const tags = await listRefs(dir, UP)
  const baseRef = matchTag(tags, input.baseTag)
  const targetRef = matchTag(tags, input.targetTag)
  if (!baseRef) return refuse(`upstream has no tag for the fork's base ${input.baseTag}`)
  if (!targetRef) return refuse(`upstream has no tag for ${input.targetTag} yet`)
  const upstreamTag = targetRef.name
  const ancestor = await git(dir, ['merge-base', '--is-ancestor', baseRef.sha, input.pinnedSha], { allowFail: true })
  if (ancestor.exitCode !== 0) {
    return refuse(
      `the pinned commit ${input.pinnedSha.slice(0, 7)} does not descend from upstream ${baseRef.name}; the fork is not "${input.baseTag} plus fixes" as its image tag says`,
    )
  }

  // 3. What is carried, and what upstream has since taken.
  const carried = await commitsBetween(dir, baseRef.sha, input.pinnedSha)
  const merge = carried.find((c) => c.parents > 1)
  if (merge) {
    return refuse(`the fork carries a merge commit (${merge.short} ${merge.subject}); replay it by hand, FORKS.md`)
  }
  const equivalent = await alreadyUpstream(dir, targetRef.sha, input.pinnedSha, baseRef.sha)
  const shipped = shippedRefs(input.waitsOn, input.targetTag)

  const dropped: DroppedCommit[] = []
  const kept: FullCommit[] = []
  for (const c of carried) {
    if (equivalent.has(c.sha)) {
      dropped.push({ ...strip(c), reason: `upstream ${upstreamTag} carries the same change` })
      continue
    }
    const ref = shipped.find((s) => mentions(c, s.ref))
    if (ref) {
      dropped.push({ ...strip(c), reason: `${ref.ref} was released in ${ref.releasedIn}` })
      continue
    }
    kept.push(c)
  }
  if (kept.length === 0) return { kind: 'retire', upstreamTag, dropped }

  // 4. The replay, one commit at a time on a detached head.
  await git(dir, ['cherry-pick', '--abort'], { allowFail: true })
  await git(dir, ['checkout', '-q', '--detach', targetRef.sha])
  const replayed: CarriedCommit[] = []
  for (const c of kept) {
    const pick = await git(dir, [...authorArgs(), 'cherry-pick', '--allow-empty-message', c.sha], {
      allowFail: true,
      env: { GIT_COMMITTER_DATE: c.committedAt },
    })
    if (pick.exitCode === 0) {
      replayed.push(strip(c))
      continue
    }
    const conflicted = (await git(dir, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true })).stdout
      .split('\n')
      .filter(Boolean)
    if (conflicted.length > 0) {
      await git(dir, ['cherry-pick', '--abort'], { allowFail: true })
      const files = conflicted.join(', ')
      return {
        kind: 'conflict',
        commit: strip(c),
        files: conflicted,
        detail: `${c.short} "${c.subject}" conflicts with upstream ${upstreamTag} in ${files}`,
        carried: carried.map(strip),
        dropped,
      }
    }
    // No conflict and no commit: the change is already in the target, in a form the
    // patch-id did not recognise. Skipped, and said so.
    const staged = await git(dir, ['diff', '--cached', '--quiet'], { allowFail: true })
    if (staged.exitCode === 0) {
      await git(dir, ['cherry-pick', '--skip'], { allowFail: true })
      dropped.push({ ...strip(c), reason: `upstream ${upstreamTag} already contains it (empty after replay)` })
      continue
    }
    await git(dir, ['cherry-pick', '--abort'], { allowFail: true })
    return refuse(`replaying ${c.short} onto ${upstreamTag} failed: ${(pick.stderr || pick.stdout).slice(0, 200)}`)
  }
  if (replayed.length === 0) return { kind: 'retire', upstreamTag, dropped }

  const sha = (await git(dir, ['rev-parse', 'HEAD'])).stdout
  const short = sha.slice(0, input.shortLength ?? 7)
  const tag = `homelab/${input.targetTag}-${short}`

  // 5. Publish: the tag first, so the commit is reachable whatever happens to the branch.
  const forkTags = await listRefs(dir, FK)
  const existing = forkTags.find((t) => t.name === tag)
  if (existing && existing.sha !== sha) {
    return refuse(`the fork already has tag ${tag} on a different commit (${existing.sha.slice(0, 7)})`)
  }
  const alreadyPushed = !!existing
  if (!input.dryRun) {
    if (!existing) {
      const pushed = await git(dir, ['push', 'fork', `${sha}:refs/tags/${tag}`], { remote: true, allowFail: true })
      if (pushed.exitCode !== 0) return refuse(pushRefusal(input.forkUrl, pushed.stderr))
    }
    const branch = (await git(dir, ['rev-parse', '--verify', '-q', 'refs/remotes/fork/homelab'], { allowFail: true })).stdout
    if (branch !== sha) {
      const args = branch
        ? ['push', `--force-with-lease=refs/heads/homelab:${branch}`, 'fork', `${sha}:refs/heads/homelab`]
        : ['push', 'fork', `${sha}:refs/heads/homelab`]
      const moved = await git(dir, args, { remote: true, allowFail: true })
      if (moved.exitCode !== 0) return refuse(pushRefusal(input.forkUrl, moved.stderr))
    }
  }

  return { kind: 'bump', sha, short, tag, upstreamTag, carried: replayed, dropped, alreadyPushed }
}

function pushRefusal(forkUrl: string, stderr: string): string {
  if (NO_WRITE.test(stderr)) {
    return `cannot push to ${forkUrl}: grant the token contents:write on the fork repository`
  }
  return `could not push to ${forkUrl}: ${stderr.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200)}`
}

// ------------------------------------------------------------------ git plumbing

async function ensureClone(dir: string, forkUrl: string, upstreamUrl: string): Promise<void> {
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true })
    await git(dir, ['init', '-q'])
  }
  await setRemote(dir, 'fork', forkUrl)
  await setRemote(dir, 'upstream', upstreamUrl)
  // Tags namespaced per side, branches only for the fork: the replay needs upstream's
  // tags and the fork's `homelab` tip, nothing else.
  await git(dir, ['fetch', '--no-tags', '--prune', 'upstream', `+refs/tags/*:${UP}*`], {
    remote: true,
    timeoutMs: 600_000,
  })
  await git(
    dir,
    ['fetch', '--no-tags', '--prune', 'fork', '+refs/heads/*:refs/remotes/fork/*', `+refs/tags/*:${FK}*`],
    { remote: true, timeoutMs: 600_000 },
  )
}

async function setRemote(dir: string, name: string, url: string): Promise<void> {
  const current = await git(dir, ['remote', 'get-url', name], { allowFail: true })
  if (current.exitCode !== 0) await git(dir, ['remote', 'add', name, url])
  else if (current.stdout !== url) await git(dir, ['remote', 'set-url', name, url])
}

async function hasCommit(dir: string, sha: string): Promise<boolean> {
  return (await git(dir, ['cat-file', '-e', `${sha}^{commit}`], { allowFail: true })).exitCode === 0
}

interface Ref {
  name: string
  sha: string
}

/** Every ref under a prefix, by its name past the prefix and the commit it points to. */
async function listRefs(dir: string, prefix: string): Promise<Ref[]> {
  const out = await git(dir, ['for-each-ref', '--format=%(refname)%00%(*objectname)%00%(objectname)', prefix], {
    allowFail: true,
  })
  return out.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, peeled, obj] = l.split('\0') as [string, string, string]
      // An annotated tag peels to its commit; a lightweight one is the commit.
      return { name: name.slice(prefix.length), sha: peeled || obj }
    })
}

/** The tag for a version: the exact spelling first, then the same version spelt the other way. */
export function matchTag(tags: Ref[], wanted: string): Ref | null {
  const exact = tags.find((t) => t.name === wanted)
  if (exact) return exact
  const key = versionKey(wanted)
  if (!key) return null
  const same = tags.filter((t) => {
    const k = versionKey(t.name)
    return k && sameVersion(k, key)
  })
  // Prefer the plain spellings (`v1.2.3`, `1.2.3`) over anything with a suffix.
  return same.find((t) => /^v?\d/.test(t.name) && !/-/.test(t.name)) ?? same[0] ?? null
}

interface FullCommit extends CarriedCommit {
  parents: number
  committedAt: string
  body: string
}

const strip = (c: FullCommit): CarriedCommit => ({ sha: c.sha, short: c.short, subject: c.subject, author: c.author })

async function commitsBetween(dir: string, base: string, head: string): Promise<FullCommit[]> {
  const out = await git(dir, [
    'log',
    '--reverse',
    '--format=%H%x1f%h%x1f%s%x1f%an%x1f%P%x1f%cI%x1f%B%x1e',
    `${base}..${head}`,
  ])
  return out.stdout
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r.trim())
    .map((r) => {
      const [sha, short, subject, author, parents, committedAt, body] = r.split('\x1f') as string[]
      return {
        sha: sha!,
        short: short!,
        subject: subject ?? '',
        author: author ?? '',
        parents: (parents ?? '').split(' ').filter(Boolean).length,
        committedAt: committedAt ?? '',
        body: body ?? '',
      }
    })
}

/** The carried commits whose patch the target already has, by patch-id. */
async function alreadyUpstream(dir: string, target: string, head: string, limit: string): Promise<Set<string>> {
  const out = await git(dir, ['cherry', target, head, limit], { allowFail: true })
  const set = new Set<string>()
  for (const line of out.stdout.split('\n')) {
    const m = /^-\s+([0-9a-f]{40})/.exec(line)
    if (m) set.add(m[1]!)
  }
  return set
}

/** The references whose fix shipped in the target release or an earlier one. */
export function shippedRefs(waitsOn: readonly WaitsOnState[], targetTag: string): { ref: string; releasedIn: string }[] {
  const target = versionKey(targetTag)
  const out: { ref: string; releasedIn: string }[] = []
  for (const w of waitsOn) {
    if (w.state !== 'released' || !w.releasedIn) continue
    const k = versionKey(w.releasedIn)
    if (!k || !target) continue
    const cmp = compareKeys(k, target)
    if (cmp !== null && cmp <= 0) out.push({ ref: w.ref, releasedIn: w.releasedIn })
  }
  return out
}

/** Whether a commit's message names a reference: `owner/repo#N`, or `#N` on its own. */
export function mentions(c: { subject: string; body: string }, ref: string): boolean {
  const p = parseForkRef(ref)
  if (!p) return false
  const text = `${c.subject}\n${c.body}`
  if (text.toLowerCase().includes(ref.toLowerCase())) return true
  return new RegExp(`(^|[^\\w/])#${p.number}(?!\\d)`).test(text)
}
