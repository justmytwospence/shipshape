import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

/**
 * Process-level constants come from the environment; everything the operator tunes
 * lives in the tracked policy.yaml inside the repository being watched. Per-service
 * data and exceptions live as `shipshape.*` labels on the services themselves -- read
 * from the compose files, never from running containers.
 *
 * Nothing here carries a default that assumes a particular deployment. The two values
 * that cannot be guessed -- which repository to watch, and where it lives on disk --
 * are required, and their absence produces setup instructions rather than a crash.
 */

export const env = {
  /** The checkout of the compose repository. Must be mounted at the identical path
   *  inside the container: `docker compose` resolves relative volume paths and derives
   *  the project name client-side, so a different in-container path would hand the
   *  daemon paths that do not exist. */
  repoDir: process.env.REPO_DIR ?? process.env.HOMELAB_REPO ?? '',
  dataDir: process.env.DATA_DIR ?? '/data',
  port: Number(process.env.PORT ?? 8080),
  tz: process.env.TZ ?? 'UTC',

  githubToken: process.env.GITHUB_TOKEN ?? '',
  /** `owner/repo` of the repository that holds the compose files. */
  githubRepo: process.env.GITHUB_REPO ?? '',
  /** Stack directory holding shipshape itself, hard-excluded so it never updates or
   *  deploys over its own running container. */
  selfStack: process.env.SELF_STACK ?? 'shipshape',
  /** Git author for commits shipshape makes, so its work is distinguishable in the log. */
  botEmail: process.env.BOT_EMAIL ?? 'shipshape@localhost',

  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  ntfyUrl: process.env.NTFY_URL ?? '',
  ntfyTopic: process.env.NTFY_TOPIC ?? 'shipshape',
  ntfyToken: process.env.NTFY_TOKEN ?? '',
  /** A full SMTP connection string -- `smtps://user:pass@host:465`. Credentials, so it
   *  lives here rather than in the tracked policy file. */
  smtpUrl: process.env.SMTP_URL ?? '',
  /** Comma-separated recipients. Email is only ever sent when both this and SMTP_URL
   *  are set; there is no partial state where shipshape tries and fails every time. */
  mailTo: process.env.MAIL_TO ?? '',
  /** Envelope sender. Defaults to the identity already used for git commits. */
  mailFrom: process.env.MAIL_FROM ?? process.env.BOT_EMAIL ?? 'shipshape@localhost',
  dockerHubLogin: process.env.DOCKER_HUB_LOGIN ?? '',
  dockerHubPassword: process.env.DOCKER_HUB_PASSWORD ?? '',
} as const

/** Where policy.yaml lives. Defaults inside the watched repo so it is tracked and
 *  reviewable like everything else; POLICY_FILE overrides for any other layout. */
function policyPath(): string {
  const explicit = process.env.POLICY_FILE
  if (explicit) return isAbsolute(explicit) ? explicit : join(env.repoDir, explicit)
  return join(env.repoDir, env.selfStack, 'config', 'policy.yaml')
}

export const paths = {
  db: join(env.dataDir, 'shipshape.db'),
  /** The tool's own clone. All branch/edit/commit/push work happens here so the
   *  checkout -- which routinely carries uncommitted work -- is never disturbed. */
  workRepo: join(env.dataDir, 'repo'),
  lock: join(env.dataDir, 'git.lock'),
  policy: policyPath(),
} as const

/** Git author arguments for tool-authored commits. */
export function botIdentity(): string[] {
  return ['-c', 'user.name=shipshape', '-c', `user.email=${env.botEmail}`]
}

export interface MissingSetting {
  name: string
  why: string
}

/**
 * Whether shipshape has enough configuration to do anything at all.
 *
 * A fresh deployment with nothing set serves setup instructions instead of
 * crash-looping: the scheduler, git operations and analysis all stand down, and every
 * page explains what is missing. Being told what to set beats reading restart logs.
 */
export function configured(): { ok: true } | { ok: false; missing: MissingSetting[] } {
  const missing: MissingSetting[] = []
  if (!env.repoDir) {
    missing.push({
      name: 'REPO_DIR',
      why: 'path to the checkout of your compose repository, mounted at the same path inside the container',
    })
  } else if (!existsSync(env.repoDir)) {
    missing.push({
      name: 'REPO_DIR',
      why: `"${env.repoDir}" does not exist inside the container -- check the bind mount uses the identical host path`,
    })
  }
  if (!env.githubRepo.includes('/')) {
    missing.push({ name: 'GITHUB_REPO', why: 'the repository to open pull requests against, as owner/repo' })
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}

/**
 * One rung of the ladder, as an operator writes it.
 *
 * `gated` is accepted and folded to `manual` because it was, in every decision this
 * codebase makes, exactly `manual` -- see the comment on EffectiveTier. Accepting it
 * here rather than rejecting it means no existing policy.yaml or compose label breaks
 * on the day the duplicate went away.
 */
const Tier = z
  .enum(['auto', 'manual', 'on-request', 'skip', 'gated'])
  .transform((v) => (v === 'gated' ? ('manual' as const) : v))
export type Tier = z.infer<typeof Tier>

/** "HH:MM-HH:MM", may wrap past midnight. */
const Window = z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/)

