import { env, loadPolicy } from '../config.ts'
import { logEvent } from '../db.ts'
import { notifyOnce, clearNotifyState, notify } from '../notify/index.ts'
import { authorArgs, git, httpsUrl } from './repo.ts'

/**
 * Keeping the live checkout and origin in step.
 *
 * The live checkout is someone's working directory. It carries uncommitted work, it
 * moves under us, and it is the only place deploys can run from. So this does the
 * smallest possible set of operations on it -- fetch, fast-forward, rebase -- and
 * refuses loudly rather than doing anything clever when reality does not match.
 *
 * Publishing `main` is a precondition for opening PRs at all, not a nicety: a branch cut
 * from a stale origin/main silently reverts every unpushed local commit that touched the
 * same file when it merges.
 */

export type SyncResult =
  | { status: 'in-sync'; sha: string }
  | { status: 'pushed'; sha: string }
  | { status: 'pulled'; sha: string }
  | { status: 'rebased-pushed'; sha: string }
  /** Preconditions failed. Nothing was touched. */
  | { status: 'paused'; reason: string }
  /** A real conflict a human must resolve. Nothing was touched. */
  | { status: 'refused'; reason: string }

const HOMELAB = () => env.repoDir

export async function syncMain(): Promise<SyncResult> {
  const { policy } = loadPolicy()

  // --- preconditions -------------------------------------------------------
  const head = await git(HOMELAB(), ['symbolic-ref', '--short', 'HEAD'], { allowFail: true })
  if (head.exitCode !== 0 || head.stdout !== 'main') {
    const reason = `checkout is on "${head.stdout || 'a detached HEAD'}", not main`
    await pause(reason)
    return { status: 'paused', reason }
  }

  const porcelain = await git(HOMELAB(), ['status', '--porcelain=v2', '--branch'])
  if (/^# branch.ab/.test(porcelain.stdout) === false && porcelain.stdout === '') {
    // No branch header at all is unexpected; treat as unknown rather than proceeding.
  }
  const midOperation = await inProgress()
  if (midOperation) {
    const reason = `a ${midOperation} is in progress in the checkout`
    await pause(reason)
    return { status: 'paused', reason }
  }

  // --- classify ------------------------------------------------------------
  await git(HOMELAB(), ['fetch', httpsUrl(), 'main'], { remote: true })
  const local = (await git(HOMELAB(), ['rev-parse', 'main'])).stdout
  const remote = (await git(HOMELAB(), ['rev-parse', 'FETCH_HEAD'])).stdout
  const base = (await git(HOMELAB(), ['merge-base', 'main', 'FETCH_HEAD'])).stdout

  if (local === remote) {
    clearNotifyState('sync')
    return { status: 'in-sync', sha: local }
  }

  if (base === remote) {
    // Local is ahead: publish it.
    if (!policy.sync.push_main) {
      const reason = 'push_main is disabled, so main cannot be published'
      await pause(reason)
      return { status: 'paused', reason }
    }
    const pushed = await pushMain()
    if (pushed.status !== 'ok') return { status: 'refused', reason: pushed.reason }
    clearNotifyState('sync')
    logEvent({ level: 'info', kind: 'sync', message: 'pushed main to origin' })
    return { status: 'pushed', sha: local }
  }

  if (base === local) {
    // Origin is ahead: a PR merged. Land it.
    const landed = await fastForward()
    if (landed.status !== 'ok') return { status: 'refused', reason: landed.reason }
    clearNotifyState('sync')
    logEvent({ level: 'info', kind: 'sync', message: 'fast-forwarded main from origin' })
    return { status: 'pulled', sha: remote }
  }

  // Diverged: the user committed locally while a PR merged remotely.
  const rebased = await rebaseOntoOrigin()
  if (rebased.status !== 'ok') return { status: 'refused', reason: rebased.reason }
  if (policy.sync.push_main) {
    const pushed = await pushMain()
    if (pushed.status !== 'ok') return { status: 'refused', reason: pushed.reason }
  }
  clearNotifyState('sync')
  const sha = (await git(HOMELAB(), ['rev-parse', 'main'])).stdout
  logEvent({ level: 'info', kind: 'sync', message: 'rebased local commits onto origin' })
  return { status: 'rebased-pushed', sha }
}

async function inProgress(): Promise<string | null> {
  const gitDir = (await git(HOMELAB(), ['rev-parse', '--git-dir'])).stdout
  const abs = gitDir.startsWith('/') ? gitDir : `${HOMELAB()}/${gitDir}`
  const { existsSync } = await import('node:fs')
  if (existsSync(`${abs}/rebase-merge`) || existsSync(`${abs}/rebase-apply`)) return 'rebase'
  if (existsSync(`${abs}/MERGE_HEAD`)) return 'merge'
  if (existsSync(`${abs}/CHERRY_PICK_HEAD`)) return 'cherry-pick'
  return null
}

async function pushMain(): Promise<{ status: 'ok' } | { status: 'failed'; reason: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    // Never --force. If this is rejected, origin moved and the next cycle reclassifies.
    const r = await git(HOMELAB(), ['push', httpsUrl(), 'main:main'], {
      remote: true,
      allowFail: true,
    })
    if (r.exitCode === 0) return { status: 'ok' }
    if (!/non-fast-forward|fetch first|rejected/i.test(r.stderr)) {
      return { status: 'failed', reason: `push failed: ${r.stderr.slice(0, 200)}` }
    }
    await git(HOMELAB(), ['fetch', httpsUrl(), 'main'], { remote: true })
  }
  return { status: 'failed', reason: 'push kept losing a race with origin' }
}

