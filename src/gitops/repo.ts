import { execa, type Options } from 'execa'
import { existsSync, rmSync } from 'node:fs'
import { botIdentity, env, paths } from '../config.ts'
import { logEvent } from '../db.ts'
import { background } from '../lifecycle.ts'
import { credentialArgs, credentialEnv } from './credentials.ts'
import { looksLikeGitAuthFailure, noteAuthFailure } from '../health/github-auth.ts'

/**
 * Git plumbing, credentials, and the lock that keeps every repository operation
 * single-file.
 *
 * Two repositories, with strict roles:
 *   - the LIVE checkout is the user's workspace and the deploy source. It is only ever
 *     fetched, fast-forwarded, or rebased -- never checked out, stashed, or branched.
 *   - the WORK clone at /data/repo is where branches, edits and commits happen, so a
 *     dirty working tree in the live checkout can never block or corrupt a PR.
 */

/** Where git operations go: GIT_REMOTE_URL, else https://github.com/<GITHUB_REPO>.git. */
export function httpsUrl(): string {
  return env.gitRemote.url
}

export interface GitResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** Run git in `cwd`. Throws on non-zero unless `allowFail`. */
export async function git(
  cwd: string,
  args: string[],
  opts: {
    /** true: the compose repository's credential; 'github': GITHUB_TOKEN for github.com (forks). */
    remote?: boolean | 'github'
    allowFail?: boolean
    /** For the few commands that may legitimately take longer than two minutes: a first fetch of a large upstream. */
    timeoutMs?: number
    /** Extra environment, on top of the token and the no-prompt guard (a committer date, for a reproducible replay). */
    env?: Record<string, string>
  } = {},
): Promise<GitResult> {
  const which = opts.remote === 'github' ? 'github' : 'compose'
  const full = [...(opts.remote ? credentialArgs(which) : []), ...args]
  const execOpts: Options = {
    cwd,
    reject: false,
    timeout: opts.timeoutMs ?? 120_000,
    env: { ...(opts.env ?? {}), ...(opts.remote ? credentialEnv(which) : {}), GIT_TERMINAL_PROMPT: '0' },
  }
  const r = await execa('git', full, execOpts)
  const out = {
    stdout: String(r.stdout ?? '').trim(),
    stderr: String(r.stderr ?? '').trim(),
    exitCode: r.exitCode ?? 1,
  }
  // A remote operation refused on credentials is the same standing fault the API probe
  // reports, and it can happen while the API is still fine -- a token with contents read
  // but not write fetches happily and refuses every push. Reported here rather than at
  // each call site because this is the one place every remote command passes through,
  // and the `allowFail` callers swallow the error entirely.
  if (out.exitCode !== 0 && opts.remote && looksLikeGitAuthFailure(out.stderr)) {
    background(noteAuthFailure(`a remote operation was refused: ${out.stderr.split('\n')[0]}`), 'noting a refused credential', 'sync')
  }
  if (out.exitCode !== 0 && !opts.allowFail) {
    // Never echo the args back wholesale -- the credential helper string is in there.
    throw new Error(`git ${args[0]} failed (${out.exitCode}): ${out.stderr || out.stdout}`)
  }
  return out
}

/** The tool's own clone. Disposable: anything wrong with it is fixed by re-cloning. */
export async function ensureWorkRepo(): Promise<string> {
  const dir = paths.workRepo
  if (existsSync(dir)) {
    const ok = await git(dir, ['rev-parse', '--git-dir'], { allowFail: true })
    if (ok.exitCode === 0) {
      await git(dir, ['fetch', '--prune', httpsUrl(), '+refs/heads/*:refs/remotes/origin/*'], {
        remote: true,
      })
      return dir
    }
    logEvent({
      level: 'warn',
      kind: 'sync',
      message: 'work clone unusable, re-cloning',
      detail: dir,
    })
    rmSync(dir, { recursive: true, force: true })
  }
  await git('/', ['clone', '--no-recurse-submodules', httpsUrl(), dir], { remote: true })
  logEvent({ level: 'info', kind: 'sync', message: 'work clone created', detail: dir })
  return dir
}

/** Identity for tool-authored commits, so `git log` distinguishes them from the human. */
export const authorArgs = botIdentity

// ------------------------------------------------------------------- locking

/**
 * One repository operation at a time: an in-process promise chain. shipshape is a single
 * process, so that is all the exclusion there is; a crash mid-operation is settled at the
 * next start by what git itself says (an in-progress rebase pauses the sync).
 */
let chain: Promise<unknown> = Promise.resolve()

/** Resolves when every repository operation queued so far has finished. */
export function gitIdle(): Promise<void> {
  return withGitLock('shutdown', async () => undefined)
}

export function withGitLock<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const started = Date.now()
    try {
      return await fn()
    } finally {
      const ms = Date.now() - started
      if (ms > 60_000) {
        logEvent({
          level: 'warn',
          kind: 'sync',
          message: `git operation held the lock for ${Math.round(ms / 1000)}s`,
          detail: label,
        })
      }
    }
  })
  // Keep the chain alive even when this call rejects, or one failure wedges everything.
  chain = run.catch(() => undefined)
  return run
}
