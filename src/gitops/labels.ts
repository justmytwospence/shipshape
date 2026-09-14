import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from 'execa'
import { botIdentity, env } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { setLabel } from '../compose/edit.ts'
import { TIER_LABELS } from '../policy.ts'
import { parseChangelogLabel, parseSourceLabel } from '../resolver/labels.ts'
import { git, withGitLock } from './repo.ts'
import { syncMain } from './sync.ts'

/**
 * The write path for a service's labels: splice `shipshape.policy`, `shipshape.watch`,
 * `shipshape.source` or `shipshape.changelog` into its compose file, gate the result, commit,
 * publish.
 *
 * This edits the LIVE checkout -- the same file `docker compose` deploys from -- so it
 * carries the same guardrails as the settings page's policy.yaml writes: refuse unless
 * the checkout is on main, refuse if the target file has uncommitted changes (a browser
 * click must never fold a hand-edit into shipshape's commit), and revert the bytes the
 * moment any gate disagrees. The caller re-scans afterwards; nothing here touches the
 * images table, and nothing here touches the network before the commit: a link is checked
 * for what it is, not fetched.
 */

export interface SetServiceLabelResult {
  ok: boolean
  message: string
  sha?: string
}

export type LabelKey = 'policy' | 'watch' | 'source' | 'changelog'

export interface LabelChange {
  key: LabelKey
  /** null removes the label. */
  value: string | null
}

const WATCH_VALUES = new Set(['true', 'false'])

export async function setServiceLabel(o: {
  stack: string
  service: string
  key: LabelKey
  value: string | null
}): Promise<SetServiceLabelResult> {
  return setServiceLabels({ stack: o.stack, service: o.service, changes: [{ key: o.key, value: o.value }] })
}

/** Several labels on one service, in one commit: a repository and its notes link go together. */
export async function setServiceLabels(o: {
  stack: string
  service: string
  changes: LabelChange[]
}): Promise<SetServiceLabelResult> {
  return withGitLock('label-edit', () => run(o))
}

/**
 * A change as it will be written, or why it is refused. The file is the wrong place to
 * discover a typo: an unknown policy narrows to `manual` on read, an unparseable source is
 * ignored with a note -- either way the file would say something other than what it means.
 */
function prepare(c: LabelChange): { ok: true; change: LabelChange } | { ok: false; message: string } {
  if (c.value === null) return { ok: true, change: c }
  switch (c.key) {
    case 'policy':
      return (TIER_LABELS as readonly string[]).includes(c.value)
        ? { ok: true, change: c }
        : { ok: false, message: `"${c.value}" is not a policy shipshape accepts (${TIER_LABELS.join(', ')}).` }
    case 'watch':
      return WATCH_VALUES.has(c.value)
        ? { ok: true, change: c }
        : { ok: false, message: `shipshape.watch is "true" or "false", not "${c.value}".` }
    case 'source': {
      // Written as `owner/repo`, whichever form it was typed in: the file stays readable, and
      // two services on one image are compared as the same string.
      const p = parseSourceLabel(c.value)
      return p.ok
        ? { ok: true, change: { key: 'source', value: p.repo } }
        : { ok: false, message: `shipshape.source "${c.value}" was not written: ${p.reason}.` }
    }
    case 'changelog': {
      const p = parseChangelogLabel(c.value)
      return p.ok
        ? { ok: true, change: { key: 'changelog', value: c.value.trim() } }
        : { ok: false, message: `shipshape.changelog "${c.value}" was not written: ${p.reason}.` }
    }
  }
}

async function run(o: { stack: string; service: string; changes: LabelChange[] }): Promise<SetServiceLabelResult> {
  const { stack, service } = o

  // The last word on each key, in the order given.
  const byKey = new Map<LabelKey, LabelChange>()
  for (const c of o.changes) byKey.set(c.key, c)
  if (byKey.size === 0) return { ok: false, message: 'Nothing was asked to change.' }
  const changes: LabelChange[] = []
  for (const c of byKey.values()) {
    const p = prepare(c)
    if (!p.ok) return { ok: false, message: p.message }
    changes.push(p.change)
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

  let next = original
  let removedPr = false
  for (const c of changes) {
    const edited = setLabel(next, service, `shipshape.${c.key}`, c.value)
    if (!edited.ok) return { ok: false, message: `${rel}: ${edited.reason}` }
    next = edited.text

    // Writing a policy while `shipshape.pr: on-request` stands would be silently inert:
    // tierFor lets the pr label win, so the service stays held whatever the new policy
    // says. Remove it in the same commit. (Removal of the policy itself leaves pr alone
    // -- that is a return to label-less defaults, not a statement about holds.)
    if (c.key === 'policy' && c.value !== null) {
      const second = setLabel(next, service, 'shipshape.pr', null)
      if (!second.ok) return { ok: false, message: `${rel}: ${second.reason}` }
      removedPr ||= second.text !== next
      next = second.text
    }
  }

  const verb = changes
    .map((c) => (c.value === null ? `shipshape.${c.key} removed` : `shipshape.${c.key}=${c.value}`))
    .join(', ')
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
    (l) => !/^[+-]\s*(shipshape\.(policy|watch|pr|source|changelog):|labels:\s*$)/.test(l),
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
