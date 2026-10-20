import Anthropic from '@anthropic-ai/sdk'
import { env } from '../config.ts'

/**
 * One place that decides who serves the model, and under what credential.
 *
 * Three call sites used to write `new Anthropic({ apiKey: env.anthropicApiKey })` each
 * for themselves -- the verdict, the proposal and the revision -- and a fourth read the
 * key directly to list models. Moving the endpoint meant finding all four, which is the
 * shape of bug this repository has had before with upstream links. There is one accessor
 * now, and `test/llm-client.test.ts` fails on a new `new Anthropic(` outside this file.
 *
 * OpenRouter speaks the Anthropic Messages API natively at `/v1/messages` -- not an
 * OpenAI-shaped translation -- so the SDK, the tool definitions, the forced `tool_choice`
 * and the server-side `web_search` / `web_fetch` tools all carry over unchanged. What
 * differs is the credential: OpenRouter authenticates with `Authorization: Bearer`,
 * where Anthropic uses `x-api-key`.
 */

/** OpenRouter's Anthropic-compatible base. The SDK appends `/v1/messages`. */
const OPENROUTER_BASE = 'https://openrouter.ai/api'

/** Whether a model can be called at all. Every entry point checks this before spending. */
export function llmConfigured(): boolean {
  return Boolean(env.openrouterApiKey || env.anthropicApiKey)
}

/** Which env var an operator is missing, named exactly, for the error they will read. */
export function missingKeyMessage(): string {
  return 'neither ANTHROPIC_API_KEY nor OPENROUTER_API_KEY is set'
}

/** Who is serving the model right now, for the status page and the activity log. */
/**
 * Anthropic wins when both keys are set (since 2026-10-20): the Messages calls run on the
 * Max plan's monthly API credits, which only pay for Anthropic's own API, while the
 * OpenRouter key stays for Jev's Decisions API alone (`decisionsKey`). Each key still
 * goes only to its own vendor.
 */
export function llmProvider(): 'openrouter' | 'anthropic' | 'none' {
  if (env.anthropicApiKey) return 'anthropic'
  if (env.openrouterApiKey) return 'openrouter'
  return 'none'
}

export function llmClient(maxRetries: number): Anthropic {
  if (llmProvider() === 'openrouter') {
    return new Anthropic({
      baseURL: env.llmBaseUrl || OPENROUTER_BASE,
      // Explicitly null, and load-bearing. The SDK defaults `apiKey` from
      // ANTHROPIC_API_KEY when the caller omits it, and builds BOTH auth headers when
      // both are present -- so omitting this would send the operator's Anthropic key to
      // OpenRouter on every call. A credential for one vendor must never travel to
      // another.
      apiKey: null,
      authToken: env.openrouterApiKey,
      maxRetries,
    })
  }
  // authToken null for the same reason in reverse: never send a bearer from the
  // environment (ANTHROPIC_AUTH_TOKEN) alongside the key.
  return new Anthropic({ apiKey: env.anthropicApiKey, authToken: null, maxRetries })
}

/**
 * The model id with any routing prefix removed: `anthropic/claude-opus-5` -> `claude-opus-5`.
 *
 * OpenRouter namespaces every model by vendor. Two pieces of logic match on the family
 * by prefix -- which web-tool revision a model supports, and what a token costs -- and
 * both fail open in the expensive direction if the vendor segment is left on: the tool
 * revision silently drops to the older one, and an unrecognised model bills at the
 * highest rate in the table. Neither failure announces itself, so strip it once, here.
 */
export function baseModel(model: string): string {
  const slash = model.lastIndexOf('/')
  return slash === -1 ? model : model.slice(slash + 1)
}

/**
 * The credential for OpenRouter's Decisions API (Jev), or null.
 *
 * Only the OpenRouter key, whoever serves the Messages calls. There is no Anthropic
 * fallback here -- the Decisions API is OpenRouter's, and an Anthropic key must never be
 * sent to it.
 */
export function decisionsKey(): string | null {
  return env.openrouterApiKey || null
}

/** Where to list the models this credential may actually use. */
export function modelsEndpoint(): { url: string; headers: Record<string, string> } | null {
  if (llmProvider() === 'openrouter') {
    return {
      url: `${env.llmBaseUrl || OPENROUTER_BASE}/v1/models`,
      headers: { authorization: `Bearer ${env.openrouterApiKey}` },
    }
  }
  if (env.anthropicApiKey) {
    return {
      url: 'https://api.anthropic.com/v1/models?limit=50',
      headers: { 'x-api-key': env.anthropicApiKey, 'anthropic-version': '2023-06-01' },
    }
  }
  return null
}
