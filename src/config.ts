import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
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


export interface GitRemote {
  /** What git is given: GIT_REMOTE_URL, else https://github.com/<GITHUB_REPO>.git, else ''. */
  url: string
  /** `local` is a path or file:// URL (tests, advanced); `unsupported` is ssh, plain http and anything else. */
  kind: 'none' | 'https' | 'local' | 'unsupported'
  /** Lower-case hostname of an https remote, else ''. */
  host: string
  /** Browsable address (no credentials, no `.git`, no trailing slash) of an https remote, else null. */
  webUrl: string | null
}

export function parseRemote(rawUrl: string, githubRepo: string): GitRemote {
  const url = rawUrl.trim() || (githubRepo ? `https://github.com/${githubRepo}.git` : '')
  if (!url) return { url: '', kind: 'none', host: '', webUrl: null }
  if (/^https:\/\//i.test(url)) {
    try {
      const u = new URL(url)
      u.username = ''
      u.password = ''
      return {
        url,
        kind: 'https',
        host: u.hostname.toLowerCase(),
        webUrl: u.origin + u.pathname.replace(/\/+$/, '').replace(/\.git$/, ''),
      }
    } catch {
      return { url, kind: 'unsupported', host: '', webUrl: null }
    }
  }
  if (isAbsolute(url) || url.startsWith('file://')) return { url, kind: 'local', host: '', webUrl: null }
  return { url, kind: 'unsupported', host: '', webUrl: null }
}

/** The compose repository's credentials. GITHUB_TOKEN is the default only on github.com. */
export function resolveGitCredentials(
  remote: GitRemote,
  v: { GIT_TOKEN?: string; GIT_USERNAME?: string; GITHUB_TOKEN?: string },
): { token: string; username: string } {
  if (remote.kind !== 'https') return { token: '', username: '' }
  const onGitHub = remote.host === 'github.com'
  return {
    token: v.GIT_TOKEN || (onGitHub ? (v.GITHUB_TOKEN ?? '') : ''),
    username: v.GIT_USERNAME || (onGitHub ? 'x-access-token' : ''),
  }
}

/** Why shipping cannot push yet, in the words the ship pass and Status use; null when it can. */
export function credentialProblem(remote: GitRemote, creds: { token: string; username: string }): string | null {
  if (remote.kind !== 'https') return null
  if (!creds.token) return remote.host === 'github.com' ? 'GITHUB_TOKEN is not set' : 'GIT_TOKEN is not set'
  if (!creds.username) return 'GIT_USERNAME is not set'
  return null
}

/** Branch names shipshape will publish to: no leading '-', no '..', no trailing '/' or '.lock'. */
export function validBranch(b: string): boolean {
  return /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/.test(b) && !b.includes('..') && !b.endsWith('/') && !b.endsWith('.lock')
}

/** GIT_BRANCH, else the branch `refs/remotes/origin/HEAD` names in the live checkout, else `main`. */
export function resolveBranch(explicit: string | undefined, repoDir: string): string {
  const given = explicit?.trim()
  if (given) return given
  if (repoDir) {
    try {
      const out = execFileSync('git', ['-C', repoDir, 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      }).trim()
      const m = /^origin\/(.+)$/.exec(out)
      if (m?.[1]) return m[1]
    } catch {
      // not a repository yet, no origin/HEAD, or no git: the default below
    }
  }
  return 'main'
}

const rawRepoDir = process.env.REPO_DIR ?? ''
const rawGithubRepo = process.env.GITHUB_REPO ?? ''
const givenGithubRepo = /^[\w.-]+\/[\w.-]+$/.test(rawGithubRepo) ? rawGithubRepo : ''
const remote = parseRemote(process.env.GIT_REMOTE_URL ?? '', givenGithubRepo)
const creds = resolveGitCredentials(remote, process.env)
const githubRepo =
  remote.kind === 'https' && remote.host !== 'github.com'
    ? ''
    : givenGithubRepo ||
      (remote.host === 'github.com' ? (/^https?:\/\/github\.com\/([^/]+\/[^/]+)$/i.exec(remote.webUrl ?? '')?.[1] ?? '') : '')

