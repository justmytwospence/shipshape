import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { validatePolicyText } from '../config.ts'
import { botIdentity, env, gitBranch, paths } from '../env.ts'
import { POLICY_STARTER } from '../policy-starter.ts'
import { git, withGitLock } from './repo.ts'
import { inProgress } from './sync.ts'

/**
 * One way to change a file in the live checkout and commit it.
 *
 * Settings, Always ship and the label editor all do the same thing: edit a tracked file
 * that is someone's working copy, and commit it as the bot. Each used to carry its own copy
 * of the safety rules, and they had drifted (one checked the branch, one the staged index,
 * one neither). The rules, in order, are: be on the configured branch; no rebase, merge or
 * cherry-pick in progress; the file tracked and clean, staged edits included (a browser
 * click must never fold a hand-edit into shipshape's commit); a mutation that can refuse;
 * an optional gate on the written bytes; and the bytes put back when the commit fails.
 */
export interface CheckoutWrite {
  /** Repo-relative path. */
  rel: string
  /**
   * The new text, given the file's current text (null when it does not exist yet); or the
   * sentence that refuses; or `unchanged` when there is nothing to write.
   */
  mutate: (original: string | null) => { text: string } | { error: string } | { unchanged: true }
  /** After the bytes are on disk, before the commit. A sentence refuses and restores. */
  gate?: (text: string) => Promise<string | null>
  message: string | (() => string)
}

export type CheckoutWriteResult =
  | { ok: true; changed: boolean; sha: string | null }
  | { ok: false; code: 'branch' | 'busy' | 'untracked' | 'dirty' | 'read' | 'invalid' | 'gate' | 'commit'; reason: string }

const refuse = (code: Extract<CheckoutWriteResult, { ok: false }>['code'], reason: string): CheckoutWriteResult => ({
  ok: false,
  code,
  reason,
})

/** The caller must hold the git lock: the commit is made in the live checkout. */
export async function commitCheckoutFile(w: CheckoutWrite): Promise<CheckoutWriteResult> {
  const repo = env.repoDir
  const { rel } = w
  const abs = join(repo, rel)

  const head = await git(repo, ['symbolic-ref', '--short', 'HEAD'], { allowFail: true })
  if (head.exitCode !== 0 || head.stdout !== gitBranch()) {
    return refuse(
      'branch',
      `The checkout is on "${head.stdout || 'a detached HEAD'}", not ${gitBranch()}. Nothing was changed.`,
    )
  }
  const op = await inProgress()
  if (op) return refuse('busy', `A ${op} is in progress in the checkout. Nothing was changed.`)

  let original: string | null
  try {
    original = readFileSync(abs, 'utf8')
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') {
      return refuse('read', `Cannot read ${rel}: ${(err as Error).message}`)
    }
    original = null
  }

  if (original !== null) {
    // An untracked file has no committed baseline to revert to, and `git commit -- file`
    // would sweep the whole hand-written file into shipshape's commit.
    const tracked = await git(repo, ['ls-files', '--error-unmatch', '--', rel], { allowFail: true })
    if (tracked.exitCode !== 0) return refuse('untracked', `${rel} is not tracked by git. Commit it first.`)
    // Staged counts as dirty: a partial `git add` is still a hand-edit in flight.
    const dirty = await git(repo, ['diff', '--name-only', '--', rel], { allowFail: true })
    const staged = await git(repo, ['diff', '--cached', '--name-only', '--', rel], { allowFail: true })
    if (dirty.stdout || staged.stdout) {
      return refuse('dirty', `${rel} has uncommitted changes in the checkout. Commit or discard them first.`)
    }
  }

  const next = w.mutate(original)
  if ('error' in next) return refuse('invalid', next.error)
  if ('unchanged' in next || next.text === original) return { ok: true, changed: false, sha: null }

  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, next.text)
  const restore = async () => {
    await git(repo, ['reset', '-q', 'HEAD', '--', rel], { allowFail: true })
    if (original === null) rmSync(abs, { force: true })
    else {
      writeFileSync(abs, original)
      await git(repo, ['checkout', '--', rel], { allowFail: true })
    }
  }

  if (w.gate) {
    const refused = await w.gate(next.text)
    if (refused !== null) {
      await restore()
      return refuse('gate', refused)
    }
  }

  try {
    await git(repo, ['add', '--', rel])
    await git(repo, [...botIdentity(), 'commit', '-m', typeof w.message === 'function' ? w.message() : w.message, '--', rel])
  } catch (err) {
    await restore()
    return refuse('commit', `Could not commit the change: ${(err as Error).message.slice(0, 160)}`)
  }
  const sha = (await git(repo, ['rev-parse', '--short', 'HEAD'], { allowFail: true })).stdout
  return { ok: true, changed: true, sha }
}

/**
 * The policy file: takes the git lock, refuses a result the app could not load, and starts
 * from the starter when the file does not exist yet.
 */
export async function commitPolicyFile(
  /** Given the file's text, or the starter text when the file does not exist yet. */
  mutate: (current: string) => { text: string } | { error: string } | { unchanged: true },
  message: string | (() => string),
): Promise<CheckoutWriteResult> {
  // With no checkout configured, the policy path is relative to the working directory and
  // git would run there: nothing may be written.
  if (!env.repoDir) return refuse('read', 'cannot read policy.yaml: REPO_DIR is not set')
  const rel = relative(env.repoDir, paths.policy)
  const r = await withGitLock('policy-file', () =>
    commitCheckoutFile({
      rel,
      message,
      mutate: (original) => {
        const current = original ?? POLICY_STARTER
        const m = mutate(current)
        if ('error' in m || 'unchanged' in m) return m
        // Saving the starter over a missing file changes nothing.
        if (m.text === current) return { unchanged: true }
        const check = validatePolicyText(m.text)
        return check.ok ? m : { error: check.error }
      },
    }),
  )
  if (!r.ok && r.code === 'read') {
    return { ...r, reason: r.reason.replace(/^Cannot read [^:]*:/, 'cannot read policy.yaml:') }
  }
  return r
}
