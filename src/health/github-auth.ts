import { Octokit } from 'octokit'
import { env } from '../config.ts'
import { logEvent } from '../db.ts'
import { notify } from '../notify/index.ts'

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

  logEvent({
    level: 'error',
    kind: 'pr',
    message: 'GitHub is refusing the credentials',
    detail: reason,
  })
  await notify({
    title: 'shipshape: GitHub is refusing the credentials',
    body: [
      reason,
      '',
      'Nothing can open, merge, deploy or push while this lasts. Scanning carries on, so',
      'the backlog will keep growing until it is fixed.',
      '',
      `Set GITHUB_TOKEN in shipshape/.env, then: docker compose -f shipshape/docker-compose.yaml up -d`,
      fresh ? '' : `Still failing since ${since}.`,
    ]
      .filter(Boolean)
      .join('\n'),
    priority: 5,
    tags: ['warning'],
  })
}

/** Clear a standing failure, and say that too -- silence is how the last one lasted. */
export async function noteAuthOk(): Promise<void> {
  if (!failing) return
  const since = failing.since
  failing = null
  logEvent({ level: 'info', kind: 'pr', message: 'GitHub is accepting the credentials again' })
  await notify({
    title: 'shipshape: GitHub credentials working again',
    body: `Recovered. It had been refusing us since ${since}.`,
    priority: 3,
    tags: ['white_check_mark'],
  })
}

let probe: Octokit | null = null

/** Can we read the repository we are configured to work on? */
export async function probeGitHubAuth(): Promise<AuthState> {
  const [owner, repo] = env.githubRepo.split('/') as [string, string]
  probe ??= new Octokit({ auth: env.githubToken })
  try {
    const res = await probe.rest.repos.get({ owner, repo })
    return classifyProbe(res.status, '')
  } catch (err) {
    const e = err as { status?: number; message?: string }
    // No status at all is a network problem, not a credential one. Saying "your token is
    // dead" when the internet is down is how an alert loses its meaning.
    if (typeof e.status !== 'number') return { ok: true }
    return classifyProbe(e.status, e.message ?? '')
  }
}

/**
 * Probe, and alert on the transition. Safe to call every tick.
 *
 * Skipped entirely when no token is configured: an unconfigured install is a setup banner,
 * not a fault, and the operator has not asked it to do anything yet.
 */
export async function checkGitHubAuth(): Promise<AuthState> {
  if (!env.githubToken) return { ok: true }
  const state = await probeGitHubAuth()
  if (state.ok) await noteAuthOk()
  else await noteAuthFailure(state.reason)
  return state
}

/** Test seam: the module holds one standing condition, and tests need it reset. */
export function resetAuthHealth(): void {
  failing = null
}