export const env = {
  /** The checkout of the compose repository. Must be mounted at the identical path
   *  inside the container: `docker compose` resolves relative volume paths and derives
   *  the project name client-side, so a different in-container path would hand the
   *  daemon paths that do not exist. */
  repoDir: rawRepoDir,
  dataDir: process.env.DATA_DIR ?? '/data',
  port: Number(process.env.PORT ?? 8080),
  tz: process.env.TZ ?? 'UTC',

  /** api.github.com reads of upstream projects; the default git credential on github.com only. */
  githubToken: process.env.GITHUB_TOKEN ?? '',
  /** `owner/repo` of the compose repository on GitHub; '' when it lives on another host. */
  githubRepo,
  /** Where the compose repository is published. */
  gitRemote: remote,
  /** The compose repository's credential, sent only to its remote's host. */
  gitToken: creds.token,
  gitUsername: creds.username,
  /** The branch shipshape publishes to (GIT_BRANCH, else origin/HEAD, else main). */
  gitBranch: resolveBranch(process.env.GIT_BRANCH, rawRepoDir),
  /** Stack directory holding shipshape itself, hard-excluded so it never updates or
   *  deploys over its own running container. */
  selfStack: process.env.SELF_STACK ?? 'shipshape',
  /** Git author for commits shipshape makes, so its work is distinguishable in the log. */
  botEmail: process.env.BOT_EMAIL ?? 'shipshape@localhost',

  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  /** Serves the screen's Decisions API; serves the Messages calls when neither LLM_BASE_URL
   *  nor ANTHROPIC_API_KEY is set; is the fallback credential for LLM_BASE_URL. */
  openrouterApiKey: process.env.OPENROUTER_API_KEY ?? '',
  /** A custom Anthropic-Messages-compatible endpoint (Ollama, LiteLLM). Set, it serves every model call. */
  llmBaseUrl: process.env.LLM_BASE_URL ?? '',
  /** The custom endpoint's bearer. */
  llmApiKey: process.env.LLM_API_KEY ?? '',
  /** The MCP listener's port (src/mcp). Off unless set, and it needs MCP_TOKEN as well. */
  mcpPort: process.env.MCP_PORT ? Number(process.env.MCP_PORT) : null,
  /** The bearer every MCP request must carry: `Authorization: Bearer <token>`. */
  mcpToken: process.env.MCP_TOKEN ?? '',
  /** Where the MCP listener binds. */
  mcpHost: process.env.MCP_HOST || '0.0.0.0',
  /** Signs the action links in email and ntfy notifications (src/notify/links.ts). Unset,
   *  those sinks send no links. */
  actionSecret: process.env.SHIPSHAPE_ACTION_SECRET ?? null,
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
  /** The sandbox dev server (bin/dev-ui.mjs): no scheduler, nothing reaches out. */
  uiDev: !!process.env.SHIPSHAPE_UI_DEV,
} as const

export function gitBranch(): string {
  return env.gitBranch
}

export function gitCredentialProblem(): string | null {
  return credentialProblem(env.gitRemote, { token: env.gitToken, username: env.gitUsername })
}

/** The variable an operator fixes: GIT_TOKEN when set or when the host is not GitHub, else GITHUB_TOKEN. */
export function gitCredentialName(): string {
  if (process.env.GIT_TOKEN) return 'GIT_TOKEN'
  if (env.gitRemote.kind === 'https' && env.gitRemote.host !== 'github.com') return 'GIT_TOKEN'
  return 'GITHUB_TOKEN'
}

/** Whether a commit made in the live checkout can be published right now. */
export function canPublish(): boolean {
  return env.gitRemote.kind === 'local' || (env.gitRemote.kind === 'https' && gitCredentialProblem() === null)
}

/** The UI's browser origin; read at call time because tests and operators change it without a new import. */
export function allowedOrigin(): string | undefined {
  return process.env.SHIPSHAPE_ALLOWED_ORIGIN
}

/** Where policy.yaml lives. Defaults inside the watched repo so it is tracked and
 *  reviewable like everything else; POLICY_FILE overrides for any other layout. */
/**
 * POLICY_FILE; else $REPO_DIR/shipshape.yaml if present; else the older
 * $REPO_DIR/<SELF_STACK>/config/policy.yaml if present; else $REPO_DIR/shipshape.yaml, which
 * the first Settings save or Always ship creates.
 */
export function resolvePolicyPath(
  repoDir: string,
  selfStack: string,
  explicit: string | undefined,
  exists: (p: string) => boolean = existsSync,
): string {
  if (explicit) return isAbsolute(explicit) ? explicit : join(repoDir, explicit)
  const root = join(repoDir, 'shipshape.yaml')
  const legacy = join(repoDir, selfStack, 'config', 'policy.yaml')
  return !exists(root) && exists(legacy) ? legacy : root
}

function policyPath(): string {
  return resolvePolicyPath(env.repoDir, env.selfStack, process.env.POLICY_FILE)
}

export const paths = {
  db: join(env.dataDir, 'shipshape.db'),
  /** The tool's own clone. All branch/edit/commit/push work happens here so the
   *  checkout -- which routinely carries uncommitted work -- is never disturbed. */
  workRepo: join(env.dataDir, 'repo'),
  lock: join(env.dataDir, 'git.lock'),
  policy: policyPath(),
} as const

/** Where the policy file is, repo-relative, and whether it exists yet. */
export function policyFileState(): { path: string; rel: string; exists: boolean } {
  return { path: paths.policy, rel: relative(env.repoDir, paths.policy) || paths.policy, exists: existsSync(paths.policy) }
}

/** The MCP listener runs only with a port and a token of at least 32 characters. */
export const MCP_TOKEN_MIN = 32
export function mcpEnabled(): boolean {
  return env.mcpPort !== null && env.mcpToken.length >= MCP_TOKEN_MIN
}

export type LlmProvider = 'custom' | 'anthropic' | 'openrouter' | 'none'

