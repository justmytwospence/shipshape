import { z } from 'zod'
import { loadPolicy } from '../config.ts'
import { decisionsKey } from './client.ts'
import { recordSpend, type CallMeta, type CallPurpose } from './claude.ts'

/**
 * Jev, through OpenRouter's Decisions API: typed judgments about some state, for a
 * fraction of a cent.
 *
 * Jev answers questions with probabilities -- yes/no (Noul), one-of (Choice), a position
 * on described levels (Score) -- and never writes prose. That shape is the point: code
 * owns the workflow and asks Jev only the part ordinary code cannot answer, like "does
 * this release note tell the operator to change a setting".
 *
 * Through OpenRouter rather than TypeSafe directly, on the key this service already has:
 * every model call shipshape makes sits behind that key's own spending limit, and the
 * compose file deliberately refuses a direct provider credential so nothing can step
 * around it. The endpoint is alpha, so everything about it lives in this one file, and
 * any failure reads as "screen unavailable" -- which falls back to exactly what shipshape
 * did before the screen existed.
 *
 * Only this module may talk to the Decisions endpoint; `test/llm-client.test.ts` fails on
 * another.
 */

const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions'

/** Pinned rather than an alias: the screen's thresholds were tuned against this version. */
export const JEV_MODEL = 'typesafe/jev-1.13'
/** The family every answer must come from before it is believed. */
const JEV_FAMILY = 'jev-1.13'
/** Published input rate, for the estimate when the gateway does not report a cost. */
const JEV_USD_PER_TOKEN = 0.042 / 1e6

const TIMEOUT_MS = 20_000
/** The longest a Retry-After is honoured for: a screen is not worth stalling a tick on. */
const MAX_RETRY_WAIT_MS = 30_000

export type Question =
  | { type: 'noul'; instructions: unknown; criteria?: { true: unknown; false: unknown } }
  | { type: 'score'; instructions: unknown; criteria: unknown[] }
  | { type: 'choice'; instructions: unknown; criteria: Record<string, unknown> }

const NoulAnswer = z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) })
const ScoreAnswer = z.object({
  type: z.literal('score'),
  score: z.number(),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number()).optional(),
  legend: z.record(z.string(), z.string()).optional(),
})
const ChoiceAnswer = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number()).optional(),
})
const Answer = z.discriminatedUnion('type', [NoulAnswer, ScoreAnswer, ChoiceAnswer])
export type Answer = z.infer<typeof Answer>

const Response = z.object({
  id: z.string().optional(),
  model: z.string(),
  answers: z.record(z.string(), Answer),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cost: z.number().optional(),
      is_byok: z.boolean().optional(),
      cost_details: z.object({ upstream_inference_cost: z.number().nullable().optional() }).optional(),
    })
    .optional(),
})

export type Decisions =
  | { ok: true; model: string; answers: Record<string, Answer>; cost: number }
  | { ok: false; error: string; retryable: boolean }

export function jevConfigured(): boolean {
  return decisionsKey() !== null
}

/** The family a resolved id belongs to: `typesafe/jev-1.13-20260917` -> `jev-1.13-20260917`. */
export function jevFamilyOk(resolved: string): boolean {
  const slash = resolved.lastIndexOf('/')
  return (slash === -1 ? resolved : resolved.slice(slash + 1)).startsWith(JEV_FAMILY)
}

/**
 * Ask Jev every question about one state, in one request.
 *
 * Questions run in parallel and cannot see each other's answers, so everything the
 * caller may need is asked at once. One retry on 429 or 529, honouring Retry-After; a
 * 401, 404 or 422 is a fault in the request or the credential and is not retried.
 */
export async function askJev(
  state: unknown,
  questions: Record<string, Question>,
  o: { purpose: CallPurpose; meta?: CallMeta; fetchImpl?: typeof fetch },
): Promise<Decisions> {
  const key = decisionsKey()
  if (!key) return { ok: false, error: 'OPENROUTER_API_KEY is not set', retryable: false }
  const doFetch = o.fetchImpl ?? fetch
  const body = JSON.stringify({ model: JEV_MODEL, state, questions })

  for (let attempt = 1; ; attempt++) {
    const started = Date.now()
    let res: Response
    try {
      res = await doFetch(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (err) {
      return { ok: false, error: `the screen could not be reached: ${(err as Error).message}`, retryable: true }
    }

    if ((res.status === 429 || res.status === 529) && attempt === 1) {
      const after = Number(res.headers.get('retry-after'))
      const waitMs = Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 2_000, MAX_RETRY_WAIT_MS)
      await new Promise((r) => setTimeout(r, waitMs))
      continue
    }
    if (!res.ok) {
      return {
        ok: false,
        error: `the screen answered ${res.status}: ${refusalOf(await res.text().catch(() => ''))}`,
        retryable: res.status === 429 || res.status === 529 || res.status >= 500,
      }
    }

    let parsed: z.infer<typeof Response>
    try {
      parsed = Response.parse(await res.json())
    } catch (err) {
      return { ok: false, error: `the screen's answer did not parse: ${(err as Error).message.slice(0, 160)}`, retryable: false }
    }

    const u = parsed.usage ?? {}
    const input = u.input_tokens ?? Math.round(body.length / 4)
    const upstream = u.cost_details?.upstream_inference_cost
    const reported =
      typeof u.cost === 'number'
        ? u.is_byok
          ? typeof upstream === 'number'
            ? u.cost + upstream
            : undefined
          : u.cost
        : undefined
    const cost = reported ?? input * JEV_USD_PER_TOKEN
    recordSpend(loadPolicy().policy, parsed.model, o.purpose, cost, { input, output: u.output_tokens ?? 0 }, {
      ...o.meta,
      provider: 'openrouter',
      latencyMs: Date.now() - started,
      requestId: parsed.id ?? null,
      estimated: reported === undefined,
    })

    // An answer from a model the thresholds were not tuned on is not believed: the
    // alias could move, or the gateway could route elsewhere, and calibrated
    // probabilities from one model mean nothing against another's thresholds.
    if (!jevFamilyOk(parsed.model)) {
      return { ok: false, error: `the screen answered from ${parsed.model}, not ${JEV_FAMILY}`, retryable: false }
    }
    const missing = Object.keys(questions).filter((k) => !(k in parsed.answers))
    if (missing.length > 0) {
      return { ok: false, error: `the screen left ${missing.length} question(s) unanswered`, retryable: true }
    }
    return { ok: true, model: parsed.model, answers: parsed.answers, cost }
  }
}

/**
 * The gateway's refusal in a sentence. OpenRouter answers with a JSON envelope whose first
 * line is the whole story -- "provider not allowed by guardrail" -- and whose metadata
 * names the page that fixes it; printed raw, the Status page showed a wall of braces.
 */
export function refusalOf(body: string): string {
  try {
    const e = (JSON.parse(body) as {
      error?: { message?: string; metadata?: { ineligibility_reasons?: { reason?: string; configure_url?: string }[] } }
    }).error
    const reason = e?.metadata?.ineligibility_reasons?.[0]
    if (reason?.reason) {
      return `${reason.reason.replace(/-/g, ' ')}${reason.configure_url ? ` -- change it at ${reason.configure_url}` : ''}`
    }
    if (e?.message) return e.message.split('\n')[0]!.slice(0, 200)
  } catch {
    // not JSON: fall through to the text itself
  }
  return body.slice(0, 200) || 'no reason given'
}
