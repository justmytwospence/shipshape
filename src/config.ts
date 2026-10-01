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
  /** An OpenRouter key routes every model call through OpenRouter's Anthropic-compatible
   *  endpoint instead of Anthropic directly. It wins when both are set, and the two are
   *  never sent together -- see `src/analyze/client.ts`. */
  openrouterApiKey: process.env.OPENROUTER_API_KEY ?? '',
  /** Overrides the gateway base URL. Only needed for a self-hosted Anthropic-compatible
   *  proxy; OpenRouter's own base is the default and needs no setting. */
  llmBaseUrl: process.env.LLM_BASE_URL ?? '',
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
  .enum(['auto', 'manual', 'attended', 'on-request', 'skip', 'gated'])
  .transform((v) => (v === 'gated' ? ('manual' as const) : v))
export type Tier = z.infer<typeof Tier>

/** The model every stage defaults to, spelled for whoever serves it. */
export const DEFAULT_MODEL = process.env.OPENROUTER_API_KEY ? 'anthropic/claude-opus-5.5' : 'claude-opus-5-5'

/** "HH:MM-HH:MM", may wrap past midnight. Only still parsed so a retired key can be named. */
const Window = z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/)

/** Exported so the defaults themselves can be asserted on; parse through
 *  `validatePolicyText` or `loadPolicy` in application code. */
