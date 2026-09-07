import { Octokit } from 'octokit'
import { env } from '../config.ts'
import { logEvent } from '../db.ts'

/**
 * Everything shipshape says on a pull request, and how it recognises its own voice.
 *
 * There is one hard problem here and it is not obvious. shipshape authenticates with a
 * fine-grained personal access token, so **its comments carry the operator's own GitHub
 * login**. Author identity cannot distinguish the bot from the human. Anything that
 * reads comments as input -- which is the point of the revision path -- has to tell them
 * apart some other way, and the marker below is that way.
 *
 * ## Why the marker must be on the first line
 *
 * The obvious test is `body.includes(MARK)`. It is wrong, and it fails in the direction
 * that matters. GitHub's "Quote reply" copies the quoted comment verbatim behind `> `,
 * and Markdown preserves HTML comments inside a blockquote -- so a genuine reply to
 * shipshape contains shipshape's marker. An `includes` test would classify the
 * operator's instruction as shipshape's own and silently drop it, and quoting the bot is
 * exactly how a person answers a bot.
 *
 * So: the marker is written as the first line and only recognised there. A loop guard
 * that swallows the primary use case is worse than no loop guard, because the loop is
 * bounded by a rate limit and the swallowed instruction is bounded by nothing.
 *
 * The marker is belt; the braces are recording the id of every comment shipshape posts
 * (see the `instructions` ledger). The id is exact, unspoofable and immune to quoting;
 * the marker is what makes a thread readable by eye and by grep.
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

/**
 * The kinds of comment shipshape writes. One per thing it has to say, because the kind
 * is also the idempotency key: "have I already posted the deploy command here?"
 */
export type CommentKind =
  | 'deploy-command'
  | 'superseded'
  | 'retargeted'
  | 'proposal'
  | 'reply'
  | 'held'

const PREFIX = '<!-- shipshape:'

/** The marker for a kind, optionally naming what it is about. Always the first line. */
export function mark(kind: CommentKind, id?: string | number): string {
  return id === undefined ? `${PREFIX}${kind} -->` : `${PREFIX}${kind}:${id} -->`
}

/**
 * Did shipshape write this comment?
 *
 * First line only -- see the note above. A body that merely quotes a marker further down
 * is somebody talking to us, not us.
 */
export function isOurComment(body: string | null | undefined): boolean {
  const first = (body ?? '').split('\n', 1)[0]?.trim() ?? ''
  return first.startsWith(PREFIX) && first.endsWith('-->')
}

/**
 * Has shipshape already left a comment of this kind on this pull request?
 *
 * Paginated, and it stops at the first hit. The unpaginated version asked for one page
 * of 100 oldest-first and concluded "no" for everything after it, so on a thread past
 * 100 comments a marker became invisible and the note it guards was re-posted every
 * poll -- once a minute, forever. Long threads are exactly what a conversational pull
 * request produces.
 */
export async function alreadyCommented(number: number, kind: CommentKind): Promise<boolean> {
  const { owner, repo } = repoParts()
  const marker = `${PREFIX}${kind}`
  try {
    for await (const page of gh().paginate.iterator(gh().rest.issues.listComments, {
      owner,
      repo,
      issue_number: number,
      per_page: 100,
    })) {
      if (page.data.some((c) => firstLine(c.body).startsWith(marker))) return true
    }
    return false
  } catch {
    // Unreadable comments must not cause a double-post, and must not block whatever
    // this was guarding.
    return true
  }
}

function firstLine(body: string | null | undefined): string {
  return (body ?? '').split('\n', 1)[0]?.trim() ?? ''
}

/**
 * Say something on a pull request, and remember having said it.
 *
 * Returns the id GitHub assigned, which is what lets the revision path recognise this
 * comment as its own when it reads the thread back. A null return means the comment did
 * not land -- callers that must not proceed without it need to check.
 */
export async function postIssueComment(
  number: number,
  kind: CommentKind,
  body: string,
): Promise<number | null> {
  const { owner, repo } = repoParts()
  try {
    const { data } = await gh().rest.issues.createComment({
      owner,
      repo,
      issue_number: number,
      body: `${mark(kind)}\n${body}`,
    })
    return data.id
  } catch (err) {
    logEvent({
      level: 'warn',
      kind: 'pr',
      message: `could not comment on #${number}`,
      detail: (err as Error).message.slice(0, 200),
    })
    return null
  }
}

/** Reply inside an inline review thread, rather than starting a new conversation. */
export async function postReviewReply(
  number: number,
  inReplyTo: number,
  kind: CommentKind,
  body: string,
): Promise<number | null> {
  const { owner, repo } = repoParts()
  try {
    const { data } = await gh().rest.pulls.createReplyForReviewComment({
      owner,
      repo,
      pull_number: number,
      comment_id: inReplyTo,
      body: `${mark(kind)}\n${body}`,
    })
    return data.id
  } catch (err) {
    logEvent({
      level: 'warn',
      kind: 'pr',
      message: `could not reply in the review thread on #${number}`,
      detail: (err as Error).message.slice(0, 200),
    })
    return null
  }
}

/**
 * GitHub's reaction set, which is fixed: there is no check mark in it.
 *
 * `eyes` on pickup and `rocket` on done are the closest honest pair, and `confused` is
 * the one that reads as "I could not do that" rather than as disapproval.
 */
export type Reaction = 'eyes' | 'rocket' | 'confused' | '+1' | '-1'

/**
 * Acknowledge a comment without writing one.
 *
 * Best effort by design: a fine-grained token may not carry the reaction permission,
 * and a missing emoji must never be the reason an instruction goes unhandled.
 */
export async function react(
  target: 'issue' | 'review',
  commentId: number,
  content: Reaction,
): Promise<void> {
  const { owner, repo } = repoParts()
  try {
    if (target === 'issue') {
      await gh().rest.reactions.createForIssueComment({ owner, repo, comment_id: commentId, content })
    } else {
      await gh().rest.reactions.createForPullRequestReviewComment({
        owner,
        repo,
        comment_id: commentId,
        content,
      })
    }
  } catch {
    // Deliberately silent. See above.
  }
}
