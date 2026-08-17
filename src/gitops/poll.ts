import { Octokit } from 'octokit'
import { env, loadPolicy } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { notify } from '../notify/index.ts'
import { routine } from '../notify/digest.ts'
import { withGitLock } from './repo.ts'
import { syncMain } from './sync.ts'
import { manualCommand, stackPeers, withNamespacePeers, type DeployTarget } from '../deploy/run.ts'
import { enqueueDeploy, hasDueRechecks, hasPendingDeploys } from '../deploy/queue.ts'

/**
 * Watching for merges.
 *
 * Polling rather than a webhook: it needs no inbound exposure, no shared secret, and no
 * replay handling, and 60 seconds of latency between merging and deploying is not worth
 * any of that. GitHub's authenticated budget makes the request cost irrelevant.
 */

let octokit: Octokit | null = null
function gh(): Octokit {
  octokit ??= new Octokit({ auth: env.githubToken })
  return octokit
}

export interface PollResult {
  merged: number
  closed: number
  checked: number
}

let pollChain: Promise<unknown> = Promise.resolve()

/**
 * Serialised, because there are now two callers.
 *
 * The scheduler runs this on a timer; the merge route runs it immediately so a merge
 * made from the UI is picked up at once rather than up to a poll cycle later -- which
 * matters most during a blackout, when the scheduler skips the loop entirely. Two
 * overlapping passes would both see the same pull request as open, both run onMerged,
 * and `enqueueDeploy` is a plain INSERT with no dedupe: the stack would be deployed
 * twice. Chained rather than coalesced on purpose -- a caller that has just merged needs
 * a pass that STARTS after its merge, not one already half way through a stale list.
 */
export function pollPrs(): Promise<PollResult> {
  const run = pollChain.then(pollPass, pollPass)
  pollChain = run.catch(() => undefined)
  return run
}

async function pollPass(): Promise<PollResult> {
  const out: PollResult = { merged: 0, closed: 0, checked: 0 }
  if (!env.githubToken) return out

  const open = getDb()
    .prepare(
      `SELECT id, number, branch, group_key, head_sha_pushed, scope, scope_sha
       FROM prs WHERE state = 'open'`,
    )
    .all() as {
    id: number
    number: number
    branch: string
    head_sha_pushed: string
    scope: string
    scope_sha: string | null
  }[]
  if (open.length === 0) return out

  const [owner, repo] = env.githubRepo.split('/') as [string, string]

  for (const pr of open) {
    out.checked++
    let data
    try {
      data = (await gh().rest.pulls.get({ owner, repo, pull_number: pr.number })).data
    } catch (err) {
      logEvent({
        level: 'warn',
        kind: 'pr',
        message: `could not read pull request #${pr.number}`,
        detail: (err as Error).message,
      })
      continue
    }

    // A head that no longer matches what we pushed means a human edited the branch.
    // From then on it is theirs: never force-pushed, never regenerated. Restoring it
    // to shipshape's own commit hands ownership back, since there is nothing of theirs
    // left on it.
    const owned = data.head.sha !== pr.head_sha_pushed
    getDb().prepare(`UPDATE prs SET user_owned = ? WHERE id = ?`).run(owned ? 1 : 0, pr.id)

    // Re-classify whenever the head has moved since the last classification -- in
    // either direction, so an edit that is later reverted stops being reported as one.
    if (data.state === 'open' && data.head.sha !== pr.scope_sha) {
      await classifyScope(pr.id, pr.number, pr.scope, data.head.sha, !owned)
    }

    if (data.state === 'open') continue

    if (data.merged_at) {
      out.merged++
      await onMerged(pr.id, pr.number, data.merge_commit_sha ?? null)
    } else {
      out.closed++
      onClosed(pr.id, pr.number)
    }
  }

  return out
}

/**
 * Does this pull request still contain only the image-tag change shipshape wrote?
 *
 * Called when a branch's head has moved past what shipshape pushed. Some updates
 * genuinely require more than a tag bump -- an upstream that renames its image, say --
 * and a branch carrying that work must be visibly different from a clean bump, because
 * nothing has reviewed the extra changes.
 *
 * Errs toward `modified`: mislabelling an edited PR as clean is the expensive direction,
 * since auto-merge will one day trust this field.
 */
export function classifyPatch(
  files: { filename: string; patch?: string }[],
  truncated: boolean,
): 'tag-only' | 'modified' {
  if (truncated) return 'modified'
  for (const f of files) {
    if (!f.filename.endsWith('docker-compose.yaml')) return 'modified'
    for (const line of (f.patch ?? '').split('\n')) {
      if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line)) continue
      // Same test the editor and the repo's own commit script use.
      if (!/^[+-]\s*image:\s/.test(line)) return 'modified'
    }
  }
  return 'tag-only'
}

