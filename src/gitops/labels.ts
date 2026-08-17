import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from 'execa'
import { botIdentity, env } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { setLabel } from '../compose/edit.ts'
import { TIER_LABELS } from '../policy.ts'
import { git, withGitLock } from './repo.ts'
import { syncMain } from './sync.ts'

/**
 * The write path for a service's update policy: splice `shipshape.policy` or
 * `shipshape.watch` into its compose file, gate the result, commit, publish.
 *
 * This edits the LIVE checkout -- the same file `docker compose` deploys from -- so it
 * carries the same guardrails as the settings page's policy.yaml writes: refuse unless
 * the checkout is on main, refuse if the target file has uncommitted changes (a browser
 * click must never fold a hand-edit into shipshape's commit), and revert the bytes the
 * moment any gate disagrees. The caller re-scans afterwards; nothing here touches the
 * images table.
 */

export interface SetServiceLabelResult {
  ok: boolean
  message: string
  sha?: string
}

const WATCH_VALUES = new Set(['true', 'false'])

export async function setServiceLabel(o: {
  stack: string
  service: string
  key: 'policy' | 'watch'
  value: string | null
}): Promise<SetServiceLabelResult> {
  return withGitLock('label-edit', () => run(o))
}

async function run(o: {
  stack: string
  service: string
  key: 'policy' | 'watch'
  value: string | null
}): Promise<SetServiceLabelResult> {
  const { stack, service, key, value } = o

  // The file is the wrong place to discover a typo: an unknown policy label narrows to
  // `manual` on read (a typo must never grant reach), so a bad value would not break
  // anything -- it would sit in the file meaning something other than what it says.
  if (key === 'policy' && value !== null && !(TIER_LABELS as readonly string[]).includes(value)) {
    return {
      ok: false,
      message: `"${value}" is not a policy shipshape accepts (${TIER_LABELS.join(', ')}).`,
    }
  }
  if (key === 'watch' && value !== null && !WATCH_VALUES.has(value)) {
    return { ok: false, message: `shipshape.watch is "true" or "false", not "${value}".` }
  }

  const head = await git(env.repoDir, ['symbolic-ref', '--short', 'HEAD'], { allowFail: true })
  if (head.exitCode !== 0 || head.stdout !== 'main') {
    return {
      ok: false,
      message: `The checkout is on "${head.stdout || 'a detached HEAD'}", not main. Nothing was changed.`,
    }
  }

  const row = getDb()
    .prepare(`SELECT compose_file FROM images WHERE stack = ? AND service = ?`)
    .get(stack, service) as { compose_file: string } | undefined
  if (!row) {
    return { ok: false, message: `No compose file is known for ${stack}/${service}.` }
  }
  const rel = row.compose_file
  const abs = join(env.repoDir, rel)

  // An untracked file has no committed baseline to revert to, and `git commit -- file`
  // would sweep the whole hand-written file into shipshape's commit.
  const tracked = await git(env.repoDir, ['ls-files', '--error-unmatch', '--', rel], {
    allowFail: true,
  })
  if (tracked.exitCode !== 0) {
    return { ok: false, message: `${rel} is not tracked by git. Commit it first.` }
  }

  // Same refusal as applySettings, for the same reason: committing on top of a dirty
  // file would carry changes nobody reviewed here. Staged counts as dirty -- a partial
  // `git add` is still a hand-edit in flight.
  const dirty = await git(env.repoDir, ['diff', '--name-only', '--', rel], { allowFail: true })
  const staged = await git(env.repoDir, ['diff', '--cached', '--name-only', '--', rel], {
    allowFail: true,
  })
  if (dirty.stdout || staged.stdout) {
    return {
      ok: false,
      message: `${rel} has uncommitted changes in the checkout. Commit or discard them first.`,
    }
  }

  let original: string
  try {
    original = readFileSync(abs, 'utf8')
  } catch (err) {
    return { ok: false, message: `Cannot read ${rel}: ${(err as Error).message}` }
  }

  const labelKey = `shipshape.${key}`
  const first = setLabel(original, service, labelKey, value)
  if (!first.ok) return { ok: false, message: `${rel}: ${first.reason}` }
  let next = first.text

  // Writing a policy while `shipshape.pr: on-request` stands would be silently inert:
  // tierFor lets the pr label win, so the service stays held whatever the new policy
  // says. Remove it in the same commit. (Removal of the policy itself leaves pr alone
  // -- that is a return to label-less defaults, not a statement about holds.)
  let removedPr = false
  if (key === 'policy' && value !== null) {
    const second = setLabel(next, service, 'shipshape.pr', null)
    if (!second.ok) return { ok: false, message: `${rel}: ${second.reason}` }
    removedPr = second.text !== next
    next = second.text
  }

  const verb = value === null ? `shipshape.${key} removed` : `shipshape.${key}=${value}`
  if (next === original) {
    return { ok: true, message: `${rel} already says ${verb}; nothing to commit.` }
  }

  writeFileSync(abs, next)

  const restore = async () => {
    await git(env.repoDir, ['reset', '-q', 'HEAD', '--', rel], { allowFail: true })
    writeFileSync(abs, original)
    await git(env.repoDir, ['checkout', '--', rel], { allowFail: true })
  }

  // Gate A: compose must still accept the file. `--no-interpolate` because validity of
  // the structure is the question, not whether every ${VAR} resolves right now. The
  // probe first: tests (and any host without the compose plugin) skip the gate rather
  // than failing every edit on a missing binary.
  const probe = await execa('docker', ['compose', 'version'], { reject: false, timeout: 15_000 })
  if ((probe.exitCode ?? 1) === 0) {
    const cfg = await execa('docker', ['compose', '-f', abs, 'config', '--no-interpolate', '-q'], {
      reject: false,
      timeout: 60_000,
      cwd: env.repoDir,
    })
    if ((cfg.exitCode ?? 1) !== 0) {
      await restore()
      return {
        ok: false,
        message: `Compose rejected the edited file, so it was restored: ${String(cfg.stderr ?? '').slice(0, 200)}`,
      }
    }
  }

  // Gate B: the textual diff must contain nothing but shipshape label lines (plus the
  // bare `labels:` line when a block was created or emptied). Anything else means the
  // splice moved something it should not have.
  const diff = await git(env.repoDir, ['diff', '-U0', '--', rel], { allowFail: true })
  const changed = diff.stdout
    .split('\n')
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
  const offending = changed.filter(
    (l) => !/^[+-]\s*(shipshape\.(policy|watch|pr):|labels:\s*$)/.test(l),
  )
  if (changed.length === 0 || offending.length > 0) {
    await restore()
    return {
      ok: false,
      message:
        changed.length === 0
          ? 'The edit produced no diff, so nothing was committed.'
          : `The edit touched a non-label line, so it was reverted: ${offending[0]!.slice(0, 120)}`,
    }
  }

  const commitMsg = `chore(shipshape): ${stack}/${service}: ${verb}`
  try {
    await git(env.repoDir, ['add', '--', rel])
    await git(env.repoDir, [...botIdentity(), 'commit', '-m', commitMsg, '--', rel])
  } catch (err) {
    await restore()
    return { ok: false, message: `Could not commit the change: ${(err as Error).message}` }
  }
  const sha = (await git(env.repoDir, ['rev-parse', '--short', 'HEAD'], { allowFail: true })).stdout

  // Publish, best-effort: the commit exists either way, and the regular sync cycle
  // retries. Unconfigured (tests, first run) means there is no origin to publish to.
  let publishNote = ''
  if (env.githubRepo && env.githubToken) {
    try {
      const sync = await syncMain()
      if (sync.status === 'paused' || sync.status === 'refused') {
        publishNote = ` Publishing is deferred: ${sync.reason}.`
      }
    } catch (err) {
      publishNote = ` Publishing is deferred: ${(err as Error).message.slice(0, 120)}.`
    }
  }

  const prNote = removedPr
    ? ' Also removed shipshape.pr: on-request, which would otherwise have kept the service held regardless of the new policy.'
    : ''
  logEvent({
    level: 'info',
    kind: 'policy',
    stack,
    service,
    message: `${stack}/${service}: ${verb}`,
    detail: `committed ${sha}${removedPr ? ', removed shipshape.pr' : ''}`,
  })
  return {
    ok: true,
    sha,
    message: `${rel}: ${verb}, committed as ${sha}.${prNote}${publishNote}`,
  }
}
