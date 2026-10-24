import type Anthropic from '@anthropic-ai/sdk'
import { loadPolicy, type Policy } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { budgetExhausted, isTimeout, recordCost, recordUnanswered } from '../analyze/claude.ts'
import { llmClient, llmConfigured } from '../analyze/client.ts'
import { askJev, jevConfigured } from '../analyze/jev.ts'
import { toolChoiceFor } from '../analyze/tools.ts'
import { prompt } from '../prompts/index.ts'
import type { FeedIncident } from './feed.ts'
import { ECOSYSTEMS, type Target } from './match.ts'
import type { Range } from './versions.ts'

/**
 * From an advisory's prose to package targets.
 *
 * This is the only judgement in the security path, and it is bounded: a model reads the
 * feed's affected/fixed text and says which package names and version ranges it means.
 * Whether a service carries one of them is then read from inventories, without a model
 * (match.ts). A wrong extraction can raise a card about software that is fine, or miss
 * one; it cannot fabricate evidence that an update fixes something, because that evidence
 * is the candidate image's own inventory.
 *
 * Paid once per incident, and again only when the version text changes (`versions_hash`).
 * A cheap screen (Jev) first drops what could never be in a container -- appliances,
 * phones, hosted services -- which is most of the feed.
 */

/** Below this, the screen's "could be in a container" is read as no. */
const RELEVANT_FLOOR = 0.15
/** Extractions per pass: each is one reader call. */
const PER_PASS = 4
/** How long a failed extraction waits before the next try, by attempt. */
const BACKOFF_MS = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000]

const EMIT_TARGETS = {
  name: 'emit_targets',
  description: 'Record the package targets this advisory names.',
  input_schema: {
    type: 'object' as const,
    properties: {
      applicable: {
        type: 'boolean',
        description: 'False when nothing named could be inside a Linux container image.',
      },
      targets: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ecosystem: { type: 'string', enum: [...ECOSYSTEMS] },
            names: { type: 'array', items: { type: 'string' }, minItems: 1 },
            affected: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  gte: { type: 'string' },
                  gt: { type: 'string' },
                  lt: { type: 'string' },
                  lte: { type: 'string' },
                },
                additionalProperties: false,
              },
              minItems: 1,
            },
            fixed: { type: 'array', items: { type: 'string' } },
          },
          required: ['ecosystem', 'names', 'affected', 'fixed'],
          additionalProperties: false,
        },
      },
    },
    required: ['applicable', 'targets'],
  },
}

/** What the model returned, cleaned. Exported for the tests. */
export function normaliseTargets(input: unknown): { applicable: boolean; targets: Target[] } {
  const o = (input ?? {}) as { applicable?: unknown; targets?: unknown }
  const applicable = o.applicable !== false
  const out: Target[] = []
  for (const raw of Array.isArray(o.targets) ? o.targets : []) {
    const t = raw as Partial<Record<keyof Target, unknown>>
    const eco = String(t.ecosystem ?? '')
    if (!(ECOSYSTEMS as readonly string[]).includes(eco)) continue
    const names = (Array.isArray(t.names) ? t.names : [])
      .map((n) => String(n).trim().toLowerCase())
      .filter((n) => n.length > 0 && n.length < 200 && !TRUST_STORE_NAMES.has(n))
    const affected: Range[] = []
    for (const r of Array.isArray(t.affected) ? t.affected : []) {
      const rr = r as Record<string, unknown>
      const range: Range = {}
      for (const k of ['gte', 'gt', 'lt', 'lte'] as const) {
        const v = rr?.[k]
        if (typeof v === 'string' && /^\s*v?\d/.test(v)) range[k] = v.trim()
      }
      // An empty interval would mean "every version": only a bound makes it a claim.
      if (Object.keys(range).length > 0) affected.push(range)
    }
    const fixed = (Array.isArray(t.fixed) ? t.fixed : []).map((f) => String(f)).slice(0, 20)
    if (names.length === 0 || affected.length === 0) continue
    out.push({ ecosystem: eco as Target['ecosystem'], names, affected, fixed })
  }
  return { applicable: applicable && out.length > 0, targets: applicable ? out : [] }
}

