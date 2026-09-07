import Anthropic from '@anthropic-ai/sdk'
import { env, loadPolicy, type Policy } from '../config.ts'
import { recordCost } from '../analyze/claude.ts'
import { webTools } from '../analyze/tools.ts'
import { prompt } from '../prompts/index.ts'
import type { Op } from '../propose/apply.ts'
import { NOTES_SCHEMA, OPS_SCHEMA, normaliseOps, strings } from '../propose/propose.ts'
import { renderContext, type DeployContext } from '../propose/context.ts'

/**
 * Answering a comment.
 *
 * Shares everything structural with the proposal path -- the same operation vocabulary,
 * the same parser, the same deterministic applier, the same boundary -- and differs in
 * one respect that is not structural at all: where the instruction comes from.
 *
 * A proposal is drafted from release notes, which are untrusted, so its containment is
 * that it can only ever *add a reviewable commit*. A revision is drafted from a sentence
 * an authenticated operator typed on their own pull request, which is a genuine
 * instruction and is treated as one. What does not change is that the untrusted material
 * is still in the room: the same call may read a changelog, and the operator may have
 * pasted one. So the instruction is fenced, and only what is inside the fence counts.
 *
 * The vocabulary has no merge and no deploy in it, at any rung. That is deliberate and
 * it is the line: a merge reaches a running container through a real `compose up`, and
 * a model's reading of prose is not a thing that should be able to start one.
 */

export type RevisionAction = 'answer' | 'edit' | 'hold' | 'rerun-review' | 'skip'

export interface Revision {
  action: RevisionAction
  /** Always present. A silent instruction is the one outcome worse than a wrong one. */
  reply: string
  ops: Op[]
  notes: string[]
  sources: string[]
  /** Set when normalisation refused something the model asked for, to append to the reply. */
  degraded?: string
}

const RESPOND = {
  name: 'respond_to_comment',
  description: 'Answer the operator, and do at most one thing about their pull request.',
  input_schema: {
    type: 'object' as const,
    properties: {
      reply: {
        type: 'string',
        description:
          'What to say back, addressed to the person who commented. Always required: the ' +
          'reply is the product. Say what you did and, when it matters, what you ' +
          'deliberately did not do.',
      },
      action: {
        type: 'string',
        enum: ['answer', 'edit', 'hold', 'rerun-review', 'skip'],
        description:
          'answer = reply only. edit = apply the operations in `ops` to the branch. ' +
          'hold = this pull request must not merge on its own until the operator releases it. ' +
          'rerun-review = read the changelog again. skip = the operator typed the literal ' +
          'token /skip and does not want this version. There is no merge and no deploy: ' +
          'nothing you can emit reaches a running container.',
      },
      ops: OPS_SCHEMA,
      notes: NOTES_SCHEMA,
      sources: { type: 'array', items: { type: 'string' }, description: 'URLs relied on.' },
    },
    required: ['reply', 'action'],
  },
}

export interface ReviseInput {
  /** The operator's comment, verbatim. Fenced in the rendered prompt. */
  instruction: string
  author: string
  /** Inline review comments carry a file and a line; conversation comments do not. */
  path?: string | null
  line?: number | null
  diffHunk?: string | null
  /** The conversation so far, oldest first, so a follow-up makes sense. */
  thread: { author: string; ours: boolean; body: string }[]
  stack: string
  service: string
  image: string
  fromTag: string
  toTag: string
  /** The service's block as it stands on the pull request branch. */
  composeBlock: string
  context: DeployContext
  /** What this revision is permitted to change, in the model's own terms. */
  scope: string
  /** Whether operations are even possible at this rung, so the model can say so. */
  mayEdit: boolean
}

export async function revise(input: ReviseInput): Promise<Revision | { error: string }> {
  const { policy } = loadPolicy()
  if (!env.anthropicApiKey) return { error: 'ANTHROPIC_API_KEY is not set' }

  const client = new Anthropic({ apiKey: env.anthropicApiKey, maxRetries: 0 })
  const allowed = ['github.com', 'docs.linuxserver.io', 'api.linuxserver.io']

  try {
    const res = await client.messages.create(
      {
        model: policy.claude.code_model,
        max_tokens: 8192,
        system: [{ type: 'text', text: prompt('revision'), cache_control: { type: 'ephemeral' } }],
        // Web tools are off unless asked for. The operator's comment IS the
        // specification, so searching for it is usually wrong, and fetching is what a
        // call actually costs -- the worst case drops by an order of magnitude without.
        tools: [
          ...(policy.revise.web ? webTools(policy.claude.code_model, policy.claude.web, allowed) : []),
          RESPOND,
        ],
        tool_choice: { type: 'any' },
        messages: [{ role: 'user', content: renderPrompt(input) }],
      },
      // Shorter than the proposal path, and no retries. A reply that takes five minutes
      // is a failed reply, and each retry is separately billed against a ledger that
      // only records calls which return.
      { timeout: 120_000 },
    )

    const call = res.content.find(
      (b): b is Extract<typeof b, { type: 'tool_use' }> =>
        b.type === 'tool_use' && b.name === 'respond_to_comment',
    )
    recordCost(res.usage, policy, policy.claude.code_model, 'revision')
    if (!call) return { error: 'the model did not answer' }

    return normaliseRevision(call.input as Record<string, unknown>, policy, input)
  } catch (err) {
    return { error: (err as Error).message.slice(0, 300) }
  }
}