async function classifyScope(
  prId: number,
  number: number,
  was: string,
  headSha: string,
  shipshapeOwns: boolean,
): Promise<void> {
  const [owner, repo] = env.githubRepo.split('/') as [string, string]
  let scope: 'tag-only' | 'modified' | 'proposed'
  try {
    const res = await gh().rest.pulls.listFiles({ owner, repo, pull_number: number, per_page: 100 })
    scope = classifyPatch(res.data, res.data.length >= 100)
    // shipshape's own drafted config changes are not a human edit. The patch test cannot
    // tell them apart -- both are "more than an image line" -- so ownership decides:
    // the head is still exactly what shipshape pushed, and a proposal was recorded
    // against it. Without this the next poll relabels every proposal as `modified` and
    // the distinction disappears within one cycle.
    if (shipshapeOwns && scope === 'modified' && hasProposal(prId)) scope = 'proposed'
  } catch {
    // Unknown is not the same as clean; leave whatever was there rather than guessing,
    // and do not record the sha, so the next poll retries.
    return
  }

  getDb().prepare(`UPDATE prs SET scope = ?, scope_sha = ? WHERE id = ?`).run(scope, headSha, prId)
  if (scope === was) return
  logEvent({
    level: 'info',
    kind: 'pr',
    message:
      scope === 'modified'
        ? `#${number} now contains changes beyond the image tag`
        : scope === 'proposed'
          ? `#${number} carries shipshape's drafted config changes`
          : `#${number} is back to an image-tag change only`,
    detail: scope === 'tag-only' ? undefined : 'it will always need a human to merge',
  })
}

/** Did shipshape successfully draft config changes onto this pull request? */
function hasProposal(prId: number): boolean {
  return !!getDb()
    .prepare(`SELECT 1 FROM proposals WHERE pr_id = ? AND error IS NULL LIMIT 1`)
    .get(prId)
}

async function onMerged(
  prId: number,
  number: number,
  mergeSha: string | null,
): Promise<void> {
  const { policy } = loadPolicy()
  const db = getDb()
  const now = new Date().toISOString()
  const members = db
    .prepare(
      `SELECT u.id, u.stack, u.service, u.to_tag FROM updates u
       JOIN pr_updates pu ON pu.update_id = u.id WHERE pu.pr_id = ?`,
    )
    .all(prId) as { id: number; stack: string; service: string; to_tag: string }[]

  const stack = members[0]?.stack ?? 'unknown'
  const services = members.map((m) => m.service).join(' ')
  // Built from the same target the automatic path deploys, so what is pasted and what
  // would have run cannot disagree -- including the rm-first step and the root stack's
  // missing -f.
  const target: DeployTarget = {
    stack,
    // Plus anything that shares a namespace with them: recreating the owner strands its
    // followers on a dead one, and they go on looking perfectly healthy while it happens.
    services: withNamespacePeers(
      stack,
      [...new Set(members.map((m) => m.service))],
      stackPeers,
    ),
    // rm-first if any member asked for it: the strategy applies to the whole compose
    // invocation, and the safer of the two wins.
    strategy: members.some((m) => deployLabelFor(m.stack, m.service) === 'rm-first')
      ? 'rm-first'
      : 'up',
  }
  const command = manualCommand(target)
  // Merging leads to a deploy either way; `paused` only decides whether it starts itself
  // or waits for the operator to press the button.
  const waits = policy.paused

  db.transaction(() => {
    // The sha is recorded here because this is the only place it is offered. A deploy
    // that has to be undone needs to revert exactly what was applied, and reconstructing
    // that later means guessing which commit on main belonged to this pull request.
    db.prepare(
      `UPDATE prs SET state = 'merged', merged_at = ?, merge_commit_sha = ? WHERE id = ?`,
    ).run(now, mergeSha, prId)
    const mark = db.prepare(`UPDATE updates SET state = 'merged', updated_at = ? WHERE id = ?`)
    for (const m of members) mark.run(now, m.id)
    // Inside the transaction, deliberately. If the intent were written after it, a crash
    // in between would leave a pull request marked merged with nothing left to act on
    // it -- which is exactly how merges used to be lost, silently and permanently.
    // Always enqueued, inside the transaction. If the intent were conditional, a merge
    // performed while paused would leave nothing to press Deploy on -- which is the state
    // this deployment has been in for every merge so far: fifteen merged pull requests
    // and an empty deploys table.
    enqueueDeploy({ prId, prNumber: number, target, now, status: waits ? 'ready' : 'pending' })
  })()

  // Land it in the live checkout so the deploy runs against merged content. The queued
  // job waits for the drain later this tick, by which point this has finished.
  const sync = await withGitLock('post-merge-sync', () => syncMain())

  const synced = sync.status !== 'paused' && sync.status !== 'refused'

  // Before the branch below, deliberately. This used to live on the happy path only, so
  // a merge that arrived while the checkout was blocked never got its command -- and
  // could not get it later either, because the pull request was already `merged` and
  // `pollPrs` only ever looks at open ones. The comment does not depend on the sync
  // having worked; it only has to say whether it did.
  if (waits) await commentCommand(number, stack, command, synced)

  if (sync.status === 'paused' || sync.status === 'refused') {
    logEvent({
      level: 'warn',
      kind: 'pr',
      stack,
      message: `#${number} merged, but the checkout could not be updated`,
      detail: sync.reason,
    })
    await notify({
      title: `shipshape: #${number} merged, sync blocked`,
      body: `${sync.reason}\n\n${waits ? 'Once resolved, press Deploy in shipshape, or run:' : 'The deploy stays queued and runs once the checkout is clean.'}\n${command}`,
      priority: 4,
      tags: ['warning'],
    })
    return
  }

  logEvent({
    level: 'info',
    kind: 'pr',
    stack,
    message: `#${number} merged and synced`,
    detail: waits ? `ready to deploy, or: ${command}` : 'deploying',
  })

  if (waits) {
    // The digest item is the record; the comment above is what reaches the person who
    // merged thirty seconds ago, rather than at 08:00 tomorrow.
    await routine({
      category: 'merged',
      stack,
      summary: `#${number} merged — ready to deploy`,
      detail: `${stack}: ${services}\n\nPress Deploy in shipshape, or run:\n${command}`,
      url: `https://github.com/${env.githubRepo}/pull/${number}`,
    })
    return
  }

  logEvent({
    level: 'info',
    kind: 'deploy',
    stack,
    message: `deploy of ${stack} queued for #${number}`,
    detail: target.services.join(', '),
  })
}

