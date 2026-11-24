import type { Hono } from 'hono'
import { loadPolicy, policyFileState } from '../../config.ts'
import type { Policy } from '../../policy-schema.ts'
import { env, gitBranch, gitCredentialName } from '../../env.ts'
import { getDb } from '../../db/index.ts'
import { revision, version } from '../../version.ts'
import { scanInfo } from '../../scan/index.ts'
import { sourceCounts } from '../../resolver/index.ts'
import { scheduleInfo } from '../../scheduler.ts'
import { StatusPage } from '../views/pages.tsx'
import type { StatusData } from '../views/ui/status.tsx'
import { authHealth } from '../../health/github-auth.ts'
import { budgetHealth } from '../../health/analysis-budget.ts'
import { llmEndpointHost, llmProvider } from '../../analyze/client.ts'
import { jevConfigured } from '../../analyze/jev.ts'
import { sinkCredentials } from '../../notify/index.ts'
import { configured as emailConfigured } from '../../notify/email.ts'
import { securityPanel } from '../../security/panel.ts'
import { chrome } from '../render.ts'

/** What the machine is doing and what it has spent, for the Status page (`/status`). */
const statusData = (): StatusData => {
  const { policy } = loadPolicy()
  const db = getDb()
  const info = scanInfo()
  const sched = scheduleInfo()
  const month = new Date().toISOString().slice(0, 7)
  const spend = db
    .prepare(
      `SELECT model, purpose, COUNT(*) AS calls, SUM(cost_usd) AS cost
         FROM llm_calls WHERE created_at LIKE ? GROUP BY model, purpose ORDER BY cost DESC`,
    )
    .all(`${month}%`) as { model: string; purpose: string; calls: number; cost: number }[]
  const spent = (
    db.prepare(`SELECT value FROM budgets WHERE key = 'claude.spend_usd' AND window = ?`).get(month) as
      | { value: number }
      | undefined
  )?.value

  return {
    version: version(),
    revision: revision(),
    repoDir: env.repoDir,
    repo: env.githubRepo || env.gitRemote.webUrl || '',
    pushMain: policy.sync.push_main,
    branch: gitBranch(),
    remote:
      env.gitRemote.kind === 'https'
        ? env.gitRemote.host
        : env.gitRemote.kind === 'local'
          ? 'local repository'
          : 'not set',
    composeFiles: scanInfo().composeFiles,
    policyFile: (({ rel, exists }) => ({ rel, exists }))(policyFileState()),
    scan: {
      cron: sched.scan.cron,
      lastAt: info.lastAt,
      nextAt: sched.scan.nextAt,
      durationS: info.durationS,
      // Already parsed by scanInfo, and previously thrown away here -- which is why the
      // only place it reached the page was as the JSON string in the counters dump.
      counts: info.counts,
    },
    credentials: [
      // Presence is not health. Through a six-day outage this row read `set` in green
      // the whole time, because a token that has expired is still very much present.
      {
        name: gitCredentialName(),
        state:
          env.gitRemote.kind === 'local'
            ? 'not in use'
            : !(env.gitRemote.kind === 'https' ? env.gitToken : env.githubToken)
              ? 'missing'
              : authHealth().ok
                ? 'set'
                : 'refused',
      },
      // Same reasoning as the row above: the key is present and valid all month, and
      // buys nothing once the budget is spent. Reading `set` through that is how a
      // fortnight of unreviewed merges looked normal on this page.
      providerCredential(policy),
      screenCredential(policy.review.screen),
      ...sinkCredentials(),
      { name: 'SMTP_URL + MAIL_TO', state: emailConfigured() ? 'set' : 'not in use' },
      { name: 'DOCKER_HUB_LOGIN', state: env.dockerHubLogin ? 'set' : 'not in use' },
    ],
    spend: spend.map((s) => ({ ...s, cost: s.cost ?? 0 })),
    budgetUsd: policy.review.monthly_budget_usd,
    spentUsd: spent ?? 0,
    priced: llmProvider() !== 'custom',
    deploys: db
      .prepare(
        `SELECT COALESCE(finished_at, started_at, created_at) AS at, stack, services, status, trigger
           FROM deploys ORDER BY id DESC LIMIT 12`,
      )
      .all() as StatusData['deploys'],
    budgets: db.prepare(`SELECT key, value, window FROM budgets ORDER BY key`).all() as StatusData['budgets'],
    upstream: sourceCounts(),
    security: securityPanel(),
    sandbox: env.uiDev,
  }
}

/**
 * The screen's row: its mode, and -- when its last attempt failed -- why, in the words
 * the gateway used. A guardrail that excludes the provider reads as a 404 that nothing
 * else on this page would explain.
 */
/** Who serves the reader, by the variable in use. A custom endpoint is named by its host, never its key. */
const providerCredential = (policy: Policy): StatusData['credentials'][number] => {
  switch (llmProvider()) {
    case 'custom':
      return policy.review.model.trim()
        ? { name: 'LLM_BASE_URL', state: 'set', note: `${llmEndpointHost()}, unpriced` }
        : {
            name: 'LLM_BASE_URL',
            state: 'missing',
            note: 'set review.model in the policy file: a custom endpoint has no default model, so nothing is read',
          }
    case 'anthropic':
      return { name: 'ANTHROPIC_API_KEY', state: budgetHealth().ok ? 'set' : 'budget spent' }
    case 'openrouter':
      return { name: 'OPENROUTER_API_KEY', state: budgetHealth().ok ? 'set' : 'budget spent' }
    default:
      return {
        name: 'ANTHROPIC_API_KEY, OPENROUTER_API_KEY or LLM_BASE_URL',
        state: 'missing',
        note: 'no changelog is read; updates ship on the evidence that is left',
      }
  }
}

const screenCredential = (mode: 'off' | 'shadow' | 'on'): StatusData['credentials'][number] => {
  if (mode === 'off') return { name: 'Screen', state: 'off' }
  if (!jevConfigured()) return { name: 'Screen', state: 'missing', note: 'needs OPENROUTER_API_KEY' }
  const last = getDb().prepare(`SELECT error FROM screens ORDER BY created_at DESC LIMIT 1`).get() as
    | { error: string | null }
    | undefined
  return last?.error
    ? { name: 'Screen', state: 'refused', note: last.error.slice(0, 200) }
    : { name: 'Screen', state: mode }
}

/** What the machine is doing and what it has spent. */
export function registerStatusRoutes(app: Hono): void {
  app.get('/status', (c) => c.html(StatusPage({ data: statusData(), chrome: chrome(c) }) as string))
}
