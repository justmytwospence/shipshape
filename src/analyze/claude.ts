import Anthropic from '@anthropic-ai/sdk'
import { env, loadPolicy, type Policy } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { prompt } from '../prompts/index.ts'
import { costOf, reportUnknownModels } from './pricing.ts'
import { webTools } from './tools.ts'
import { assemble } from '../changelog/github.ts'
import { resolveSource } from '../resolver/index.ts'
import { parseImageRef } from '../images/ref.ts'

/**
 * Reading the changelog so a human does not have to.
 *
 * This is the part Renovate structurally cannot do. Renovate finds release notes through
 * the image's OCI source annotation and renders whatever it gets; when the annotation is
 * missing or points at a packaging repo -- about half the images in a typical
 * self-hosted setup -- it
 * shows nothing. Here the model can search for the project, read what it finds, and say
 * what actually changed.
 *
 * SECURITY: release notes are untrusted input. The verdict can only ever *withhold* a
 * merge (see canAutoMerge in policy.ts), so the worst a hostile changelog can achieve is
 * to stop an update -- never to cause one. That asymmetry is the boundary, not the
 * prompt wording.
 */

export type Recommendation = 'approve' | 'caution' | 'block'
export type Severity = 'none' | 'low' | 'medium' | 'high'
export type Confidence = 'low' | 'medium' | 'high'

export interface Verdict {
  summary: string
  severity: Severity
  breaking_changes: string[]
  migration_steps: string[]
  recommendation: Recommendation
  confidence: Confidence
  sources: string[]
}

const EMIT_VERDICT = {
  name: 'emit_verdict',
  description: 'Record the final judgement on this image update.',
  input_schema: {
    type: 'object' as const,
    properties: {
      summary: {
        type: 'string',
        description: 'Two or three sentences on what changed, in plain language.',
      },
      severity: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
      breaking_changes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Concrete breaking changes affecting this deployment. Empty if none.',
      },
      migration_steps: {
        type: 'array',
        items: { type: 'string' },
        description: 'Actions the operator must take beyond bumping the tag. Empty if none.',
      },
      recommendation: {
        type: 'string',
        enum: ['approve', 'caution', 'block'],
        description:
          'approve = safe to apply without review. caution = a human should read this first. block = known breakage or a required migration.',
      },
      confidence: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description: 'How well the evidence actually supports the recommendation.',
      },
      sources: { type: 'array', items: { type: 'string' }, description: 'URLs consulted.' },
    },
    required: [
      'summary',
      'severity',
      'breaking_changes',
      'migration_steps',
      'recommendation',
      'confidence',
      'sources',
    ],
  },
}


interface AnalyzeTarget {
  image: string
  fromTag: string
  toTag: string
  /** The service's compose block, so config-relevant changes can be flagged concretely. */
  composeSnippet?: string
}

export async function analyze(target: AnalyzeTarget): Promise<Verdict | { error: string }> {
  const { policy } = loadPolicy()
  if (policy.claude.mode === 'off') return { error: 'analysis disabled' }
  if (!env.anthropicApiKey) return { error: 'ANTHROPIC_API_KEY is not set' }

  const ref = parseImageRef(target.image)
  const resolved = await resolveSource({
    registry: ref.registry,
    repository: ref.repository,
    tag: ref.tag ?? target.fromTag,
  })
  const bundle = await assemble({
    sourceRepo: resolved.sourceRepo,
    repository: ref.repository,
    fromTag: target.fromTag,
    toTag: target.toTag,
  })

  const allowed = ['github.com', 'docs.linuxserver.io', 'api.linuxserver.io']
  const client = new Anthropic({ apiKey: env.anthropicApiKey, maxRetries: 2 })

  try {
    const res = await client.messages.create(
      {
        model: policy.claude.model,
        max_tokens: 4096,
        // tools + system are identical across every verdict in a scan pass, so the
        // first call writes this prefix and the rest read it at a tenth of the price.
        system: [{ type: 'text', text: prompt('verdict'), cache_control: { type: 'ephemeral' } }],
        tools: [
          // Revision picked per model: the 2026 pair filters search results before they
          // reach the context window, but only exists on the larger models.
          ...webTools(policy.claude.model, policy.claude.web, allowed),
          EMIT_VERDICT,
        ],
        tool_choice: { type: 'any' },
        messages: [{ role: 'user', content: renderPrompt(target, bundle, resolved.sourceRepo) }],
      },
      { timeout: 180_000 },
    )

    const call = res.content.find(
      (b): b is Extract<typeof b, { type: 'tool_use' }> =>
        b.type === 'tool_use' && b.name === 'emit_verdict',
    )
    if (!call) {
      return { error: 'the model did not return a verdict' }
    }
    const verdict = normalise(call.input as Partial<Verdict>)
    recordCost(res.usage, policy, policy.claude.model, 'verdict')
    return verdict
  } catch (err) {
    return { error: (err as Error).message.slice(0, 300) }
  }
}

