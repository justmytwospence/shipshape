import Anthropic from '@anthropic-ai/sdk'
import { env, loadPolicy, type Policy } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { prompt } from '../prompts/index.ts'
import { costOf, reportUnknownModels } from './pricing.ts'
import { webTools } from './tools.ts'
import { assembleNotes, evidenceOf, notesInRange, type NotesBundle, type NotesEvidence } from '../notes/assemble.ts'
import { sourceFor } from '../resolver/index.ts'
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
        description:
          'Specific changes, read in the release notes, that break this deployment without action. ' +
          'Required for block. Missing or unmatched release notes are not a breaking change -- say that in the summary.',
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
          'approve = safe to apply without review. caution = a human should read this first, ' +
          'including when the notes for this version could not be found. ' +
          'block = a specific breaking change or required migration, named in breaking_changes.',
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


export interface AnalyzeTarget {
  image: string
  fromTag: string
  toTag: string
  /** The service asking, so its own `shipshape.source` label is the one that applies. */
  stack?: string
  service?: string
  /** When shipshape first saw the proposed tag in the registry. */
  observedAt?: string
  /** The service's compose block, so config-relevant changes can be flagged concretely. */
  composeSnippet?: string
}

/** A verdict, with what it was based on. */
export type ReviewedVerdict = Verdict & { evidence?: NotesEvidence }

export async function analyze(target: AnalyzeTarget): Promise<ReviewedVerdict | { error: string }> {
  const { policy } = loadPolicy()
  if (policy.claude.mode === 'off') return { error: 'analysis disabled' }
  if (!env.anthropicApiKey) return { error: 'ANTHROPIC_API_KEY is not set' }

  const ref = parseImageRef(target.image)
  // With the service, so a `shipshape.source` label counts here too. It did not: the review
  // resolved without it, and a labelled service's changelog was read as if its upstream were
  // unknown.
  const source = await sourceFor(
    { registry: ref.registry, repository: ref.repository },
    {
      service: target.stack && target.service ? { stack: target.stack, service: target.service } : undefined,
      tag: ref.tag ?? target.fromTag,
    },
  )
  const notes = await assembleNotes({
    image: target.image,
    fromTag: target.fromTag,
    toTag: target.toTag,
    source: source,
    observedAt: target.observedAt,
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
        messages: [{ role: 'user', content: renderPrompt(target, notes) }],
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
    const verdict = normalise(call.input as Partial<Verdict>, { notesInRange: notesInRange(notes) })
    recordCost(res.usage, policy, policy.claude.model, 'verdict')
    return { ...verdict, evidence: evidenceOf(notes) }
  } catch (err) {
    return { error: (err as Error).message.slice(0, 300) }
  }
}

/**
 * The user turn: what is being updated, what shipshape already knows, what it fetched.
 *
 * The first two lines state as fact what the model otherwise had to take on trust, and
 * did not. Given only a version string and a release list that ended a few builds
 * earlier, it concluded -- three times for minuspod, and for jackett and code-server on
 * 2026-09-11 -- that the proposed version "does not exist", that pulling it would fail,
 * and so that it would break. Every one of those tags was in the registry; shipshape had
 * read it there. Exported for the tests.
 */
export function renderPrompt(t: AnalyzeTarget, b: NotesBundle): string {
  const s = b.source
  const how = s.detail ?? s.tier
  const certainty =
    s.tier === 'label' ? 'set by the operator' : s.confidence === 'high' ? 'certain' : 'a likely match, not confirmed'
  const parts: string[] = [
    `Image: ${t.image}`,
    `Current version: ${t.fromTag} (running now)`,
    `Proposed version: ${t.toTag} (published in the registry${t.observedAt ? `, first seen ${t.observedAt}` : ''})`,
    `Both tags were read from the registry and exist. If the notes below do not reach the proposed version, the notes are incomplete -- not the image.`,
    s.repo
      ? `Upstream repository: https://github.com/${s.repo} (identified from ${how}; ${certainty})`
      : 'Upstream repository: unknown',
    `Version range: after ${b.range.from}, up to and including ${b.range.to}${b.range.approximate ? ` -- approximate: ${b.range.basis}` : ''}`,
  ]

  // What was looked for and what came back, so a gap reads as a gap and not as "nothing changed".
  if (b.fetches.length > 0) {
    parts.push(`\nWhat shipshape fetched:\n${b.fetches.map((f) => `- ${f.what}: ${f.outcome}${f.detail ? ` (${f.detail})` : ''}`).join('\n')}`)
  }
  if (b.omitted.length > 0) parts.push(`Releases in the range left out for length: ${b.omitted.join(', ')}`)
  if (b.changelog && b.changelog.omitted.length > 0) {
    parts.push(`Changelog sections in the range left out for length: ${b.changelog.omitted.join(', ')}`)
  }
  if (b.external && b.external.omitted.length > 0) {
    parts.push(`Linked sections in the range left out for length: ${b.external.omitted.join(', ')}`)
  }
  if (b.unplaced.length > 0) {
    parts.push(`Recent releases whose names could not be placed against these versions: ${b.unplaced.join(', ')}`)
  }

  if (t.composeSnippet) {
    parts.push(
      `\nHow this service is configured here (flag anything the update affects):\n\`\`\`yaml\n${t.composeSnippet}\n\`\`\``,
    )
  }

  if (b.releases.length > 0) {
    const list = b.releases.map(
      (r) =>
        `## ${r.tag}${r.name && r.name !== r.tag ? ` — ${r.name}` : ''} (${r.published ?? 'undated'})${r.prerelease ? ' [prerelease]' : ''}\n${r.body || '(no release body)'}`,
    )
    parts.push(`\nUpstream releases in this range, newest first:\n\n${list.join('\n\n')}`)
  }
  if (b.changelog && b.changelog.sections.length > 0) {
    parts.push(
      `\nFrom ${b.changelog.file}, the sections for this range that no release above already covers:\n\n${b.changelog.sections
        .map((sec) => `## ${sec.heading}\n${sec.body}`)
        .join('\n\n')}`,
    )
  }
  if (b.external && (b.external.sections.length > 0 || b.external.excerpt)) {
    const ex = b.external
    parts.push(
      ex.sections.length > 0
        ? `\nFrom ${ex.link}, which the operator linked as this image's release notes, the sections for this range:\n\n${ex.sections
            .map((sec) => `## ${sec.heading}\n${sec.body}`)
            .join('\n\n')}`
        : `\nFrom ${ex.link}, which the operator linked as this image's release notes. Nothing on it could be placed in this range, so this is its beginning:\n\n${ex.excerpt}`,
    )
  }
  if (b.commits && b.commits.subjects.length > 0) {
    parts.push(
      `\nCommits between ${b.commits.from} and ${b.commits.to}, newest first (${b.commits.subjects.length} of ${b.commits.total}):\n${b.commits.subjects
        .map((c) => `- ${c}`)
        .join('\n')}`,
    )
  }
  if (b.container.length > 0) {
    parts.push(
      `\nContainer packaging changes (separate from the application's own changes):\n${b.container
        .map((c) => `- ${c.date}: ${c.desc}`)
        .join('\n')}`,
    )
  }
  for (const n of b.notes) parts.push(`\nNote: ${n}`)

  if (notesInRange(b) === 0) {
    parts.push(
      `\nNo release notes for this range were retrieved automatically. Search for this project's changelog before judging, and if you cannot find one, say so and grade accordingly.`,
    )
  }

  parts.push(`\nCall emit_verdict once you have judged this update.`)
  return parts.join('\n')
}

