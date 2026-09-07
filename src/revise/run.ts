import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { botIdentity, env, loadPolicy } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { budgetExhausted } from '../analyze/claude.ts'
import { scanRepo } from '../compose/scan.ts'
import { routine } from '../notify/digest.ts'
import { postIssueComment, postReviewReply, react } from '../gitops/comments.ts'
import { ensureWorkRepo, git, httpsUrl, withGitLock } from '../gitops/repo.ts'
import { blockFor, checkAndApply, composeAccepts, restore } from '../propose/commit.ts'
import { gatherContext } from '../propose/context.ts'
import { proposalHunks } from '../propose/hunks.ts'
import {
  allowedServices,
  boundaryFor,
  describeBoundary,
  reviseScope,
} from '../propose/paths.ts'
import { runVerb } from '../updates/verbs.ts'
import { revise, type Revision } from './revise.ts'

/**
 * Doing the thing that was asked.
 *
 * One instruction per tick, hardcoded rather than configurable, for the reason
 * `runProposePass` is: this is slow and it costs real money on `code_model`, and a knob
 * that lets it run more would only ever be turned up by someone who had not yet had the
 * bill. The per-pull-request breaker lives in ingestion, where it can refuse before a
 * row is even written.
 *
 * Every exit from here writes a reply. That is not politeness -- a comment that vanishes
 * is indistinguishable from one that was never read, and the operator's only recourse is
 * to comment again, which costs another call. Budget exhausted, branch moved, service
 * locked, model failed: each has a sentence, and the ones that need no model are free.
 */

/** How long a claim is honoured before another pass may take it. */
const CLAIM_STALE_MS = 15 * 60 * 1000

/** Attempts before an instruction is put down rather than retried forever. */
const MAX_ATTEMPTS = 2

export interface InstructionRow {
  id: number
  pr_id: number
  comment_id: string
  kind: 'issue' | 'review'
  author: string
  body: string
  url: string | null
  path: string | null
  line: number | null
  status: string
  attempts: number
  claimed_at: string | null
  number: number
  branch: string
  head_sha_pushed: string
  user_owned: number
}

export interface RunResult {
  handled: number
  skipped: number
  failed: number
}

/**
 * Whether this row is ours to take, given the clock.
 *
 * A claim that could never expire would wedge a pull request forever the first time the
 * process died mid-handle -- the row would read `working`, and `holdReason` would go on
 * refusing the merge with nobody coming back for it.
 */
export function claimable(
  row: Pick<InstructionRow, 'status' | 'attempts' | 'claimed_at'>,
  now: number,
): { take: true } | { take: false; give_up: boolean } {
  if (row.attempts >= MAX_ATTEMPTS) return { take: false, give_up: true }
  if (row.status === 'new') return { take: true }
  if (row.status !== 'working') return { take: false, give_up: false }
  const since = row.claimed_at ? Date.parse(row.claimed_at) : 0
  return now - since > CLAIM_STALE_MS ? { take: true } : { take: false, give_up: false }
}

export async function runInstructionPass(only?: number): Promise<RunResult> {
  const out: RunResult = { handled: 0, skipped: 0, failed: 0 }
  const { policy } = loadPolicy()
  if (policy.revise.mode === 'off') return out
  if (!env.anthropicApiKey || !env.githubToken) return out

  const row = pick(only)
  if (!row) return out

  const verdict = claimable(row, Date.now())
  if (!verdict.take) {
    if (verdict.give_up) {
      await settle(row, 'failed', 'shipshape tried twice and could not answer this. Ask again, or check the activity log.')
      out.failed++
    } else {
      out.skipped++
    }
    return out
  }

  // Claimed BEFORE the model call, and the interlock reads `working` as still holding.
  // A row that only became visible when the work finished would let a merge through in
  // the minutes between.
  getDb()
    .prepare(
      `UPDATE instructions SET status = 'working', attempts = attempts + 1, claimed_at = ?
        WHERE id = ?`,
    )
    .run(new Date().toISOString(), row.id)

  await react(row.kind, numericId(row.comment_id), 'eyes')

  // Free refusals first: no model call, no git, and each of them is a real answer.
  if (budgetExhausted()) {
    await settle(
      row,
      'failed',
      "shipshape has spent its monthly model budget, so it has not read this yet. Raise `claude.monthly_budget_usd` in Settings, or ask again next month — the comment is not lost.",
    )
    out.skipped++
    return out
  }

  try {
    const done = await handle(row, policy.revise.mode)
    if (done) out.handled++
    else out.failed++
  } catch (err) {
    await settle(row, 'failed', `shipshape could not do that: ${(err as Error).message.slice(0, 200)}`)
    logEvent({
      level: 'error',
      kind: 'pr',
      message: `#${row.number}: could not act on a comment`,
      detail: (err as Error).message.slice(0, 200),
    })
    out.failed++
  }
  return out
}