/** Exported so the defaults themselves can be asserted on; parse through
 *  `validatePolicyText` or `loadPolicy` in application code. */
export const PolicySchema = z.object({
  // Must match what the GitHub repo settings actually allow, or the merge API 405s.
  merge_method: z.enum(['squash', 'merge', 'rebase']).default('squash'),
  sync: z
    .object({
      // Kill-switch. false => the tool never pushes main, which also means it can never
      // open a PR (a branch based on a stale origin/main would silently revert local
      // commits when merged). Degrades to alert-only.
      push_main: z.boolean().default(true),
      blackout: z.array(Window).default([]),
      poll_active_s: z.number().int().positive().default(60),
      poll_idle_s: z.number().int().positive().default(600),
    })
    .prefault({}),
  scan: z
    .object({
      // Cron with seconds field (croner). Default 03:00 -- clear of WUD's 01:00 watch
      // and the blackout window that covers it.
      cron: z.string().default('0 0 3 * * *'),
    })
    .prefault({}),
  defaults: z
    .object({
      patch: Tier.default('auto'),
      minor: Tier.default('auto'),
      // Majors are forced to manual by the policy engine regardless of what is set
      // here; the key exists so the intent is legible in the file.
      major: Tier.default('manual'),
      digest: Tier.default('manual'),
    })
    // Unknown keys are stripped rather than rejected, so a policy.yaml carrying
    // `soak:` -- a knob that was declared here for a while and never read by anything --
    // still loads. It was removed rather than implemented: a setting that silently does
    // nothing is worse than an absent one, because it looks like control.
    .prefault({}),
  claude: z
    .object({
      // advisory: a verdict can demote an auto-merge to hold, never promote. Absence of
      // a verdict degrades to the static policy (fail-open) -- that is today's trusted
      // WUD behaviour, so an API outage must not freeze every update.
      mode: z.enum(['advisory', 'off']).default('advisory'),
      block_on: z.array(z.enum(['block', 'caution'])).default(['block', 'caution']),
      min_confidence: z.enum(['low', 'medium', 'high']).default('medium'),
      model: z.string().default('claude-haiku-4-5-20251001'),
      // Drafting config changes is rare, high-stakes work where being right matters far
      // more than cost -- unlike the verdicts, which run on every pull request.
      code_model: z.string().default('claude-opus-5'),
      // Web reading is what a call actually costs: the ceiling is fetches x
      // content_tokens, dwarfing the prompt itself. Tunable because the right depth
      // depends on how verbose your images' changelogs are.
      web: z
        .object({
          searches: z.number().int().min(1).max(20).default(4),
          fetches: z.number().int().min(1).max(20).default(5),
          content_tokens: z.number().int().min(1000).max(100_000).default(12_000),
        })
        .prefault({}),
      monthly_budget_usd: z.number().positive().default(10),
    })
    .prefault({}),
  prs: z
    .object({
      // coexist: only handle what another updater would never touch on its own
      // (majors, digest pins, anything not on the auto tier), so two tools cannot
      // contend for the same file. `full` takes over everything.
      // `wud-coexist` is accepted as the original spelling of `coexist`.
      scope: z
        .enum(['coexist', 'wud-coexist', 'full'])
        .default('coexist')
        .transform((v) => (v === 'wud-coexist' ? ('coexist' as const) : v)),
      // Ceiling on simultaneously open pull requests. `null` -- the default -- means no
      // ceiling: everything eligible opens at once.
      //
      // It used to default to 5, on the theory that a backlog arriving together is a
      // wall rather than a review queue. The cost of the other direction turned out to
      // be worse: a full queue is silent, and five pull requests nobody got round to
      // merging held fifteen updates shut for six days while the log repeated one
      // `holding 15 update(s)` line. A wall is at least visible. The setting stays for
      // anyone who wants the ceiling back.
      max_open: z.number().int().positive().nullable().default(null),
      // false parks the engine entirely: updates are still detected and shown, but
      // nothing is pushed and no pull request is created.
      enabled: z.boolean().default(true),
      // A pull request whose target has been overtaken is not stale work to finish, it is
      // work that was replaced: its successor rewrites the same `image:` line from the
      // same base, so exactly one of them can ever merge. Left open they accumulate --
      // a rolling digest leaks one per move -- and, until the state filters below, a
      // superseded row could still supply the tier and verdict that justified merging it.
      // A branch someone has pushed to is never closed by this, whatever it says.
      close_superseded: z.boolean().default(true),
    })
    .prefault({}),
  propose: z
    .object({
      // auto   -- draft changes whenever a verdict reports breakage or manual steps
      // manual -- only when asked, per pull request
      // off    -- never
      mode: z.enum(['auto', 'manual', 'off']).default('auto'),
    })
    .prefault({}),
  // Whether a service labelled `shipshape.policy: model` actually gets model-decided
  // treatment. `shadow` records what would have happened and changes nothing, which is
  // how you find out whether it works before it matters.
  model_tier: z
    .object({
      mode: z.enum(['off', 'shadow', 'enforce']).default('shadow'),
    })
    .prefault({}),
  merge: z
    .object({
      // Off by default and off in this deployment: enabling the one path that can
      // change the repository unattended is an operator decision, never a side effect
      // of upgrading.
      auto: z.boolean().default(false),
      // A ceiling so a misconfiguration merges a couple of things and stops.
      max_per_run: z.number().int().min(1).max(50).default(3),
    })
    .prefault({}),
  /**
   * How routine outcomes reach you. Alerts -- a failed deploy, an unhealthy service, a
   * stuck sync -- are NOT covered here and always send immediately, so enabling a digest
   * can never cause a failure to go unnoticed.
   */
  notify: z
    .object({
      // digest    -- collect and send one message per batch
      // immediate -- one push per event, the original behaviour
      // off       -- routine outcomes are logged but never pushed
      routine: z.enum(['digest', 'immediate', 'off']).default('digest'),
      // When the digest goes out. Seconds-field cron, like scan.cron. Defaults to a few
      // hours after the default scan so the night's work is already in it.
      cron: z.string().default('0 0 8 * * *'),
      // What each channel receives. Stated per channel rather than as two lists of
      // channels, because the question an operator actually has is "what does my phone
      // buzz for" -- and the useful split is exactly this one: push for what is broken,
      // email for the summary. A channel that is not configured is skipped whatever is
      // set here, so the default of `all` is safe on a deployment with neither.
      ntfy: z.enum(['all', 'alerts', 'routine', 'off']).default('all'),
      email: z.enum(['all', 'alerts', 'routine', 'off']).default('all'),
    })
    .prefault({}),
  deploy: z
    .object({
      // auto   -- bring merged changes up on the host
      // manual -- sync only; the notification carries the command to paste
      // off    -- do not even sync
      mode: z.enum(['auto', 'manual', 'off']).default('manual'),
      health_window_s: z.number().int().positive().default(120),
    })
    .prefault({}),
  /** Stacks the tool must never touch. Its own stack is appended unconditionally --
   *  WUD's self-update crash-loop is not a mistake worth repeating. */
  exclude_stacks: z.array(z.string()).default([]),
})

