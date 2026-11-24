import { parseDocument, YAMLMap, YAMLSeq } from 'yaml'
import { llmClient, llmConfigured } from './analyze/client.ts'
import { budgetExhausted, isTimeout, recordCost, recordUnanswered } from './analyze/claude.ts'
import { toolChoiceFor } from './analyze/tools.ts'
import { loadPolicy, RuleSchema, WAIVABLE, type Rule, type Waivable } from './config.ts'
import { getDb } from './db.ts'
import { logEvent } from './events.ts'
import { commitPolicyFile } from './gitops/policy-file.ts'
import { withGitLock } from './gitops/repo.ts'
import { syncMain } from './gitops/sync.ts'
import { prompt } from './prompts/index.ts'
import { decisionMembers, holdsForRow } from './updates/holds.ts'
import { repositoryOf, ruleMatches, shortRepository, type RuleTarget } from './policy.ts'

/**
 * "Always ship": turn one answer into a standing rule.
 *
 * Every card exists because of one specific reason it was held, so a rule waives the
 * reason, not the service. The scope is inferred -- by the code model, with a
 * deterministic fallback when it is unavailable or answers badly -- and the rule is
 * written to `policy.yaml` as an ordinary commit, where it can be read, edited and
 * reverted like anything else. Nothing here can waive a hold that is not waivable.
 */

type RuleDraft = Omit<Rule, 'id'>

const EMIT_RULE = {
  name: 'emit_rule',
  description: 'Record the standing rule.',
  input_schema: {
    type: 'object' as const,
    properties: {
      match: {
        type: 'object',
        properties: {
          image: { type: 'string', description: 'Image repository with registry, no tag.' },
          stack: { type: 'string' },
          service: { type: 'string' },
          base_build: { type: 'boolean' },
        },
      },
      waive: { type: 'array', items: { type: 'string', enum: [...WAIVABLE] } },
      because: { type: 'string', description: 'One short sentence on what the operator accepts.' },
    },
    required: ['match', 'waive', 'because'],
  },
}

export function nextRuleId(rules: readonly { id: string }[]): string {
  const max = rules.reduce((m, r) => Math.max(m, Number(r.id.slice(1)) || 0), 0)
  return `r${max + 1}`
}

/** The rule a card's answer means when no model is available: narrow, and exactly what was waived. */
export function fallbackRule(
  members: { image: string; stack: string; service: string; baseBuild: boolean }[],
  waive: Waivable[],
  to: string,
  today = new Date().toISOString().slice(0, 10),
): RuleDraft {
  const first = members[0]!
  const repo = repositoryOf(first.image)
  const sameImage = members.every((m) => repositoryOf(m.image) === repo)
  const allBase = members.every((m) => m.baseBuild)
  const sameStack = members.every((m) => m.stack === first.stack)
  const match: RuleDraft['match'] =
    members.length > 1 && sameImage
      ? { image: repo }
      : members.length > 1 && sameStack
        ? { stack: first.stack }
        : { stack: first.stack, service: first.service }
  if (allBase) match.base_build = true
  return {
    match,
    waive,
    because: `${today}, ${shortRepository(first.image)} ${to} card: always ship`,
  }
}

/** Everything the rule needs to know, read from the database. */
function context(updateId: number) {
  const members = decisionMembers(updateId)
  if (members.length === 0) throw new Error('that update no longer exists')
  const { policy } = loadPolicy()
  const db = getDb()
  const info = members.map((m) => {
    const img = db
      .prepare(`SELECT base_dockerfile FROM images WHERE stack = ? AND service = ?`)
      .get(m.stack, m.service) as { base_dockerfile: string | null } | undefined
    return { image: m.image, stack: m.stack, service: m.service, baseBuild: !!img?.base_dockerfile, row: m }
  })
  const holds = info.flatMap((i) => holdsForRow(i.row, policy).holds)
  const waivable = [...new Set(holds.filter((h) => h.waivable).map((h) => h.kind as Waivable))]
  const unwaivable = holds.find((h) => !h.waivable)
  const repo = repositoryOf(members[0]!.image)
  const elsewhere = db
    .prepare(`SELECT stack, service FROM images WHERE repository = ? AND registry = ?`)
    .all(repo.split('/').slice(1).join('/'), repo.split('/')[0]!) as { stack: string; service: string }[]
  // Every service shipshape knows, so a model's rule can be checked for what else it reaches.
  const known = (
    db.prepare(`SELECT stack, service, registry, repository, base_dockerfile FROM images`).all() as {
      stack: string
      service: string
      registry: string
      repository: string
      base_dockerfile: string | null
    }[]
  ).map((r): RuleTarget => ({ image: `${r.registry}/${r.repository}`, stack: r.stack, service: r.service, baseBuild: !!r.base_dockerfile }))
  return { members, info, waivable, unwaivable, elsewhere, repo, policy, known }
}

