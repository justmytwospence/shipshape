import type Anthropic from '@anthropic-ai/sdk'

/**
 * The web tools each model is actually allowed to use, and how much they may read.
 *
 * Two things drive this file:
 *
 * 1. **Tool revisions are model-gated.** The 2026 revisions add dynamic filtering --
 *    the model writes code that filters search results *before* they enter the context
 *    window -- but they only exist on Opus 4.6+ and Sonnet 4.6+. Sending them to Haiku
 *    is an error, so the revision is chosen per model rather than pinned.
 *
 * 2. **Fetched content is the dominant cost.** Every fetch can pull its full content
 *    budget into the prompt, so the real ceiling on a call is `max_uses x
 *    max_content_tokens`, not anything about the prompt itself. These caps are the
 *    main lever on what a call costs.
 */

/** Models that support the 2026 revisions (dynamic filtering). */
const MODERN = [
  'claude-fable-',
  'claude-mythos-',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
]

export function supportsDynamicFiltering(model: string): boolean {
  return MODERN.some((m) => model.startsWith(m))
}

export interface WebToolBudget {
  /** How many searches the model may run. */
  searches: number
  /** How many pages it may read. */
  fetches: number
  /** Ceiling on each page's content. The per-call worst case is fetches x this.
   *  Named as it is spelled in policy.yaml -- the settings page addresses fields by
   *  their YAML path, so renaming it here silently breaks the editor. */
  content_tokens: number
}

export function webTools(
  model: string,
  budget: WebToolBudget,
  allowedDomains: string[],
): Anthropic.ToolUnion[] {
  // The SDK also exposes later revisions than these. They are deliberately not used:
  // this pair is the newest whose behaviour is documented, and an undocumented
  // revision is a guess about what the model will do with untrusted web content.
  const search: Anthropic.ToolUnion = supportsDynamicFiltering(model)
    ? {
        type: 'web_search_20260209',
        name: 'web_search',
        max_uses: budget.searches,
        allowed_domains: allowedDomains,
      }
    : {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: budget.searches,
        allowed_domains: allowedDomains,
      }
  // The same allowlist as the search tool. It was missing here, which meant search was
  // confined to the upstream's own documentation while fetch could read any URL on the
  // internet -- including one named by the untrusted release notes the model is reading,
  // while it holds this deployment's configuration in context. A one-sided allowlist is
  // not an allowlist.
  const fetch: Anthropic.ToolUnion = supportsDynamicFiltering(model)
    ? {
        type: 'web_fetch_20260209',
        name: 'web_fetch',
        max_uses: budget.fetches,
        max_content_tokens: budget.content_tokens,
        allowed_domains: allowedDomains,
      }
    : {
        type: 'web_fetch_20250910',
        name: 'web_fetch',
        max_uses: budget.fetches,
        max_content_tokens: budget.content_tokens,
        allowed_domains: allowedDomains,
      }
  return [search, fetch]
}

/**
 * The worst-case tokens a call can pull in through its web tools.
 *
 * Reported on the settings page so the budget is a number the operator can see and
 * change, rather than a surprise on the invoice.
 */
export function worstCaseFetchTokens(budget: WebToolBudget): number {
  return budget.fetches * budget.content_tokens
}