export const PolicySchema = z.object({
  // Must match what the GitHub repo settings actually allow, or the merge API 405s.
  merge_method: z.enum(['squash', 'merge', 'rebase']).default('squash'),
  /**
   * The one switch: while this is on, shipshape merges and deploys nothing on its own.
   *
   * Scanning, pull requests and changelog reviews carry on -- what stops is every step
   * that would change the host without a person present. A merge *you* press still
   * deploys, because you are there to watch it.
   *
   * This replaces `merge.auto` and `deploy.mode`, which were two knobs for one question
   * and produced states nobody wanted: auto-merge with manual deploy meant the machine
   * changed the repository unattended and then left the host running the old image until
   * someone pasted a command. Optional here so an absent key can be told from an
   * explicit `false`, and derived from the old pair below when it is absent.
   */
  paused: z.boolean().optional(),
  sync: z
    .object({
      // Kill-switch. false => the tool never pushes main, which also means it can never
      // open a PR (a branch based on a stale origin/main would silently revert local
      // commits when merged). Degrades to alert-only.
      push_main: z.boolean().default(true),
      // Retired. The window existed so shipshape and WUD never wrote one compose file at
      // once; WUD is gone. An empty list still loads. A non-empty one is an error rather
      // than ignored, because dropping it silently would let work happen in hours the
      // file still says are quiet.
      blackout: z
        .array(Window)
        .refine((w) => w.length === 0, {
          message: 'sync.blackout is retired: remove the windows (or the key) from policy.yaml',
        })
        .optional(),
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
  /**
   * The changelog review: a cheap screen on every update, and a reader where a person
   * will read what it writes.
   *
   * Replaces `claude:`, which carried nine keys for one stage. What was tuning is now a
   * constant in code (web limits, the confidence floor); what only changed labels is gone
   * (`block_on`). The old block is still read and folded in below, never written back.
   */
  review: z
    .object({
      // off    -- no screen
      // shadow -- screen every update, record what it found, act on none of it
      // on     -- the screen decides which updates the reader is paid to read
      screen: z.enum(['off', 'shadow', 'on']).optional(),
      // The reader, or `off` for none. Runs where a person will read the result.
      model: z.string().optional(),
      // Drafts config changes and answers comments: rare, high-stakes work.
      code_model: z.string().optional(),
      monthly_budget_usd: z.number().positive().optional(),
    })
    .prefault({}),
  /** The old spelling of `review`. Accepted, folded, never written back. */
  claude: z
    .object({
      mode: z.enum(['advisory', 'off']).optional(),
      // Only ever changed which GitHub label a hold carried; the hold itself did not move.
      block_on: z.array(z.enum(['block', 'caution'])).optional(),
      // Now a constant, `medium`. `high` would have held more than that does, so it is
      // refused rather than quietly loosened.
      min_confidence: z
        .enum(['low', 'medium', 'high'])
        .refine((v) => v !== 'high', {
          message: 'claude.min_confidence: high is no longer supported (the floor is fixed at medium); remove it',
        })
        .optional(),
      model: z.string().optional(),
      code_model: z.string().optional(),
      // Constants now (4 searches, 5 pages, 12,000 tokens a page): cost, not reach.
      web: z.unknown().optional(),
      monthly_budget_usd: z.number().positive().optional(),
    })
    .optional(),
  prs: z
    .object({
      // Retired: `coexist` handled only what WUD never touched, and WUD is gone. `full`
      // still loads; `coexist` is refused rather than ignored, because ignoring it would
      // start opening pull requests a file says it should not.
      scope: z
        .enum(['coexist', 'wud-coexist', 'full'])
        .refine((v) => v === 'full', {
          message: 'prs.scope is retired and only `full` is accepted: remove the key from policy.yaml',
        })
        .optional(),
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
      // Retired: `sync.push_main: false` is the one kill switch for git work. `true`
      // still loads; `false` is refused rather than ignored.
      enabled: z
        .boolean()
        .refine((v) => v === true, {
          message: 'prs.enabled is retired: use sync.push_main: false to stop shipshape opening pull requests',
        })
        .optional(),
    })
    .prefault({}),
  propose: z
    .object({
      // auto -- draft changes whenever the review names steps this deployment must take
      // off  -- only when asked, per pull request
      //
      // `manual` was a third value that meant exactly what `off` now means -- the button
      // works under both -- so it is accepted and folded rather than kept as a synonym.
      mode: z
        .enum(['auto', 'manual', 'off'])
        .default('auto')
        .transform((v) => (v === 'manual' ? ('off' as const) : v)),
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
   * Comments on a pull request, read as instructions.
   *
   * Three rungs rather than the `auto | manual | off` the propose block uses, because
   * the question an operator actually has here is not "how often" but "how far". The
   * fear worth answering is "a sentence I typed caused a commit", and `reply` is the
   * rung that answers it: shipshape talks back, holds, re-reads a changelog or skips,
   * and writes nothing to the branch.
   *
   * `off` by default. Nobody upgrades into a feature that spends `code_model` on every
   * comment without choosing to.
   */
  revise: z
    .object({
      // off   -- comments are read by nobody
      // reply -- it answers, and may hold, skip, or re-read the changelog
      // act   -- it may also write the change onto the branch
      mode: z.enum(['off', 'reply', 'act']).default('off'),
      // Logins whose comments count as instructions. Empty means the account the token
      // authenticates as, which on a fine-grained PAT is the operator themselves.
      authors: z.array(z.string()).default([]),
      // How far a comment-driven edit may reach where the service's own
      // `shipshape.propose` label says nothing. Wider than the propose default on
      // purpose: drafting is shipshape's own idea and gets the narrowest useful
      // boundary, where a comment is a person asking for something specific and usually
      // about a file the service reads rather than the service block itself.
      //
      // An explicit label still wins outright, in both directions. Nothing here lifts
      // the permanently-forbidden paths.
      scope: z
        .enum(['none', 'service', 'compose-file', 'compose-dir', 'repo'])
        .default('compose-dir'),
      // Whether a revision may search and read the web. Off by default: the operator's
      // comment IS the specification, and fetching is what a call actually costs --
      // worst case drops from about $0.57 to under $0.05 with these off.
      web: z.boolean().default(false),
    })
    .prefault({}),
  // Retired with `shipshape.policy: model`, which now means `manual` -- what shadow mode,
  // the only mode it ever ran in here, returned. Accepted so an old file still loads.
  model_tier: z.unknown().optional(),
  merge: z
    .object({
      // Superseded by the top-level `paused`. Still read, so an existing file keeps its
      // meaning, and folded into it by the transform at the end of this schema; never
      // written back, and absent from the parsed policy every consumer sees.
      auto: z.boolean().optional(),
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
      // auto   -- bring merged changes up on the host, then verify them
      // manual -- sync only; the command is commented on the pull request
      //
      // `off` is gone. It claimed "do not even sync" and never did: the sync ran
      // unconditionally and the mode was only ever compared against `auto`, so it was a
      // third name for `manual`. Accepted on read so no existing file breaks, folded to
      // what it actually did. The kill-switch that genuinely stops git work is
      // sync.push_main.
      // Superseded by `paused` too. Merging now always leads to a deploy: the version in
      // git and the version running are the same claim, and a mode that syncs the file
      // without bringing it up made them differ by default.
      mode: z.enum(['auto', 'manual', 'off']).optional(),
      // How long a deploy has to prove itself. Returns the moment every signal is good,
      // so only a bad deploy pays the wait -- which is why this can afford to be long
      // enough for a service that runs migrations on first start. `health_window_s` is
      // still accepted as the old spelling.
      verify_window_s: z.number().int().positive().default(300),
      health_window_s: z.number().int().positive().optional(),
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
    .prefault({})
    .transform((d) => ({
      ...d,
      verify_window_s: d.health_window_s ?? d.verify_window_s,
    })),
  /** Stacks the tool must never touch. Its own stack is appended unconditionally --
   *  WUD's self-update crash-loop is not a mistake worth repeating. */
  exclude_stacks: z.array(z.string()).default([]),
})
  /**
   * Fold the two old knobs into `paused`, and drop them from the type.
   *
   * The mapping is the conservative reading of what each pair actually did: nothing runs
   * unattended unless the file said, in both places, that it should. Dropping the keys
   * from the output rather than leaving them makes every stale read a type error instead
   * of a behaviour that quietly disagrees with the switch.
   */
  .transform(({ merge, deploy, claude, review, prs, sync, model_tier: _modelTier, ...rest }) => ({
    ...rest,
    paused: rest.paused ?? !(merge.auto === true && deploy.mode === 'auto'),
    // `review` wins key by key; `claude` fills what it leaves out. `claude.mode: off`
    // meant no reading at all, so it turns both stages off.
    review: {
      // Off unless asked for: a new paid call is something you opt into.
      screen: review.screen ?? ('off' as const),
      model: review.model ?? (claude?.mode === 'off' ? 'off' : (claude?.model ?? DEFAULT_MODEL)),
      code_model: review.code_model ?? claude?.code_model ?? DEFAULT_MODEL,
      monthly_budget_usd: review.monthly_budget_usd ?? claude?.monthly_budget_usd ?? 40,
    },
    prs: { max_open: prs.max_open },
    sync: {
      push_main: sync.push_main,
      poll_active_s: sync.poll_active_s,
      poll_idle_s: sync.poll_idle_s,
    },
    merge: { max_per_run: merge.max_per_run },
    deploy: {
      verify_window_s: deploy.verify_window_s,
      probe: deploy.probe,
      soak_s: deploy.soak_s,
      rollback: deploy.rollback,
    },
  }))

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