export type Policy = z.infer<typeof PolicySchema>

const FALLBACK: Policy = PolicySchema.parse({})

let cached: { policy: Policy; raw: string } | null = null

/** Reads policy.yaml fresh from the repo. A malformed file is never fatal: the tool
 *  keeps running on the last good config (or defaults) and surfaces the error, because
 *  a syntax error should not take the updater offline. */
export function loadPolicy(): { policy: Policy; error?: string } {
  let raw: string
  try {
    raw = readFileSync(paths.policy, 'utf8')
  } catch {
    return { policy: cached?.policy ?? FALLBACK, error: `policy.yaml not found at ${paths.policy}` }
  }
  if (cached?.raw === raw) return { policy: cached.policy }
  try {
    const parsed = PolicySchema.parse(parseYaml(raw) ?? {})
    // The tool's own stack is always excluded, whatever the operator wrote.
    parsed.exclude_stacks = [...new Set([...parsed.exclude_stacks, env.selfStack])]
    cached = { policy: parsed, raw }
    return { policy: parsed }
  } catch (err) {
    return {
      policy: cached?.policy ?? FALLBACK,
      error: `policy.yaml invalid: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/** Check a candidate policy.yaml before it is allowed to replace the real one. */
export function validatePolicyText(raw: string): { ok: true } | { ok: false; error: string } {
  try {
    PolicySchema.parse(parseYaml(raw) ?? {})
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 400) : String(err) }
  }
}

/** True when `now` falls inside any configured blackout window (local time). Windows
 *  may wrap past midnight. */
export function inBlackout(policy: Policy, now = new Date()): boolean {
  const mins = now.getHours() * 60 + now.getMinutes()
  return policy.sync.blackout.some((w) => {
    const [from, to] = w.split('-') as [string, string]
    const [fh, fm] = from.split(':').map(Number) as [number, number]
    const [th, tm] = to.split(':').map(Number) as [number, number]
    const start = fh * 60 + fm
    const end = th * 60 + tm
    return start <= end ? mins >= start && mins < end : mins >= start || mins < end
  })
}