/**
 * The rule for this decision. Throws when there is nothing a rule could waive, which the
 * verb has already ruled out; kept as a guard.
 */
export async function inferRule(updateId: number, today = new Date().toISOString().slice(0, 10)): Promise<Rule> {
  const c = context(updateId)
  if (c.unwaivable) throw new Error(`a hold here cannot be waived: ${c.unwaivable.text}`)
  if (c.waivable.length === 0) throw new Error('nothing is holding this update, so there is nothing to waive')

  const draft = (await askModel(c, today)) ?? fallbackRule(c.info, c.waivable, c.members[0]!.to_tag, today)
  return { id: nextRuleId(c.policy.rules), ...draft }
}

async function askModel(c: ReturnType<typeof context>, today: string): Promise<RuleDraft | null> {
  const { policy } = c
  if (!llmConfigured() || budgetExhausted() || !policy.review.code_model.trim()) return null
  const first = c.members[0]!
  const user = [
    `Decision: ${shortRepository(first.image)} ${first.from_tag} -> ${first.to_tag} (${today})`,
    `Image repository: ${c.repo}`,
    '',
    'Services in this decision:',
    ...c.info.map(
      (i) =>
        `- ${i.stack}/${i.service}: ${shortRepository(i.image)} ${i.row.from_tag} -> ${i.row.to_tag}${i.baseBuild ? ' (our own build, watched through its base image)' : ''}`,
    ),
    '',
    'Other services that run the same image:',
    ...(c.elsewhere.length > 0 ? c.elsewhere.map((e) => `- ${e.stack}/${e.service}`) : ['- none']),
    '',
    `Holds on the card that a rule may waive: ${c.waivable.join(', ')}`,
    '',
    `Existing rules: ${policy.rules.length === 0 ? 'none' : policy.rules.map((r) => `${r.id} ${JSON.stringify(r.match)} waives ${r.waive.join(', ')}`).join('; ')}`,
  ].join('\n')
  const started = Date.now()
  try {
    const res = await llmClient(1).messages.create(
      {
        model: policy.review.code_model,
        max_tokens: 1024,
        system: prompt('rule'),
        tools: [EMIT_RULE],
        tool_choice: toolChoiceFor(policy.review.code_model),
        messages: [{ role: 'user', content: user }],
      },
      { timeout: 60_000 },
    )
    const call = res.content.find((b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use' && b.name === 'emit_rule')
    recordCost(res.usage, policy, policy.review.code_model, 'rule', {
      image: first.image,
      fromTag: first.from_tag,
      toTag: first.to_tag,
      outcome: call ? 'ok' : 'no-answer',
      latencyMs: Date.now() - started,
      requestId: res.id,
    })
    if (!call) return null
    return validateDraft(call.input, c)
  } catch (err) {
    if (isTimeout(err)) {
      recordUnanswered(policy, policy.review.code_model, 'rule', user.length, { latencyMs: Date.now() - started })
    }
    logEvent({ level: 'warn', kind: 'analysis', message: 'could not infer a rule; using the narrow default', detail: (err as Error).message.slice(0, 160) })
    return null
  }
}

/**
 * The model's answer, or null when it is malformed, waives what was not asked, or is too
 * wide: it reaches a service the narrow default rule would not, running a different image.
 * Reaching services that run the same image as the card is the one widening a model is for
 * (identical sidecars across stacks); anything further is not what the card answered.
 */
export function validateDraft(
  raw: unknown,
  c: { info: RuleTarget[]; waivable: Waivable[]; known?: RuleTarget[] },
): RuleDraft | null {
  const parsed = RuleSchema.omit({ id: true }).safeParse(raw)
  if (!parsed.success) return null
  const d = parsed.data
  if (!d.waive.every((w) => c.waivable.includes(w))) return null
  // It must cover every service the card covers, or "always" would leave one asking.
  const probe = { id: 'r0', ...d }
  if (!c.info.every((m) => ruleMatches(probe, m))) return null
  const fallback = { id: 'r0', ...fallbackRule(c.info, d.waive, 'x') }
  const cardRepos = new Set(c.info.map((m) => repositoryOf(m.image)))
  const wider = [...(c.known ?? []), ...c.info].some(
    (t) => ruleMatches(probe, t) && !ruleMatches(fallback, t) && !cardRepos.has(repositoryOf(t.image)),
  )
  return wider ? null : d
}

/** `agentgateway, waiving "no release notes"`: a rule in words, for the verb's answer. */
export function describeRule(rule: Pick<Rule, 'match' | 'waive'>): string {
  const m = rule.match
  const scope = m.image
    ? `every service running ${m.image}`
    : m.stack && m.service
      ? `${m.stack}/${m.service}`
      : m.stack
        ? `everything in ${m.stack}`
        : m.service
          ? `any service named ${m.service}`
          : 'our own builds'
  const tail = m.base_build && m.image ? ' (our own builds only)' : ''
  return `${scope}${tail}, waiving ${rule.waive.join(', ')}`
}

/**
 * Append the rule to the policy file and commit it, keeping the file's comments. Goes through
 * the same locked writer as the settings page: refuse a file with uncommitted edits, validate
 * before writing, and put the bytes back if the commit fails. Throws the reason it refused.
 */
export async function appendRule(rule: Rule): Promise<{ sha: string }> {
  const result = await commitPolicyFile(
    (current) => {
      const doc = parseDocument(current)
      let rules = doc.get('rules') as YAMLSeq | undefined
      if (!(rules instanceof YAMLSeq)) {
        rules = new YAMLSeq()
        doc.set('rules', rules)
      }
      const entry = new YAMLMap()
      entry.flow = true
      entry.set('id', rule.id)
      const match = new YAMLMap()
      match.flow = true
      for (const [k, v] of Object.entries(rule.match)) if (v !== undefined) match.set(k, v)
      entry.set('match', match)
      const waive = new YAMLSeq()
      waive.flow = true
      for (const w of rule.waive) waive.add(w)
      entry.set('waive', waive)
      entry.set('because', rule.because)
      rules.add(entry)
      return { text: doc.toString() }
    },
    `chore(shipshape): rule ${rule.id}: always ship ${describeRule(rule)}`,
  )
  if (!result.ok) {
    if (result.code === 'invalid') throw new Error(`the policy file would not load with this rule: ${result.reason}`)
    if (result.code === 'commit') {
      throw new Error(`could not commit the rule: ${result.reason.replace(/^Could not commit the change: /, '')}`)
    }
    throw new Error(result.reason)
  }
  const sha = result.sha ?? ''
  logEvent({ level: 'info', kind: 'policy', message: `rule ${rule.id} added: always ship`, detail: `${describeRule(rule)} (${sha})` })
  return { sha }
}

/** Publish the rule commit. Separate from `appendRule` so answering the button does not wait on the network. */
export async function publishRule(): Promise<void> {
  const sync = await withGitLock('rule', () => syncMain()).catch((err: unknown) => ({
    status: 'refused' as const,
    reason: (err as Error).message.slice(0, 200),
  }))
  if (sync.status === 'paused' || sync.status === 'refused') {
    logEvent({ level: 'warn', kind: 'policy', message: 'rule committed, but not published yet', detail: sync.reason })
  }
}