/** The oldest outstanding instruction on a pull request that is still open. */
function pick(only?: number): InstructionRow | null {
  return (getDb()
    .prepare(
      `SELECT i.id, i.pr_id, i.comment_id, i.kind, i.author, i.body, i.url, i.path, i.line,
              i.status, i.attempts, i.claimed_at,
              p.number, p.branch, p.head_sha_pushed, p.user_owned
         FROM instructions i
         JOIN prs p ON p.id = i.pr_id
        WHERE i.status IN ('new', 'working') AND p.state = 'open'
          ${only === undefined ? '' : 'AND p.number = ?'}
        ORDER BY i.id
        LIMIT 1`,
    )
    .get(...(only === undefined ? [] : [only])) ?? null) as InstructionRow | null
}

interface Target {
  updateId: number
  stack: string
  service: string
  image: string
  fromTag: string
  toTag: string
  composeFile: string
}

function targetFor(prId: number): Target | null {
  return (getDb()
    .prepare(
      `SELECT u.id AS updateId, u.stack, u.service, u.image, u.from_tag AS fromTag,
              u.to_tag AS toTag, i.compose_file AS composeFile
         FROM pr_updates pu
         JOIN updates u ON u.id = pu.update_id
         JOIN images i ON i.stack = u.stack AND i.service = u.service
        WHERE pu.pr_id = ? ORDER BY u.id LIMIT 1`,
    )
    .get(prId) ?? null) as Target | null
}

async function handle(row: InstructionRow, mode: 'reply' | 'act'): Promise<boolean> {
  const { policy } = loadPolicy()
  const target = targetFor(row.pr_id)
  if (!target) {
    await settle(row, 'done', 'shipshape no longer has an update recorded for this pull request, so there is nothing it can change here.')
    return true
  }

  const services = scanRepo(env.repoDir, policy.exclude_stacks)
  const svc = services.find((s) => s.stack === target.stack && s.service === target.service)
  // The raw label, not scopeFor's answer: an explicit `service` pin and no label at all
  // are different intentions, and only the second may be widened by the policy floor.
  const scope = reviseScope(svc?.proposeLabel, policy.revise.scope)
  const siblings = services
    .filter((s) => s.stack === target.stack && s.composeFile === target.composeFile)
    .map((s) => s.service)
  const allowed = allowedServices(scope, target.service, siblings)
  // `config`, not `any`: a revision comes from a sentence at a rung that is the default,
  // and has no warrant to rewrite a startup script.
  const boundary = boundaryFor(scope, target.composeFile, 'config')

  const mayEdit = mode === 'act' && scope !== 'none' && row.user_owned !== 1

  // Phase one under the lock: read the branch as it stands, and let go. The model call
  // must not happen in here -- it can run for two minutes, and the git lock is the same
  // one a rollback waits on.
  const gathered = await withGitLock('revise-read', async () => {
    const repoDir = await ensureWorkRepo()
    await git(repoDir, ['fetch', httpsUrl(), row.branch], { remote: true })
    const remoteSha = (await git(repoDir, ['rev-parse', 'FETCH_HEAD'])).stdout
    await git(repoDir, ['checkout', '-B', row.branch, remoteSha])
    const before = readFileSync(join(repoDir, target.composeFile), 'utf8')
    return { remoteSha, before }
  })

  const result = await revise({
    instruction: row.body,
    author: row.author,
    path: row.path,
    line: row.line,
    diffHunk: null,
    thread: thread(row.pr_id, row.id),
    stack: target.stack,
    service: target.service,
    image: target.image,
    fromTag: target.fromTag,
    toTag: target.toTag,
    composeBlock: blockFor(gathered.before, target.service),
    context: await gatherContext(gathered.before, target.service),
    scope: describeBoundary(boundary, target.service, allowed),
    mayEdit,
  })

  if ('error' in result) {
    await settle(row, 'failed', `shipshape could not answer that: ${result.error}`)
    return false
  }

  const extra: string[] = []
  if (result.degraded) extra.push(result.degraded)

  switch (result.action) {
    case 'hold':
      getDb()
        .prepare(`UPDATE prs SET hold_reason = ?, hold_at = ? WHERE id = ?`)
        .run('you asked shipshape to hold this', new Date().toISOString(), row.pr_id)
      extra.push('This pull request will not merge on its own now. Release it from the update page when you want it back.')
      await digest(row, target, 'held')
      break

    case 'rerun-review': {
      const r = await runVerb(target.updateId, 'rerun-review')
      extra.push(r.ok ? r.message : `shipshape could not do that: ${r.message}`)
      break
    }

    case 'skip': {
      const r = await runVerb(target.updateId, 'skip')
      extra.push(r.ok ? r.message : `shipshape could not do that: ${r.message}`)
      if (r.ok) await digest(row, target, 'skipped')
      break
    }

    case 'edit': {
      const applied = await applyToBranch(row, target, boundary, allowed, result, gathered.remoteSha)
      extra.push(applied.note)
      if (applied.ok) await digest(row, target, 'changed')
      break
    }

    case 'answer':
      break
  }

  if (result.notes.length > 0) {
    extra.push(['**You still need to do these by hand**', ...result.notes.map((n) => `- ${n}`)].join('\n'))
  }

  await settle(row, 'done', [result.reply, ...extra].join('\n\n'), result.action)
  logEvent({
    level: 'info',
    kind: 'pr',
    stack: target.stack,
    service: target.service,
    message: `#${row.number}: ${result.action} in reply to ${row.author}`,
    detail: row.body.trim().split('\n')[0]?.slice(0, 160) ?? '',
  })
  return true
}

