import { Cron } from 'croner'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { env, type LlmProvider, providerOf, validBranch } from './env.ts'

export const MODEL_DEFAULTS: Record<LlmProvider, { reader: string; code: string }> = {
  anthropic: { reader: 'claude-sonnet-5-5', code: 'claude-opus-5-5' },
  none: { reader: 'claude-sonnet-5-5', code: 'claude-opus-5-5' },
  openrouter: { reader: 'anthropic/claude-sonnet-5.5', code: 'anthropic/claude-opus-5.5' },
  // A custom endpoint serves whatever its operator loaded; there is no name to guess.
  custom: { reader: '', code: '' },
}

/** The reader: a reading is a summary of release notes, so the mid-sized model does it. */
export const DEFAULT_READER_MODEL = MODEL_DEFAULTS[providerOf(env)].reader

/** Drafting and rule scope, where a wrong edit costs more than the call. */
export const DEFAULT_CODE_MODEL = MODEL_DEFAULTS[providerOf(env)].code

/**
 * The holds an operator may waive with a rule ("always ship"). `lifeline`, `unsafe`,
 * `needs-action` and `draft` are deliberately not here: no rule can remove a real warning,
 * the guard on the way back in, or the read a drafted change is waiting for.
 */
export const WAIVABLE = ['ask', 'no-evidence', 'irreversible', 'no-restore-point'] as const

export type Waivable = (typeof WAIVABLE)[number]

/** One standing "always ship" decision, written by the always-ship verb (src/rules.ts). */
export const RuleSchema = z.object({
  id: z.string().regex(/^r\d+$/),
  match: z
    .object({
      /** An image repository, registry included, without tag or digest. */
      image: z.string().optional(),
      stack: z.string().optional(),
      service: z.string().optional(),
      /** One of our own builds, watched through its base image. */
      base_build: z.literal(true).optional(),
    })
    .refine((m) => Object.values(m).some((v) => v !== undefined), { message: 'a rule must match something' }),
  waive: z.array(z.enum(WAIVABLE)).min(1),
  because: z.string().default(''),
})

export type Rule = z.infer<typeof RuleSchema>

export const EVENT_CLASSES = ['decision', 'broken', 'security', 'system'] as const

export type EventClass = (typeof EVENT_CLASSES)[number]

const Events = z.array(z.enum(EVENT_CLASSES)).optional()

/** Where notifications go. Delivery is a list of sinks; which ones are on is policy. */
export const SinkSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('webhook'),
    url_env: z.string().default('NOTIFY_URL'),
    token_env: z.string().default('NOTIFY_TOKEN'),
    events: Events,
  }),
  z.object({ type: z.literal('email'), events: Events }),
  z.object({
    type: z.literal('ntfy'),
    url: z.string().url(),
    topic: z.string().min(1),
    token_env: z.string().optional(),
    events: Events,
  }),
  z.object({ type: z.literal('discord'), url_env: z.string().default('DISCORD_WEBHOOK_URL'), events: Events }),
  z.object({
    type: z.literal('gotify'),
    url: z.string().url(),
    token_env: z.string().default('GOTIFY_TOKEN'),
    events: Events,
  }),
  z.object({
    type: z.literal('apprise'),
    url: z.string().url(),
    tag: z.string().min(1).optional(),
    auth_env: z.string().optional(),
    events: Events,
  }),
])

export type Sink = z.infer<typeof SinkSchema>

/** Exported so the defaults themselves can be asserted on; parse through
 *  `validatePolicyText` or `loadPolicy` in application code. */
/** A prefix of a git tag name: no leading '-', no '..' or '//'. Empty is allowed. */
const GIT_REF_PREFIX = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]*$/