/** Who serves the Messages API. Pure, so the defaults below and the client agree. */
export function providerOf(k: { llmBaseUrl: string; anthropicApiKey: string; openrouterApiKey: string }): LlmProvider {
  if (k.llmBaseUrl) return 'custom'
  if (k.anthropicApiKey) return 'anthropic'
  if (k.openrouterApiKey) return 'openrouter'
  return 'none'
}

export const MODEL_DEFAULTS: Record<LlmProvider, { reader: string; code: string }> = {
  anthropic: { reader: 'claude-sonnet-5-5', code: 'claude-opus-5-5' },
  none: { reader: 'claude-sonnet-5-5', code: 'claude-opus-5-5' },
  openrouter: { reader: 'anthropic/claude-sonnet-5.5', code: 'anthropic/claude-opus-5.5' },
  // A custom endpoint serves whatever its operator loaded; there is no name to guess.
  custom: { reader: '', code: '' },
}

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
export function missingSettings(i: {
  repoDir: string
  repoDirExists: boolean
  rawGithubRepo: string
  remote: GitRemote
  branch: string
}): MissingSetting[] {
  const missing: MissingSetting[] = []
  if (!i.repoDir) {
    missing.push({
      name: 'REPO_DIR',
      why: 'path to the checkout of your compose repository, mounted at the same path inside the container',
    })
  } else if (!i.repoDirExists) {
    missing.push({
      name: 'REPO_DIR',
      why: `"${i.repoDir}" does not exist inside the container -- check the bind mount uses the identical host path`,
    })
  }
  if (i.remote.kind === 'none') {
    missing.push(
      i.rawGithubRepo
        ? { name: 'GITHUB_REPO', why: `"${i.rawGithubRepo}" is not owner/repo` }
        : {
            name: 'GITHUB_REPO or GIT_REMOTE_URL',
            why: 'where your compose repository is published: GITHUB_REPO as owner/repo for GitHub, or GIT_REMOTE_URL as an https URL for any other git host',
          },
    )
  }
  if (i.remote.kind === 'unsupported') {
    missing.push({
      name: 'GIT_REMOTE_URL',
      why: 'must be an https:// URL (plain http and ssh remotes are not supported); sign in with GIT_TOKEN, and GIT_USERNAME for any host other than github.com',
    })
  }
  if (!validBranch(i.branch)) missing.push({ name: 'GIT_BRANCH', why: `"${i.branch}" is not a usable branch name` })
  return missing
}

export function configured(): { ok: true } | { ok: false; missing: MissingSetting[] } {
  const missing = missingSettings({
    repoDir: env.repoDir,
    repoDirExists: !!env.repoDir && existsSync(env.repoDir),
    rawGithubRepo,
    remote: env.gitRemote,
    branch: env.gitBranch,
  })
  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}

/** The model every stage defaults to, spelled for whoever serves it. */
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
  z.object({ type: z.literal('gotify'), url: z.string().url(), token_env: z.string().default('GOTIFY_TOKEN'), events: Events }),
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
      // Cron with seconds field (croner). Default 03:00 -- clear of WUD's 01:00 watch
      // and the blackout window that covers it.
      cron: z.string().default('0 0 3 * * *'),
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
      interval_m: z.number().int().min(5).max(24 * 60).default(15),
      // Image inventories taken per pass, at most. Each one is 20-60 s of syft.
      sbom_per_pass: z.number().int().min(1).max(50).default(6),
      // The scanner, pinned by digest. Run as its own short-lived container so a large
      // image cannot push shipshape itself past its memory limit.
      syft_image: z
        .string()
        .default('anchore/syft:v1.54.1@sha256:3eb5379ba7b409c3f4069b686110527af0c47df993fa5c10d13e7cf34f49b1aa'),
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
  /** Standing "always ship" decisions. Written by shipshape; readable and editable by you. */
  rules: z.array(RuleSchema).default([]),
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
export function loadPolicy(): { policy: Policy; error?: string; missing?: true } {
  let raw: string
  try {
    raw = readFileSync(paths.policy, 'utf8')
  } catch {
    // An absent file is the normal first-run state: the defaults hold, and paused is true.
    return { policy: cached?.policy ?? FALLBACK, missing: true }
  }
  if (cached?.raw === raw) return { policy: cached.policy }
  const retired = retiredKeys(raw)
  if (retired.length > 0) return { policy: cached?.policy ?? FALLBACK, error: retiredKeysMessage(retired) }
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

/**
 * Keys of the pull-request era (v1). A policy file that still carries any of them is
 * refused as a whole rather than half-read: zod would strip them silently, and a file
 * that says something nothing obeys is worse than one that is refused. `convert-v1`
 * rewrites them.
 */
export const RETIRED_KEYS = [
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

/** Check a candidate policy.yaml before it is allowed to replace the real one. */
export function validatePolicyText(raw: string): { ok: true } | { ok: false; error: string } {
  const retired = retiredKeys(raw)
  if (retired.length > 0) return { ok: false, error: retiredKeysMessage(retired) }
  try {
    PolicySchema.parse(parseYaml(raw) ?? {})
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 400) : String(err) }
  }
}


