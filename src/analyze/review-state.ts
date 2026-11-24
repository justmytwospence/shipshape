import type { Policy } from '../policy-schema.ts'
import { llmConfigured } from './client.ts'
import { budgetExhausted } from './claude.ts'
import { reviewMode } from '../policy.ts'

/**
 * Why nothing will read release notes right now, in words; null when a review can be
 * expected. Mirrors `reviewExpected` (src/gitops/policy-inputs.ts) check for check, so the
 * checklist never says "off" while the gate is still waiting for a review.
 */
export function reviewOffReason(policy: Policy): string | null {
  if (!llmConfigured()) return 'no model provider is set'
  if (reviewMode(policy) === 'off') {
    return policy.review.model.trim().toLowerCase() === 'off'
      ? 'review.model is off in the policy file'
      : 'no reader model is set (review.model)'
  }
  if (budgetExhausted()) return "this month's model budget is spent"
  return null
}