/**
 * Coerce whatever the model sent into a verdict shipshape can act on.
 *
 * One rule is enforced here rather than only asked for: a block names what breaks. The
 * prompt says so, and the model still returned `block` with an empty `breaking_changes`
 * and `low` confidence for jackett and code-server -- a verdict that found nothing and
 * held anyway, and which the digest then announced as "breaking changes". A block with
 * nothing listed is read as `caution`.
 *
 * That cannot widen what a hostile changelog achieves. `caution` holds a merge exactly as
 * `block` does -- the gate refuses both -- so this changes what the hold is called and
 * never whether it holds. It only ever moves toward `caution`, never to `approve`.
 *
 * The second rule: an approval at `high` confidence when shipshape found no notes in the
 * range is read as `medium`. The prompt asks for `high` only on notes actually read, and a
 * confident approval is the one that merges unattended; lowering confidence can only hold.
 * Exported for the tests.
 */
export function normalise(v: Partial<Verdict>, ctx: { notesInRange?: number } = {}): Verdict {
  const asArray = (x: unknown): string[] =>
    Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []
  const breaking = asArray(v.breaking_changes)
  const claimed: Recommendation =
    v.recommendation === 'approve' || v.recommendation === 'block' ? v.recommendation : 'caution'
  const rec: Recommendation = claimed === 'block' && breaking.length === 0 ? 'caution' : claimed
  const claimedConf: Confidence =
    v.confidence === 'high' || v.confidence === 'medium' ? v.confidence : 'low'
  const conf: Confidence =
    rec === 'approve' && claimedConf === 'high' && ctx.notesInRange === 0 ? 'medium' : claimedConf
  const sev: Severity =
    v.severity === 'none' || v.severity === 'low' || v.severity === 'medium' || v.severity === 'high'
      ? v.severity
      : 'low'
  return {
    summary: typeof v.summary === 'string' ? v.summary : '',
    severity: sev,
    breaking_changes: breaking,
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