function userTurn(i: FeedIncident): string {
  return [
    `Advisory: ${i.title}`,
    i.product ? `Product: ${i.product}` : null,
    `Category: ${i.category}`,
    i.tags?.length ? `Tags: ${i.tags.join(', ')}` : null,
    '',
    'Affected versions:',
    ...(i.affectedVersions ?? []).map((v) => `- ${v}`),
    '',
    'Fixed versions:',
    ...(i.fixedVersions ?? []).map((v) => `- ${v}`),
    '',
    i.summary ? `Summary: ${i.summary}` : null,
  ]
    .filter((l) => l !== null)
    .join('\n')
}

/** The cheap first look. Null when there is no screen, or it could not answer. */
async function screen(i: FeedIncident): Promise<boolean | null> {
  if (!jevConfigured()) return null
  const r = await askJev(
    { advisory: i.title, product: i.product ?? '', affected: i.affectedVersions ?? [], tags: i.tags ?? [] },
    {
      container: {
        type: 'noul',
        instructions:
          'Could any of the affected software plausibly be installed inside a Linux Docker container image on a home server: ' +
          'a server application, a library or package (npm, PyPI, Go, Debian, Alpine), a language runtime, or a browser engine ' +
          'such as Chromium? Network appliances and their firmware, Windows, macOS, iOS and Android, browser extensions and ' +
          'hosted services cannot.',
      },
    },
    { purpose: 'security' },
  )
  if (!r.ok) return null
  const a = r.answers.container
  return a?.type === 'noul' ? a.noul >= RELEVANT_FLOOR : null
}

export type ExtractCall = (system: string, user: string, policy: Policy) => Promise<{ input: unknown } | { error: string }>