/** The service's `shipshape.deploy` label, as recorded by the last scan. */
function deployLabelFor(stack: string, service: string): string | null {
  const row = getDb()
    .prepare(`SELECT deploy_label FROM images WHERE stack = ? AND service = ?`)
    .get(stack, service) as { deploy_label: string | null } | undefined
  return row?.deploy_label ?? null
}

function onClosed(prId: number, number: number): void {
  const db = getDb()
  const now = new Date().toISOString()
  db.transaction(() => {
    db.prepare(`UPDATE prs SET state = 'closed' WHERE id = ?`).run(prId)
    db.prepare(
      `UPDATE updates SET state = 'superseded', detail = 'pr-closed', updated_at = ?
       WHERE id IN (SELECT update_id FROM pr_updates WHERE pr_id = ?)`,
    ).run(now, prId)
  })()
  logEvent({
    level: 'info',
    kind: 'pr',
    message: `#${number} was closed without merging`,
    detail: 'the update will be re-detected on the next scan unless the tag moves on',
  })
}

const COMMAND_MARK = '<!-- shipshape:deploy-command -->'

/**
 * Put the deploy command on the pull request, once.
 *
 * Marker-keyed rather than tracked in the database: the comment is a property of the
 * pull request, and asking GitHub is both cheaper than a migration and correct if the
 * database is ever restored from a backup older than the merge.
 */
async function commentCommand(
  number: number,
  stack: string,
  command: string,
  synced: boolean,
): Promise<void> {
  const [owner, repo] = env.githubRepo.split('/') as [string, string]
  try {
    const { data } = await gh().rest.issues.listComments({
      owner,
      repo,
      issue_number: number,
      per_page: 100,
    })
    if (data.some((c) => (c.body ?? '').includes(COMMAND_MARK))) return

    const dump = dumpHintFor(stack)
    const body = [
      COMMAND_MARK,
      synced
        ? 'Merged, and the checkout is synced. Bring it up with:'
        : 'Merged, but the checkout could not be updated — resolve that first, then:',
      '',
      '```',
      command,
      '```',
      ...(dump
        ? [
            '',
            'This stack carries a dump recipe (`docker-volume-backup.archive-pre`).',
            'Worth running first:',
            '',
            '```',
            dump,
            '```',
          ]
        : []),
    ].join('\n')

    await gh().rest.issues.createComment({ owner, repo, issue_number: number, body })
  } catch (err) {
    // The command is also in the digest and on the dashboard. A comment that could not
    // be written is not worth failing a merge over.
    logEvent({
      level: 'warn',
      kind: 'pr',
      message: `could not comment the deploy command on #${number}`,
      detail: (err as Error).message.slice(0, 200),
    })
  }
}

/**
 * The stack's own backup dump command, if it declared one.
 *
 * Read, never run: these were written for the nightly backup's context and sequencing,
 * and running someone else's label automatically is how the WUD trigger-string era
 * started. Suggesting it to a human about to upgrade a database is the useful half.
 */
function dumpHintFor(stack: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT service, archive_pre FROM images
       WHERE stack = ? AND archive_pre IS NOT NULL AND archive_pre != '' LIMIT 1`,
    )
    .get(stack) as { service: string; archive_pre: string } | undefined
  if (!row) return null
  return `docker exec ${row.service} ${row.archive_pre}`
}

/** True while any shipshape PR is open, which is what decides the poll cadence. */
export function hasOpenPrs(): boolean {
  return (
    (getDb().prepare(`SELECT COUNT(*) c FROM prs WHERE state = 'open'`).get() as { c: number }).c > 0
  )
}

export function pollIntervalMs(): number {
  const { policy } = loadPolicy()
  // Queued deploys count as activity: a merge with nothing else open would otherwise
  // wait out the idle interval before anything brought it up.
  const busy = hasOpenPrs() || hasPendingDeploys() || hasDueRechecks()
  return (busy ? policy.sync.poll_active_s : policy.sync.poll_idle_s) * 1000
}
