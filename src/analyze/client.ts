import Anthropic from '@anthropic-ai/sdk'
import { env, providerOf, type LlmProvider } from '../env.ts'

/**
 * One place that decides who serves the model, and under what credential.
 *
 * Three call sites used to write `new Anthropic({ apiKey: env.anthropicApiKey })` each
 * for themselves -- the verdict, the proposal and the revision -- and a fourth read the
 * key directly to list models. Moving the endpoint meant finding all four, which is the
 * shape of bug this repository has had before with upstream links. There is one accessor
 * now, and `test/llm-client.test.ts` fails on a new `new Anthropic(` outside this file.
 *
 * Three providers speak the Anthropic Messages API: Anthropic itself, OpenRouter (natively
 * at `/v1/messages`), and any custom endpoint given as LLM_BASE_URL -- Ollama and LiteLLM
 * both serve it. Precedence is custom, then Anthropic, then OpenRouter, and each key goes
 * only to its own vendor: a custom endpoint gets LLM_API_KEY, or the OpenRouter key for an
 * install that pointed LLM_BASE_URL at a gateway before LLM_API_KEY existed.
 */

const OPENROUTER_BASE = 'https://openrouter.ai/api'
const ANTHROPIC_BASE = 'https://api.anthropic.com'

export function llmProvider(): LlmProvider {
  return providerOf(env)
}

/** Whether a model can be called at all. A custom endpoint needs no key. */
export function llmConfigured(): boolean {
  return llmProvider() !== 'none'
}

/** Which env var an operator is missing, named exactly, for the error they will read. */
export function missingKeyMessage(): string {
  return 'no model provider is set: set ANTHROPIC_API_KEY, OPENROUTER_API_KEY or LLM_BASE_URL'
}

/** The custom endpoint's bearer: its own key, else the OpenRouter key. */
function customToken(): string | null {
  return env.llmApiKey || env.openrouterApiKey || null
}

/** For the Status page: which host a custom endpoint is, never its key. */
export function llmEndpointHost(): string | null {
  if (llmProvider() !== 'custom') return null
  try {
    return new URL(env.llmBaseUrl).host
  } catch {
    return env.llmBaseUrl
  }
}

/**
 * A client that sends no credential at all. Passing null for both keys is not enough: the
 * SDK then resolves one from its config files and ANTHROPIC_* environment on the first
 * request, and would hand it to whatever LLM_BASE_URL points at.
 */
class NoCredentialAnthropic extends Anthropic {
  protected override _shouldResolveDefaultCredentials(): boolean {
    return false
  }
}

export function llmClient(maxRetries: number): Anthropic {
  switch (llmProvider()) {
    case 'custom': {
      const token = customToken()
      return token
        ? new Anthropic({ baseURL: env.llmBaseUrl, apiKey: null, authToken: token, maxRetries })
        : new NoCredentialAnthropic({
            baseURL: env.llmBaseUrl,
            apiKey: null,
            authToken: null,
            defaultHeaders: { 'X-Api-Key': null, Authorization: null },
            maxRetries,
          })
    }
    case 'openrouter':
      // apiKey explicitly null, and load-bearing: the SDK defaults it from
      // ANTHROPIC_API_KEY when omitted and would send both auth headers, handing the
      // Anthropic key to OpenRouter.
      return new Anthropic({ baseURL: OPENROUTER_BASE, apiKey: null, authToken: env.openrouterApiKey, maxRetries })
    default:
      // baseURL pinned: the SDK would otherwise read ANTHROPIC_BASE_URL from the environment
      // and send the Anthropic key wherever it points. authToken null so no bearer from
      // ANTHROPIC_AUTH_TOKEN travels alongside the key.
      return new Anthropic({ baseURL: ANTHROPIC_BASE, apiKey: env.anthropicApiKey, authToken: null, maxRetries })
  }
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
  switch (llmProvider()) {
    case 'custom': {
      const token = customToken()
      return { url: `${env.llmBaseUrl.replace(/\/+$/, '')}/v1/models`, headers: token ? { authorization: `Bearer ${token}` } : {} }
    }
    case 'openrouter':
      return { url: `${OPENROUTER_BASE}/v1/models`, headers: { authorization: `Bearer ${env.openrouterApiKey}` } }
    case 'anthropic':
      return { url: `${ANTHROPIC_BASE}/v1/models?limit=50`, headers: { 'x-api-key': env.anthropicApiKey, 'anthropic-version': '2023-06-01' } }
    default:
      return null
  }
}