/** The reader call. Injected in the tests. */
export const callReader: ExtractCall = async (system, user, policy) => {
  const model = policy.review.model
  const client = llmClient(2)
  const started = Date.now()
  try {
    const res = await client.messages.create(
      {
        model,
        max_tokens: 2048,
        system,
        tools: [EMIT_TARGETS as unknown as Anthropic.Tool],
        tool_choice: toolChoiceFor(model),
        messages: [{ role: 'user', content: user }],
      },
      { timeout: 120_000 },
    )
    const call = res.content.find(
      (b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use' && b.name === 'emit_targets',
    )
    recordCost(res.usage, policy, model, 'security', {
      outcome: call ? 'ok' : 'no-answer',
      latencyMs: Date.now() - started,
      requestId: res.id,
    })
    return call ? { input: call.input } : { error: 'the model did not return targets' }
  } catch (err) {
    if (isTimeout(err)) {
      recordUnanswered(policy, model, 'security', system.length + user.length, { latencyMs: Date.now() - started })
    }
    return { error: (err as Error).message.slice(0, 300) }
  }
}

interface Due {
  slug: string
  raw: string
  versions_hash: string
  relevant: number | null
  extract_attempts: number
  targets: string | null
}

/**
 * Packages that only ever stand for a certificate trust store. A CA incident lists them
 * because they bundle root certificates, and matching them flags nearly every image while
 * meaning nothing actionable about the software itself. Dropped in code, not only in the
 * prompt, because an update that only bumps one must never count as a security fix.
 */
export const TRUST_STORE_NAMES = new Set(['certifi', 'ca-certificates', 'pip', 'uv', 'rustls-webpki', 'webpki-roots', 'webpki'])

/**
 * Whether an empty answer should be doubted rather than stored.
 *
 * An incident's version text gets edited as news arrives, and every edit means another
 * reading. One reading that answers "nothing here could be in a container" must not wipe
 * out the targets an earlier reading found -- that turned Node2Shell into silence on
 * 2026-10-24. Doubted too when the feed itself says which stacks are involved: an
 * incident tagged node or python is about software that runs in containers.
 */
export function doubtEmpty(prior: Target[] | null, stacks: readonly string[] | null | undefined): boolean {
  return (prior !== null && prior.length > 0) || (stacks ?? []).length > 0
}

/** Incidents whose targets are missing or stale, oldest-updated last. */
function due(limit: number): Due[] {
  return getDb()
    .prepare(
      `SELECT slug, raw, versions_hash, relevant, extract_attempts, targets FROM security_incidents
        WHERE status = 'live'
          AND (targets_hash IS NULL OR targets_hash != versions_hash)
          AND (next_extract_at IS NULL OR next_extract_at <= ?)
        ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(new Date().toISOString(), limit) as Due[]
}

export interface ExtractRun {
  extracted: number
  skipped: number
  failed: number
  reason?: 'off' | 'budget' | 'unconfigured'
}

export async function runExtraction(call: ExtractCall = callReader, limit = PER_PASS): Promise<ExtractRun> {
  const out: ExtractRun = { extracted: 0, skipped: 0, failed: 0 }
  const { policy } = loadPolicy()
  if (policy.review.model === 'off') return { ...out, reason: 'off' }
  if (!llmConfigured()) return { ...out, reason: 'unconfigured' }
  const db = getDb()
  const save = db.prepare(
    `UPDATE security_incidents SET relevant = ?, targets = ?, targets_hash = ?, extract_error = NULL,
       extract_attempts = 0, next_extract_at = NULL WHERE slug = ?`,
  )
  const fail = db.prepare(
    `UPDATE security_incidents SET extract_error = ?, extract_attempts = extract_attempts + 1,
       next_extract_at = ? WHERE slug = ?`,
  )

  // Screened-out incidents cost a fraction of a cent and are cheap to clear, so they do
  // not count against the per-pass limit.
  for (const d of due(limit * 10)) {
    const i = JSON.parse(d.raw) as FeedIncident
    // Screened once per version text: a change is what put a screened-out incident back
    // here. One the reader already found applicable is not second-guessed by the screen.
    if (d.relevant !== 1) {
      const verdict = await screen(i)
      if (verdict === false) {
        save.run(0, '[]', d.versions_hash, d.slug)
        out.skipped++
        continue
      }
      // Remembered, so an incident waiting its turn for the reader is not screened again
      // on every pass until it gets one.
      if (verdict === true) db.prepare(`UPDATE security_incidents SET relevant = 1 WHERE slug = ?`).run(d.slug)
    }
    if (out.extracted + out.failed >= limit) continue
    if (budgetExhausted()) return { ...out, reason: 'budget' }

    const r = await call(prompt('security'), userTurn(i), policy)
    if ('error' in r) {
      const wait = BACKOFF_MS[Math.min(d.extract_attempts, BACKOFF_MS.length - 1)]!
      fail.run(r.error, new Date(Date.now() + wait).toISOString(), d.slug)
      out.failed++
      continue
    }
    const { applicable, targets } = normaliseTargets(r.input)
    if (targets.length === 0) {
      const prior = d.targets ? (JSON.parse(d.targets) as Target[]) : null
      if (doubtEmpty(prior, i.stacks)) {
        if (prior && prior.length > 0) {
          // Keep what the earlier reading found, mark it current, and say so.
          db.prepare(
            `UPDATE security_incidents SET targets_hash = ?, extract_error = ?, extract_attempts = 0, next_extract_at = NULL WHERE slug = ?`,
          ).run(d.versions_hash, 'a re-read found nothing; kept the earlier targets', d.slug)
          logEvent({ level: 'warn', kind: 'analysis', message: 'security: a re-read found nothing; kept the earlier targets', detail: d.slug })
          out.extracted++
          continue
        }
        // Tagged with a stack, but nothing found: read again later, a bounded number of times.
        if (d.extract_attempts < 2) {
          const wait = BACKOFF_MS[Math.min(d.extract_attempts, BACKOFF_MS.length - 1)]!
          fail.run('the reader found nothing for an incident tagged with a stack', new Date(Date.now() + wait).toISOString(), d.slug)
          out.failed++
          continue
        }
      }
    }
    save.run(applicable ? 1 : 0, JSON.stringify(targets), d.versions_hash, d.slug)
    out.extracted++
  }
  if (out.failed > 0) {
    logEvent({ level: 'warn', kind: 'analysis', message: 'security: some incidents could not be read', detail: `${out.failed} will be retried` })
  }
  return out
}

/** The stored targets of every incident that has any. */
export function incidentTargets(): Map<string, Target[]> {
  const rows = getDb()
    .prepare(`SELECT slug, targets FROM security_incidents WHERE targets IS NOT NULL AND targets != '[]'`)
    .all() as { slug: string; targets: string }[]
  return new Map(rows.map((r) => [r.slug, JSON.parse(r.targets) as Target[]]))
}
