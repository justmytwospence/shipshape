import type Anthropic from '@anthropic-ai/sdk'
import { baseModel } from './client.ts'

/**
 * Per-million-token pricing by model family, for the spend ledger only.
 *
 * Matched by prefix so a new dated release of a known family is priced correctly the
 * day it ships. An unrecognised model bills at the most expensive known rate: a budget
 * that under-counts silently overspends, which is the failure that actually costs
 * money.
 *
 * Verified against the published rates rather than recalled. An earlier version of this
 * table guessed $15/$75 for Opus and over-reported spend by 3x -- a wrong number here
 * is worse than no number, because it is believed.
 */
const PRICING: { prefix: string; in: number; out: number }[] = [
  { prefix: 'claude-fable-', in: 10, out: 50 },
  { prefix: 'claude-mythos-', in: 10, out: 50 },
  // Before the bare `claude-opus-` prefix, which matches it too: 5.5 is not priced like
  // 5. Both spellings, because Anthropic writes `claude-opus-5-5` and OpenRouter
  // `claude-opus-5.5`.
  { prefix: 'claude-opus-5.5', in: 4, out: 20 },
  { prefix: 'claude-opus-5-5', in: 4, out: 20 },
  { prefix: 'claude-opus-', in: 5, out: 25 },
  { prefix: 'claude-sonnet-5.5', in: 2, out: 10 },
  { prefix: 'claude-sonnet-5-5', in: 2, out: 10 },
  { prefix: 'claude-sonnet-', in: 3, out: 15 },
  { prefix: 'claude-haiku-', in: 1, out: 5 },
]
/** Web search is billed per request, independent of tokens. */
const PRICE_SEARCH = 10 / 1000
/** Cache writes cost a premium; reads are the whole point -- about a tenth of input. */
const CACHE_WRITE_MULTIPLIER = 1.25
const CACHE_READ_MULTIPLIER = 0.1

let warnedUnknownModel = ''

/** Set by the caller so this module needs no logger of its own. */
let onUnknownModel: ((model: string) => void) | undefined
export function reportUnknownModels(fn: (model: string) => void): void {
  onUnknownModel = fn
}

function priceFor(model: string): { in: number; out: number } {
  // Match on the family, with any routing prefix stripped: `anthropic/claude-haiku-4.5`
  // prices as a Haiku. Left on, nothing in the table matches and every call bills at the
  // top rate -- silently, and in the direction that stops analysis early.
  const family = baseModel(model)
  const hit = PRICING.find((p) => family.startsWith(p.prefix))
  if (hit) return hit
  if (warnedUnknownModel !== model) {
    warnedUnknownModel = model
    onUnknownModel?.(model)
  }
  return PRICING[0]!
}

/**
 * What a call that never answered probably cost: its prompt, at the input rate.
 *
 * A request that timed out on our side may still have been read and billed on theirs,
 * and recording it as free is the under-count this ledger exists to prevent. Characters
 * over four is the usual rough token count; output is not guessed, since a call that
 * never returned may never have produced any.
 */
export function estimateInputCost(model: string, promptChars: number): number {
  return (promptChars / 4 / 1e6) * priceFor(model).in
}

export interface CallCost {
  cost: number
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  searches: number
}

/**
 * What one call cost, itemised.
 *
 * Cache tokens are billed separately from `input_tokens` and are NOT included in it --
 * ignoring them under-counts every cached call, which is exactly the call you make most
 * often.
 */
export function costOf(usage: Anthropic.Usage, model: string): CallCost {
  const price = priceFor(model)
  // A gateway that reports what it actually charged is a better number than anything
  // this table can compute. OpenRouter returns `usage.cost` in dollars, already covering
  // whichever upstream served the call -- the same model can route via Bedrock at rates
  // that are not Anthropic's list price. The table stays as the fallback, and as the
  // only source when talking to Anthropic directly.
  //
  // Except with a bring-your-own-key route, where `cost` is only OpenRouter's own fee --
  // zero, at the time of writing -- and what the provider charged the operator's key is
  // `cost_details.upstream_inference_cost`. Reading `cost` alone recorded every Opus
  // draft from 2026-09-29 on at $0, and the budget never saw them.
  const u = usage as {
    cost?: number
    is_byok?: boolean
    cost_details?: { upstream_inference_cost?: number | null }
  }
  const upstream = u.cost_details?.upstream_inference_cost
  const reported =
    typeof u.cost === 'number' && u.cost >= 0
      ? u.is_byok
        ? typeof upstream === 'number' && upstream >= 0
          ? u.cost + upstream
          : undefined
        : u.cost
      : undefined
  const searches =
    (usage as { server_tool_use?: { web_search_requests?: number } }).server_tool_use
      ?.web_search_requests ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cost =
    (usage.input_tokens / 1e6) * price.in +
    (cacheWrite / 1e6) * price.in * CACHE_WRITE_MULTIPLIER +
    (cacheRead / 1e6) * price.in * CACHE_READ_MULTIPLIER +
    (usage.output_tokens / 1e6) * price.out +
    searches * PRICE_SEARCH
  return {
    cost: typeof reported === 'number' && reported >= 0 ? reported : cost,
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheWrite,
    cacheRead,
    searches,
  }
}

