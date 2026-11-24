import { execa } from 'execa'
import { env, gitBranch, gitCredentialName, type GitRemote } from '../env.ts'
import { logEvent } from '../events.ts'
import { notify, resolveIncident } from '../notify/index.ts'
import { ghRequest } from '../upstream/github.ts'
import { credentialArgs, credentialEnv } from '../gitops/credentials.ts'

/**
 * Saying so when GitHub stops accepting the credentials.
 *
 * Written from a specific six-day silence. A token expired; every call began coming back
 * 401; the container stayed green and healthy throughout, because its health check only
 * asks whether the process is listening. Scanning needs no credentials, so it went on
 * finding updates and the backlog grew behind a door that could not open -- no pull
 * request, no merge, no push of main. The only trace was one warning line per poll, in a
 * log nobody reads while nothing appears to be wrong.
 *
 * Its replacement then failed differently and just as quietly: it authenticated perfectly
 * but had been scoped to public repositories, so a private repo answered 404 to
 * everything. To the operator both are one fact -- shipshape cannot reach GitHub -- and
 * neither was worth a notification at the time.
 *
 * So this asks the question directly rather than inferring it from whichever call
 * happened to fail: can we read the repository we are configured to work on? 401 says the
 * credential is dead, 404 says it cannot see the repo, and both mean stopped. Inferring
 * it from incidental failures is what makes 404 ambiguous -- a missing pull request
 * answers 404 too -- and asking about the repository itself has no such second meaning.
 */

export interface AuthOk {
  ok: true
}
export interface AuthBad {
  ok: false
  /** `rejected`: the credential is refused. `unreachable`: valid, but cannot see the repo. */
  kind: 'rejected' | 'unreachable'
  reason: string
}
export type AuthState = AuthOk | AuthBad

/**
 * What a probe response means, as a pure function of what came back.
 *
 * 403 is deliberately not an auth failure on its own: it is overwhelmingly a rate limit,
 * and crying about credentials every time the hourly budget runs out would teach the
 * operator to ignore the one message this module exists to send. Only a 403 that says so
 * in words counts.
 */
export function classifyProbe(status: number, message: string): AuthState {
  if (status >= 200 && status < 300) return { ok: true }
  if (status === 401) {
    return { ok: false, kind: 'rejected', reason: 'the token was refused (401) -- it has expired or been revoked' }
  }
  if (status === 404) {
    return {
      ok: false,
      kind: 'unreachable',
      reason: `the token cannot see ${env.githubRepo} (404) -- it is scoped to other repositories, or the repository is gone`,
    }
  }
  if (status === 403 && /bad credential|token|permission/i.test(message)) {
    return { ok: false, kind: 'rejected', reason: `GitHub refused the token (403): ${message}` }
  }
  return { ok: true }
}

/** git speaks its own dialect of "your credentials are no good". */
export function looksLikeGitAuthFailure(stderr: string): boolean {
  return /authentication failed|invalid username or token|bad credentials|could not read username|terminal prompts disabled/i.test(
    stderr,
  )
}

let failing: { since: string; reason: string; lastAlertAt: number } | null = null

/** How long a standing failure waits before saying it again. */
const REMIND_MS = 24 * 60 * 60 * 1000

/** For the Status page, so "set" cannot keep meaning "present but refused". */
export function authHealth(): { ok: boolean; reason?: string; since?: string } {
  return failing ? { ok: false, reason: failing.reason, since: failing.since } : { ok: true }
}

/**
 * Record that GitHub is refusing us, and say so -- once, then daily while it lasts.
 *
 * An alert rather than a digest item, and that is the whole point of the change: every
 * step that reaches GitHub is stopped, so waiting until 08:00 tomorrow to mention it
 * costs another night of the backlog growing. Repeating it every poll would be worse than
 * saying nothing, which is why a standing failure only speaks again after a day.
 */
export async function noteAuthFailure(reason: string): Promise<void> {
  const now = Date.now()
  const fresh = !failing
  if (failing && now - failing.lastAlertAt < REMIND_MS) return
  const since = failing?.since ?? new Date(now).toISOString()
  failing = { since, reason, lastAlertAt: now }

  const host = env.gitRemote.host || 'the git remote'
  logEvent({
    level: 'error',
    kind: 'ship',
    message: `${host} is refusing the credentials`,
    detail: reason,
  })
  await notify({
    // The key predates other forges; kept so an incident already open resolves normally.
    key: 'shipshape:github-auth',
    title: `shipshape: ${host} is refusing the credentials`,
    body: [
      reason,
      '',
      `Nothing can ship or publish ${gitBranch()} while this lasts. Scanning carries on, so`,
      'the backlog will keep growing until it is fixed.',
      '',
      `Fix ${gitCredentialName()} in the environment shipshape runs with, then recreate the container so it is read again.`,
      fresh ? '' : `Still failing since ${since}.`,
    ]
      .filter(Boolean)
      .join('\n'),
    priority: 5,
    tags: ['warning'],
  })
}