/**
 * Land origin's commits without disturbing unrelated local work.
 *
 * Git already refuses to overwrite a dirty file, but its message is opaque. Checking
 * first means the common case -- the nightly updater having already written the exact
 * bytes the merge is about to bring in -- resolves silently, and the genuinely
 * conflicting case produces a message naming the files.
 */
async function fastForward(): Promise<{ status: 'ok' } | { status: 'failed'; reason: string }> {
  const incoming = (await git(HOMELAB(), ['diff', '--name-only', 'main', 'FETCH_HEAD'])).stdout
    .split('\n')
    .filter(Boolean)
  const dirty = (await git(HOMELAB(), ['status', '--porcelain'])).stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3).trim())

  const collisions = incoming.filter((f) => dirty.includes(f))
  const conflicting: string[] = []

  for (const file of collisions) {
    const theirs = await git(HOMELAB(), ['show', `FETCH_HEAD:${file}`], { allowFail: true })
    if (theirs.exitCode !== 0) {
      conflicting.push(file)
      continue
    }
    const { readFileSync } = await import('node:fs')
    let ours: string
    try {
      ours = readFileSync(`${HOMELAB()}/${file}`, 'utf8')
    } catch {
      conflicting.push(file)
      continue
    }
    // `git show` strips nothing but the trailing newline handling can differ; compare
    // trimmed-right so a byte-identical file is recognised as such.
    if (ours.replace(/\s+$/, '') === theirs.stdout.replace(/\s+$/, '')) {
      await git(HOMELAB(), ['restore', '--', file])
      logEvent({
        level: 'info',
        kind: 'sync',
        message: `discarded an identical local copy of ${file}`,
        detail: 'the incoming commit contains the same bytes',
      })
    } else {
      conflicting.push(file)
    }
  }

  if (conflicting.length > 0) {
    const reason = `local edits conflict with the merged change in: ${conflicting.join(', ')}`
    logEvent({ level: 'error', kind: 'sync', message: 'sync refused', detail: reason })
    await notify({
      title: 'shipshape: sync blocked',
      body:
        `A pull request merged, but these files have conflicting local edits:\n` +
        `${conflicting.join('\n')}\n\nCommit or discard them and shipshape will resume.`,
      priority: 4,
      tags: ['warning'],
    })
    return { status: 'failed', reason }
  }

  const merged = await git(HOMELAB(), ['merge', '--ff-only', 'FETCH_HEAD'], { allowFail: true })
  if (merged.exitCode !== 0) {
    const reason = `fast-forward refused: ${merged.stderr.slice(0, 200)}`
    logEvent({ level: 'error', kind: 'sync', message: 'sync refused', detail: reason })
    return { status: 'failed', reason }
  }
  return { status: 'ok' }
}

/**
 * Replay local commits on top of origin. `--autostash` protects uncommitted work, and
 * git's patch-id matching silently drops any local commit whose content already landed
 * upstream -- which is exactly what happens when the nightly updater and a merged PR
 * make the same bump.
 */
async function rebaseOntoOrigin(): Promise<{ status: 'ok' } | { status: 'failed'; reason: string }> {
  // The identity is not optional here. A rebase writes commits, and the container has no
  // git identity of its own -- it runs as the host user with no ~/.gitconfig -- so
  // without this git refuses with "Committer identity unknown" and the rebase fails
  // every time. Every other path that writes a commit already passes these; this one did
  // not, and the gap was invisible because divergence is rare: shipshape publishes main
  // each cycle, so the fast-forward branch above handles almost everything. The first
  // time a local commit and a merge on origin crossed, sync broke -- and a broken sync
  // blocks deploys and pull requests both.
  const r = await git(HOMELAB(), [...authorArgs(), 'rebase', '--autostash', 'FETCH_HEAD'], {
    allowFail: true,
  })
  if (r.exitCode === 0) return { status: 'ok' }

  // Leave nothing half-applied. An aborted rebase restores the exact prior state.
  await git(HOMELAB(), ['rebase', '--abort'], { allowFail: true })
  const still = await inProgress()
  const reason =
    `rebase onto origin failed: ${r.stderr.slice(0, 200)}` +
    (still ? ` -- and the abort did not clean up (${still} still in progress)` : '')
  logEvent({
    level: 'error',
    kind: 'sync',
    message: 'sync refused',
    detail: reason,
  })
  await notify({
    title: 'shipshape: rebase conflict',
    body:
      `Local commits could not be replayed onto origin/main.\n${r.stderr.slice(0, 300)}\n\n` +
      `The checkout was restored; resolve by hand and shipshape will resume.`,
    priority: 4,
    tags: ['warning'],
  })
  return { status: 'failed', reason }
}

async function pause(reason: string): Promise<void> {
  logEvent({ level: 'warn', kind: 'sync', message: 'sync paused', detail: reason })
  await notifyOnce('sync', reason, {
    title: 'shipshape: paused',
    body: `${reason}.\n\nNothing was changed. shipshape resumes once the checkout is back on main and clean of in-progress operations.`,
    priority: 3,
    tags: ['pause_button'],
  })
}
