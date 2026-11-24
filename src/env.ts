import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

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