/**
 * Phase two: re-take the lock, re-check the branch, and write.
 *
 * The head is re-verified rather than assumed because minutes passed while the model was
 * thinking. If somebody pushed in that window the branch is theirs, and the change is
 * described rather than applied.
 */
async function applyToBranch(
  row: InstructionRow,
  target: Target,
  boundary: ReturnType<typeof boundaryFor>,
  allowed: string[],
  result: Revision,
  seenSha: string,
): Promise<{ ok: boolean; note: string }> {
  const { policy } = loadPolicy()
  if (result.ops.length === 0) {
    return { ok: false, note: 'shipshape did not find anything in the configuration that needed changing.' }
  }

  return withGitLock('revise-write', async () => {
    const repoDir = await ensureWorkRepo()
    await git(repoDir, ['fetch', httpsUrl(), row.branch], { remote: true })
    const nowSha = (await git(repoDir, ['rev-parse', 'FETCH_HEAD'])).stdout
    if (nowSha !== seenSha) {
      return {
        ok: false,
        note: 'The branch moved while shipshape was working, so it has not written anything. Say so again and it will start from the branch as it stands now.',
      }
    }
    await git(repoDir, ['checkout', '-B', row.branch, nowSha])

    const applied = checkAndApply({
      repoDir,
      ops: result.ops,
      composeFile: target.composeFile,
      service: target.service,
      boundary,
      allowed,
      selfStack: env.selfStack,
      never: policy.propose.never,
    })
    if (!applied.ok) {
      return { ok: false, note: `shipshape refused to apply that: **${applied.reason}**` }
    }

    const gate = await composeAccepts(repoDir, target.composeFile)
    if (!gate.ok) {
      restore(repoDir, applied.originals)
      return { ok: false, note: `The change did not validate, so nothing was written: **${gate.reason}**` }
    }

    const title = `chore(deps): ${target.stack}/${target.service}: ${firstLine(row.body)}`
    await git(repoDir, [
      ...botIdentity(),
      'commit',
      '-am',
      `${title}\n\nAsked for by ${row.author} in ${row.url ?? `#${row.number}`}.\nWritten by ${policy.claude.code_model}. Review before merging.`,
    ])
    const newSha = (await git(repoDir, ['rev-parse', 'HEAD'])).stdout
    const pushed = await git(repoDir, ['push', httpsUrl(), `HEAD:${row.branch}`], {
      remote: true,
      allowFail: true,
    })
    if (pushed.exitCode !== 0) {
      return { ok: false, note: 'shipshape made the change but could not push it. See the activity log.' }
    }

    const db = getDb()
    db.transaction(() => {
      // Recorded before anything says "pushed": a crash between the push and this write
      // makes the branch read as edited by hand, and nothing puts that back.
      db.prepare(`UPDATE prs SET head_sha_pushed = ?, scope = 'proposed' WHERE id = ?`).run(
        newSha,
        row.pr_id,
      )
      // A proposals row, and not for tidiness: classifyScope only calls a branch
      // 'proposed' when one exists. Without it the next poll relabels this as a human's
      // edit, which is false, and silently downgrades auto-rollback.
      db.prepare(
        `INSERT INTO proposals (pr_id, update_id, ops, notes, summary, sources, changed,
                                model, error, hunks, instruction_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      ).run(
        row.pr_id,
        target.updateId,
        JSON.stringify(result.ops),
        JSON.stringify(result.notes),
        result.reply.slice(0, 2000),
        JSON.stringify(result.sources),
        JSON.stringify(applied.changed),
        policy.claude.code_model,
        JSON.stringify(
          [...applied.results].flatMap(([file, text]) =>
            proposalHunks(applied.originals.get(file) ?? '', text, file),
          ),
        ),
        row.id,
        new Date().toISOString(),
      )
    })()

    return {
      ok: true,
      note: ['**Written to the branch**', ...applied.changed.map((c) => `- ${c}`), '', 'This pull request now carries a change nothing has verified, so it will not merge on its own.'].join('\n'),
    }
  })
}

/** The conversation so far, so a follow-up is not read in isolation. */
function thread(prId: number, exclude: number): { author: string; ours: boolean; body: string }[] {
  return (
    getDb()
      .prepare(
        `SELECT author, body, status FROM instructions
          WHERE pr_id = ? AND id != ? ORDER BY id DESC LIMIT 10`,
      )
      .all(prId, exclude) as { author: string; body: string; status: string }[]
  )
    .reverse()
    .map((r) => ({ author: r.author, ours: r.status === 'ours', body: r.body }))
}

/**
 * Say the answer, and only then call the instruction finished.
 *
 * Order matters: a row marked `done` whose reply never landed is a comment that has
 * silently disappeared, and the interlock stops holding at the same moment. If the reply
 * cannot be posted the row stays claimed and the next pass tries again.
 */
async function settle(
  row: InstructionRow,
  status: 'done' | 'failed',
  body: string,
  action?: string,
): Promise<void> {
  const replyId =
    row.kind === 'review'
      ? await postReviewReply(row.number, numericId(row.comment_id), 'reply', body)
      : await postIssueComment(row.number, 'reply', body)

  if (replyId === null) {
    logEvent({
      level: 'warn',
      kind: 'pr',
      message: `#${row.number}: could not reply, leaving the comment for the next pass`,
    })
    return
  }

  const db = getDb()
  db.transaction(() => {
    db.prepare(
      `UPDATE instructions SET status = ?, action = ?, reply = ?, reply_id = ?, handled_at = ?
        WHERE id = ?`,
    ).run(status, action ?? null, body, String(replyId), new Date().toISOString(), row.id)
    // shipshape's own reply goes in the ledger by id, so it is recognised on the way back
    // in without depending on the marker surviving a quote.
    db.prepare(
      `INSERT OR IGNORE INTO instructions
         (pr_id, comment_id, kind, author, body, commented_at, status, created_at)
       VALUES (?, ?, ?, 'shipshape', ?, ?, 'ours', ?)`,
    ).run(
      row.pr_id,
      `${row.kind}:${replyId}`,
      row.kind,
      body.slice(0, 4000),
      new Date().toISOString(),
      new Date().toISOString(),
    )
  })()

  await react(row.kind, numericId(row.comment_id), status === 'done' ? 'rocket' : 'confused')
}

async function digest(
  row: InstructionRow,
  target: Target,
  what: 'changed' | 'held' | 'skipped',
): Promise<void> {
  await routine({
    category: 'revised',
    stack: target.stack,
    service: target.service,
    summary: `#${row.number} — ${what} because you asked`,
    detail: `${target.stack}/${target.service}\n\n${firstLine(row.body)}`,
    url: row.url ?? `https://github.com/${env.githubRepo}/pull/${row.number}`,
  })
}

function firstLine(body: string): string {
  return body.trim().split('\n')[0]?.slice(0, 72) ?? 'a change you asked for'
}

/** `issue:123` -> 123. */
function numericId(commentId: string): number {
  return Number(commentId.split(':')[1] ?? 0)
}