export const PolicySchema = z.object({
  /**
   * The one switch: while this is on, shipshape ships and deploys nothing on its own.
   *
   * Scanning and changelog reviews carry on -- what stops is every step that would change
   * the host without a person present. A ship *you* press still deploys, because you are
   * there to watch it. A file that never says is paused.
   */
  paused: z.boolean().default(true),
  sync: z
    .object({
      // Kill-switch. false => the tool never pushes main, which also means it can never
      // open a PR (a branch based on a stale origin/main would silently revert local
      // commits when merged). Degrades to alert-only.
      push_main: z.boolean().default(true),
      poll_active_s: z.number().int().positive().default(60),
      poll_idle_s: z.number().int().positive().default(600),
    })
    .prefault({}),
  scan: z
    .object({
      // Cron, seconds first (croner); five fields work too. Default 03:00.
      cron: z
        .string()
        .default('0 0 3 * * *')
        .superRefine((v, ctx) => {
          try {
            new Cron(v, { paused: true }).stop()
          } catch (err) {
            ctx.addIssue({
              code: 'custom',
              message: `scan.cron "${v}" is not a schedule shipshape can run: ${(err as Error).message}`,
            })
          }
        }),
    })
    .prefault({}),
  /**
   * The changelog review: a cheap screen on every update, and a reader where a person
   * will read what it writes.
   *
   * Replaces v1's `claude:` block, which policy.yaml may no longer carry (RETIRED_KEYS).
   */
  review: z
    .object({
      // off    -- no screen
      // shadow -- screen every update, record what it found, act on none of it
      // on     -- the screen decides which updates the reader is paid to read
      // Off unless asked for: a new paid call is something you opt into.
      screen: z.enum(['off', 'shadow', 'on']).default('off'),
      // The reader, or `off` for none. Runs where a person will read the result.
      model: z.string().default(DEFAULT_READER_MODEL),
      // Drafts config changes: rare, high-stakes work.
      code_model: z.string().default(DEFAULT_CODE_MODEL),
      // Hard stop on everything the models cost, together.
      monthly_budget_usd: z.number().positive().default(15),
      // auto -- the reader and the drafter may search and fetch (never on a custom endpoint); off -- they read only what shipshape fetched
      web: z.enum(['auto', 'off']).default('auto'),
    })
    .prefault({}),
  propose: z
    .object({
      // auto -- draft changes whenever the review names steps this deployment must take
      // off  -- only when the verb is pressed
      mode: z.enum(['auto', 'off']).default('auto'),
      // Repo-relative paths no proposal may write, whatever its scope, on top of the
      // ones the code refuses unconditionally (its own stack, .github, bin, scripts,
      // credentials, .env).
      //
      // This exists for configuration that is *hot-reloaded*. Everything shipshape does
      // to make a change safe -- the verify window, the soak, the rollback -- hangs off
      // `compose up` noticing a new image. A file provider that watches its directory,
      // or an auth policy the proxy re-reads, goes live on the next `syncMain()`
      // fast-forward instead: merged, live, and unwatched. There is no version to roll
      // back to and nothing observing whether it worked.
      //
      // Left empty by default because which paths those are is a property of the
      // repository, not of shipshape.
      never: z.array(z.string()).default([]),
    })
    .prefault({}),
  /**
   * Where messages go: a list of sinks (src/notify/sinks). None by default -- nothing is
   * sent until you say where. Silence means healthy: what is announced is a decision
   * waiting on you, something that broke, an exposure, or shipshape's own health.
   */
  notify: z
    .object({
      sinks: z.array(SinkSchema).default([]),
      // A decision still waiting after this long is announced once more, louder.
      escalate_after_days: z.number().int().min(1).max(60).default(7),
    })
    .prefault({}),
  deploy: z
    .object({
      // How long a deploy has to prove itself. Returns the moment every signal is good,
      // so only a bad deploy pays the wait -- which is why this can afford to be long
      // enough for a service that runs migrations on first start.
      verify_window_s: z.number().int().positive().default(300),
      // Where a service already tells traefik which port it serves, that port is probed
      // over HTTP during verification. Opt-out rather than opt-in because the data is
      // declared already: 76 services get a real signal for free, in a lab where barely
      // half the containers carry a healthcheck. Any answer below 500 counts -- a 302 to
      // a login page or a 404 on `/` is still a service that is listening. It can only
      // ever warn, never fail a deploy on its own.
      probe: z.enum(['auto', 'off']).default('auto'),
      // A second look this long after a deploy passes its window, because the failures a
      // window misses are the slow ones -- a leak, a crash on the first real request.
      // Only after this does an update read `verified`. 0 skips it.
      soak_s: z.number().int().min(0).default(1800),
      // What happens when verification fails. `auto` makes exactly one attempt to put
      // the previous version back -- a revert commit on main, deployed and announced --
      // then stops and alerts whatever the result. There is no second try and no setting
      // that adds one. `suggest` sends the same alert with the commands instead of
      // acting. Auto is the default deliberately: it fires only on hard signals, and a
      // machine allowed to break a service unattended must be able to un-break it.
      // Ambiguous evidence always downgrades to suggest whatever this says.
      rollback: z.enum(['auto', 'suggest', 'off']).default('auto'),
    })
    .prefault({}),
  /**
   * Security incidents (pwn.watch) matched against what actually runs here. See
   * src/security/.
   *
   * The feed only ever supplies *which* package versions are bad. Whether a service carries
   * one, and whether an update removes it, is read here from both images' own inventories
   * (syft), so an incident can never make shipshape merge an update that does not
   * demonstrably fix something running on this host.
   */
  security: z
    .object({
      // off    -- nothing is fetched or scanned
      // shadow -- fetch, extract, inventory and match; record what would happen, act on none of it
      // on     -- also post exposure cards and, with auto_merge, let verified fixes merge
      mode: z.enum(['off', 'shadow', 'on']).default('off'),
      // A verified fix may merge past the manual rung, a major or digest move, and a
      // `caution` review. It never passes a hold, a `block` review, a pending review,
      // the attended / on-request / skip rungs, a dormant service, or `paused`.
      auto_merge: z.boolean().default(false),
      // How long a verified fix for a non-critical incident waits instead of the full
      // cooldown. A fix for a critical, KEV-listed or exploited incident does not wait.
      fix_cooldown_days: z.number().min(0).max(90).default(2),
      // The incident index: one file, every category, each incident with its updatedAt.
      feed: z.string().url().default('https://pwn.watch/incidents.json'),
      // Which categories to follow. `breach` has nothing to match an image against.
      categories: z.array(z.enum(['patch', 'supply-chain', 'breach'])).default(['patch', 'supply-chain']),
      // Minutes between feed reads. Inventory work runs on the same clock, more often while
      // there is a backlog.
      interval_m: z
        .number()
        .int()
        .min(5)
        .max(24 * 60)
        .default(15),
      // Image inventories taken per pass, at most. Each one is 20-60 s of syft.
      sbom_per_pass: z.number().int().min(1).max(50).default(6),
      // The scanner, pinned by digest. Run as its own short-lived container so a large
      // image cannot push shipshape itself past its memory limit.
      syft_image: z
        .string()
        .default('anchore/syft:v1.54.1@sha256:3eb5379ba7b409c3f4069b686110527af0c47df993fa5c10d13e7cf34f49b1aa'),
      // Traefik middlewares that keep a router off the internet (an IP allowlist, a VPN-only gate). A router using one is not public.
      private_middlewares: z.array(z.string().min(1)).default([]),
    })
    .prefault({}),
  /** How much happens on its own. */
  ship: z
    .object({
      // Nothing ships on its own until its release is this many days old, so a broken or
      // hijacked release has time to be noticed and pulled before it reaches the host. A
      // ship you press is not held. A verified security fix waits
      // `security.fix_cooldown_days` instead, and one for a critical or exploited incident
      // does not wait at all.
      cooldown_days: z.number().min(0).max(90).default(7),
      // A ceiling so a misconfiguration ships a couple of things and stops.
      max_per_run: z.number().int().min(1).max(50).default(3),
    })
    .prefault({}),
  /**
   * A dump taken before a stateful service is updated (src/restore). The dump command is
   * the service's own `shipshape.snapshot` label; `offsite` optionally asks any MCP tool
   * for an offsite copy too (here: backup-mcp's run_backup). Beside a dump, offsite never
   * blocks a ship. For a stack with no snapshot label but a backup job (`list_tool`), a
   * finished backup (`status_tool`, polled up to `wait_minutes`) is the restore point.
   */
  restore_points: z
    .object({
      keep: z.number().int().min(1).max(20).default(3),
      offsite: z
        .object({
          type: z.literal('mcp'),
          url: z.string().url(),
          tool: z.string().min(1),
          job: z.string().default('{stack}'),
          status_tool: z.string().min(1).default('run_status'),
          list_tool: z.string().min(1).default('list_jobs'),
          wait_minutes: z.number().int().min(1).max(240).default(30),
          poll_seconds: z.number().int().min(1).max(300).default(10),
        })
        .nullable()
        .default(null),
    })
    .prefault({}),
  /** Where a fork's replayed fixes are published (src/forks/rebase.ts). */
  forks: z
    .object({
      // The branch on the fork that is moved to each new replay, with a lease.
      branch: z.string().refine(validBranch, 'a git branch name such as shipshape').default('shipshape'),
      // Every replay is also tagged `<tag_prefix><upstream tag>-<short sha>`, so a rollback can rebuild it.
      tag_prefix: z.string().regex(GIT_REF_PREFIX, 'a git tag prefix such as shipshape/').default('shipshape/'),
    })
    .prefault({}),
  /** Standing "always ship" decisions. Written by shipshape; readable and editable by you. */
  rules: z.array(RuleSchema).default([]),
  /** Stacks the tool must never touch. Its own stack is appended unconditionally --
   *  WUD's self-update crash-loop is not a mistake worth repeating. */
  exclude_stacks: z.array(z.string()).default([]),
})