/**
 * What the model asked for, narrowed to what it is allowed to have.
 *
 * Three rules, and each of them exists because the alternative fails silently:
 *
 * - **No reply is an error, not an empty comment.** The operator asked a question; the
 *   one outcome worse than a wrong answer is none.
 * - **Operations are dropped unless the action is `edit` and the rung permits it.** They
 *   are not applied "just in case the action field was a mistake".
 * - **An unrecognised action narrows to `answer`** -- never `edit`, never `skip`. The
 *   same rule as `scopeFor` and `tierFor`: a typo must never grant reach.
 */
export function normaliseRevision(
  raw: Record<string, unknown>,
  policy: Policy,
  input: Pick<ReviseInput, 'mayEdit' | 'instruction'>,
): Revision | { error: string } {
  const reply = typeof raw.reply === 'string' ? raw.reply.trim() : ''
  if (!reply) return { error: 'the model returned no reply' }

  const claimed = raw.action
  let action: RevisionAction =
    claimed === 'edit' ||
    claimed === 'hold' ||
    claimed === 'rerun-review' ||
    claimed === 'skip' ||
    claimed === 'answer'
      ? claimed
      : 'answer'

  let degraded: string | undefined

  // A skip is a tombstone the scan never offers again, so it is the one action that is
  // not the model's to infer. The operator types the token or it does not happen.
  if (action === 'skip' && !hasSkipToken(input.instruction)) {
    action = 'answer'
    degraded =
      'I read that as asking me to skip this update. Skipping leaves a tombstone the ' +
      'scan will not offer again, so it needs the literal token `/skip` in your comment ' +
      'rather than my reading of a sentence.'
  }

  if (action === 'edit' && (!input.mayEdit || policy.revise.mode !== 'act')) {
    action = 'answer'
    degraded =
      policy.revise.mode !== 'act'
        ? 'I have not written anything to the branch: `revise.mode` is `reply`, so I can ' +
          'answer but not commit. Set it to `act` in Settings if you want me to make ' +
          'changes like this one.'
        : 'I have not written anything to the branch: this service is configured so that ' +
          'I may not change it.'
  }

  return {
    action,
    reply,
    ops: action === 'edit' ? normaliseOps(raw.ops) : [],
    notes: strings(raw.notes),
    sources: strings(raw.sources),
    ...(degraded ? { degraded } : {}),
  }
}

/**
 * Did the operator actually type `/skip`?
 *
 * Matched as a standalone token so it is not found inside a word or a URL, and not
 * inside a quoted block -- a comment quoting an earlier `/skip` is discussing it, not
 * issuing it.
 */
export function hasSkipToken(body: string): boolean {
  return body
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('>'))
    .some((l) => /(^|\s)\/skip(\s|$)/.test(l))
}

function renderPrompt(i: ReviseInput): string {
  const thread =
    i.thread.length > 0
      ? [
          '',
          'The conversation so far, oldest first:',
          ...i.thread.map((c) => `- ${c.ours ? 'shipshape' : c.author}: ${c.body.slice(0, 600)}`),
        ]
      : []

  return [
    // The instruction goes first and fenced. Everything after it is context, and the
    // system prompt says only what is inside this block is an instruction.
    `<operator-instruction author="${i.author}">`,
    i.instruction,
    '</operator-instruction>',
    '',
    i.path ? `They left this on ${i.path}${i.line ? ` line ${i.line}` : ''}.` : '',
    i.diffHunk ? `\nThe diff they were looking at:\n\`\`\`diff\n${i.diffHunk}\n\`\`\`` : '',
    ...thread,
    '',
    '---',
    '',
    `This pull request updates ${i.stack}/${i.service}.`,
    `Image: ${i.image}`,
    `Updating: ${i.fromTag} -> ${i.toTag}`,
    '',
    'The service as it stands on the branch:',
    '```yaml',
    i.composeBlock,
    '```',
    '',
    renderContext(i.context),
    '',
    i.mayEdit ? i.scope : 'You may not change any file on this pull request. Answer, and describe anything that would need doing as notes.',
    '',
    'Call respond_to_comment once.',
  ]
    .filter((l) => l !== '')
    .join('\n')
}