function renderPrompt(
  t: AnalyzeTarget,
  b: Awaited<ReturnType<typeof assemble>>,
  sourceRepo: string | null,
): string {
  const parts: string[] = [
    `Image: ${t.image}`,
    `Current version: ${t.fromTag}`,
    `Proposed version: ${t.toTag}`,
    sourceRepo ? `Upstream repository: https://github.com/${sourceRepo}` : 'Upstream repository: unknown',
  ]

  if (t.composeSnippet) {
    parts.push(
      `\nHow this service is configured here (flag anything the update affects):\n\`\`\`yaml\n${t.composeSnippet}\n\`\`\``,
    )
  }

  if (b.releases.length > 0) {
    // Raw and unfiltered: matching image tags to release names is the model's job.
    const slice = b.releases.slice(0, 25).map((r) => `## ${r.tag}${r.name && r.name !== r.tag ? ` — ${r.name}` : ''} (${r.published ?? 'undated'})\n${r.body || '(no release body)'}`)
    parts.push(
      `\nUpstream releases, newest first. Identify which of these fall between the current and proposed versions — tag naming is often inconsistent:\n\n${slice.join('\n\n').slice(0, 45_000)}`,
    )
  }
  if (b.commits.length > 0) {
    parts.push(`\nCommits between the two versions:\n${b.commits.map((c) => `- ${c}`).join('\n')}`)
  }
  if (b.containerChangelog.length > 0) {
    parts.push(
      `\nContainer packaging changes (separate from the application's own changes):\n${b.containerChangelog
        .map((c) => `- ${c.date}: ${c.desc}`)
        .join('\n')}`,
    )
  }
  for (const n of b.notes) parts.push(`\nNote: ${n}`)

  if (b.releases.length === 0) {
    parts.push(
      `\nNo release notes were retrieved automatically. Search for this project's changelog before judging, and if you cannot find one, say so and grade accordingly.`,
    )
  }

  parts.push(`\nCall emit_verdict once you have judged this update.`)
  return parts.join('\n')
}

function normalise(v: Partial<Verdict>): Verdict {
  const asArray = (x: unknown): string[] =>
    Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []
  const rec: Recommendation =
    v.recommendation === 'approve' || v.recommendation === 'block' ? v.recommendation : 'caution'
  const conf: Confidence =
    v.confidence === 'high' || v.confidence === 'medium' ? v.confidence : 'low'
  const sev: Severity =
    v.severity === 'none' || v.severity === 'low' || v.severity === 'medium' || v.severity === 'high'
      ? v.severity
      : 'low'
  return {
    summary: typeof v.summary === 'string' ? v.summary : '',
    severity: sev,
    breaking_changes: asArray(v.breaking_changes),
    migration_steps: asArray(v.migration_steps),
    recommendation: rec,
    confidence: conf,
    sources: asArray(v.sources),
  }
}

// Pricing has no logger of its own; wire this module's in.
reportUnknownModels((model) =>
  logEvent({
    level: 'warn',
    kind: 'analysis',
    message: `no pricing known for "${model}"`,
    detail: 'billing it at the highest known rate so the budget cannot under-count',
  }),
)

export function recordCost(
  usage: Anthropic.Usage,
  policy: Policy,
  model: string,
  purpose: 'verdict' | 'proposal' | 'revision' = 'verdict',
): void {
  const c = costOf(usage, model)
  const now = new Date().toISOString()
  const month = now.slice(0, 7)
  const db = getDb()

  // Every call is recorded individually. A single monthly total cannot answer "why is
  // this expensive", and that question is the whole reason to track spend at all.
  db.prepare(
    `INSERT INTO llm_calls (model, purpose, input_tokens, output_tokens,
                            cache_write_tokens, cache_read_tokens, searches, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(model, purpose, c.input, c.output, c.cacheWrite, c.cacheRead, c.searches, c.cost, now)

  db.prepare(
    `INSERT INTO budgets (key, value, window, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = CASE WHEN budgets.window = excluded.window THEN budgets.value + excluded.value
                    ELSE excluded.value END,
       window = excluded.window, updated_at = excluded.updated_at`,
  ).run('claude.spend_usd', c.cost, month, now)

  const spent = monthlySpend()
  if (spent >= policy.claude.monthly_budget_usd) {
    logEvent({
      level: 'warn',
      kind: 'analysis',
      message: 'monthly analysis budget reached',
      detail: `$${spent.toFixed(2)} of $${policy.claude.monthly_budget_usd} — analysis pauses, pull requests continue`,
    })
  }
}

export function monthlySpend(): number {
  const month = new Date().toISOString().slice(0, 7)
  const row = getDb()
    .prepare(`SELECT value, window FROM budgets WHERE key = 'claude.spend_usd'`)
    .get() as { value: number; window: string } | undefined
  return row && row.window === month ? row.value : 0
}

export function budgetExhausted(): boolean {
  const { policy } = loadPolicy()
  return monthlySpend() >= policy.claude.monthly_budget_usd
}