/** Clear a standing failure: the incident it opened is resolved, silently. */
async function noteAuthOk(): Promise<void> {
  if (!failing) return
  const since = failing.since
  failing = null
  logEvent({
    level: 'info',
    kind: 'ship',
    message: `${env.gitRemote.host || 'the git remote'} is accepting the credentials again`,
    detail: `refused since ${since}`,
  })
  await resolveIncident('shipshape:github-auth')
}

export type ProbeMethod = 'api' | 'ls-remote' | 'none'

/**
 * How the credential is checked. The API is asked only with GITHUB_TOKEN, and only when
 * that is also the git credential: a GIT_TOKEN for some other host must never reach
 * api.github.com. Every other https remote is asked with `git ls-remote`.
 */
export function probeMethod(i: {
  remote: GitRemote
  githubRepo: string
  gitToken: string
  githubToken: string
}): ProbeMethod {
  if (i.remote.kind !== 'https' || !i.gitToken) return 'none'
  if (i.remote.host === 'github.com' && i.githubRepo && i.gitToken === i.githubToken) return 'api'
  return 'ls-remote'
}

const currentMethod = () =>
  probeMethod({
    remote: env.gitRemote,
    githubRepo: env.githubRepo,
    gitToken: env.gitToken,
    githubToken: env.githubToken,
  })

async function probeApi(): Promise<AuthState> {
  const r = await ghRequest<unknown>(`/repos/${env.githubRepo}`, { token: env.githubToken })
  if (r.ok) return { ok: true }
  if (r.kind === 'not-found') return classifyProbe(404, '')
  if (r.kind === 'auth') {
    return r.status === 401
      ? classifyProbe(401, '')
      : classifyProbe(r.status ?? 403, 'the token cannot read this repository')
  }
  // Rate-limited, network, server: not a credential fault.
  return { ok: true }
}

let lsRemoteMemo: { at: number; state: AuthState } | null = null
const LS_REMOTE_EVERY_MS = 5 * 60_000

async function probeLsRemote(): Promise<AuthState> {
  if (lsRemoteMemo && Date.now() - lsRemoteMemo.at < LS_REMOTE_EVERY_MS) return lsRemoteMemo.state
  const r = await execa('git', [...credentialArgs('compose'), 'ls-remote', '--exit-code', env.gitRemote.url, 'HEAD'], {
    cwd: '/',
    reject: false,
    timeout: 30_000,
    env: { ...credentialEnv('compose'), GIT_TERMINAL_PROMPT: '0' },
  })
  const stderr = String(r.stderr ?? '').trim()
  const first = stderr.split('\n')[0] ?? ''
  const host = env.gitRemote.host
  let state: AuthState
  // 2: reachable, no HEAD (an empty repository).
  if (r.exitCode === 0 || r.exitCode === 2) state = { ok: true }
  else if (looksLikeGitAuthFailure(stderr))
    state = { ok: false, kind: 'rejected', reason: `${host} refused the credentials (${first})` }
  else if (/not found|does not exist|404/i.test(stderr)) {
    state = {
      ok: false,
      kind: 'unreachable',
      reason: `${host} has no repository at ${env.gitRemote.webUrl} that these credentials can see`,
    }
  } else state = { ok: true } // a network failure is not a credential fault
  lsRemoteMemo = { at: Date.now(), state }
  return state
}

/** Can the configured credential reach the repository we are configured to work on? */
export async function probeRemoteAuth(): Promise<AuthState> {
  switch (currentMethod()) {
    case 'api':
      return probeApi()
    case 'ls-remote':
      return probeLsRemote()
    default:
      return { ok: true }
  }
}

/**
 * Probe, and alert on the transition. Safe to call every tick.
 *
 * Skipped entirely when there is nothing to check: an unconfigured install is a setup
 * banner, not a fault, and the operator has not asked it to do anything yet.
 */
export async function checkRemoteAuth(): Promise<AuthState> {
  if (currentMethod() === 'none') return { ok: true }
  const state = await probeRemoteAuth()
  if (state.ok) await noteAuthOk()
  else await noteAuthFailure(state.reason)
  return state
}

/** Test seam: the module holds one standing condition, and tests need it reset. */
export function resetAuthHealth(): void {
  failing = null
  lsRemoteMemo = null
}