export type Policy = z.infer<typeof PolicySchema>

/**
 * Keys of the pull-request era (v1). A policy file that still carries any of them is
 * refused as a whole rather than half-read: zod would strip them silently, and a file
 * that says something nothing obeys is worse than one that is refused. `convert-v1`
 * rewrites them.
 */
const RETIRED_KEYS = [
  'merge_method',
  'defaults',
  'merge',
  'prs',
  'revise',
  'claude',
  'model_tier',
  'sync.blackout',
  'deploy.mode',
  'deploy.health_window_s',
  'notify.routine',
  'notify.cron',
  'notify.incidents',
  'notify.email',
] as const

export function retiredKeysMessage(keys: string[]): string {
  return `policy.yaml still uses keys this version no longer reads: ${keys.join(', ')}. Rewrite them with npm run convert-v1 -- --write (in the container: node dist/bin/convert-v1.js --write), or remove them by hand. Until then the last policy that loaded applies, or the defaults (paused) if none did.`
}

export function retiredKeys(raw: string): string[] {
  let doc: unknown
  try {
    doc = parseYaml(raw)
  } catch {
    return []
  }
  if (!doc || typeof doc !== 'object') return []
  return RETIRED_KEYS.filter((k) => {
    let at: unknown = doc
    for (const part of k.split('.')) {
      if (!at || typeof at !== 'object' || !(part in (at as Record<string, unknown>))) return false
      at = (at as Record<string, unknown>)[part]
    }
    return true
  })
}
