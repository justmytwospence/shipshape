import { join } from 'node:path'
import { execa } from 'execa'
import { canPublish, env } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { setLabel } from '../compose/edit.ts'
import { CLASS_LABELS } from '../policy.ts'
import { parseChangelogLabel, parseSourceLabel } from '../resolver/labels.ts'
import { commitCheckoutFile } from './policy-file.ts'
import { git, withGitLock } from './repo.ts'
import { syncMain } from './sync.ts'

/**
 * The write path for a service's labels: splice `shipshape.class`, `shipshape.watch`,
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

export type LabelKey = 'class' | 'watch' | 'source' | 'changelog'

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
    case 'class':
      return (CLASS_LABELS as readonly string[]).includes(c.value)
        ? { ok: true, change: c }
        : { ok: false, message: `"${c.value}" is not a class shipshape accepts (${CLASS_LABELS.join(', ')}).` }
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

  const row = getDb()
    .prepare(`SELECT compose_file FROM images WHERE stack = ? AND service = ?`)
    .get(stack, service) as { compose_file: string } | undefined
  if (!row) {
    return { ok: false, message: `No compose file is known for ${stack}/${service}.` }
  }
  const rel = row.compose_file
  const abs = join(env.repoDir, rel)

  const verb = changes
    .map((c) => (c.value === null ? `shipshape.${c.key} removed` : `shipshape.${c.key}=${c.value}`))
    .join(', ')
  let removedPr = false

  const result = await commitCheckoutFile({
    rel,
    message: `chore(shipshape): ${stack}/${service}: ${verb}`,
    mutate: (original) => {
      if (original === null) return { error: `Cannot read ${rel}: no such file` }
      let next = original
      for (const c of changes) {
        const edited = setLabel(next, service, `shipshape.${c.key}`, c.value)
        if (!edited.ok) return { error: `${rel}: ${edited.reason}` }
        next = edited.text

        // A leftover v1 label holds the service to ask whatever the class says, so writing a
        // class is the way out of that: remove them in the same commit.
        if (c.key === 'class' && c.value !== null) {
          for (const old of ['shipshape.policy', 'shipshape.pr']) {
            const second = setLabel(next, service, old, null)
            if (!second.ok) return { error: `${rel}: ${second.reason}` }
            removedPr ||= second.text !== next
            next = second.text
          }
        }
      }
      return next === original ? { unchanged: true } : { text: next }
    },
    gate: async () => {
      // Gate A: compose must still accept the file.
      const rejected = await composeRejects(abs)
      if (rejected !== null) return `Compose rejected the edited file, so it was restored: ${rejected}`

      // Gate B: the textual diff must contain nothing but shipshape label lines (plus the
      // bare `labels:` line when a block was created or emptied). Anything else means the
      // splice moved something it should not have.
      const diff = await git(env.repoDir, ['diff', '-U0', '--', rel], { allowFail: true })
      const changed = diff.stdout.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
      const offending = changed.filter(
        (l) => !/^[+-]\s*(shipshape\.(policy|class|watch|pr|source|changelog):|labels:\s*$)/.test(l),
      )
      if (changed.length === 0) return 'The edit produced no diff, so nothing was committed.'
      if (offending.length > 0) return `The edit touched a non-label line, so it was reverted: ${offending[0]!.slice(0, 120)}`
      return null
    },
  })
  if (!result.ok) return { ok: false, message: result.reason }
  if (!result.changed) return { ok: true, message: `${rel} already says ${verb}; nothing to commit.` }
  const sha = result.sha ?? ''

  // Publish, best-effort: the commit exists either way, and the regular sync cycle
  // retries. Unconfigured (tests, first run) means there is no origin to publish to.
  let publishNote = ''
  if (canPublish()) {
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
    ? ' Also removed the old shipshape.policy and shipshape.pr labels, which the class replaces.'
    : ''
  logEvent({
    level: 'info',
    kind: 'policy',
    stack,
    service,
    message: `${stack}/${service}: ${verb}`,
    detail: `committed ${sha}${removedPr ? ', removed shipshape.policy and shipshape.pr' : ''}`,
  })
  return {
    ok: true,
    sha,
    message: `${rel}: ${verb}, committed as ${sha}.${prNote}${publishNote}`,
  }
}

/**
 * `docker compose config` on an edited file; the reason when compose refuses it, null when
 * it is accepted or compose is not installed. `--no-interpolate` because validity of the
 * structure is the question, not whether every ${VAR} resolves right now. The probe first:
 * tests (and any host without the compose plugin) skip the gate rather than failing every
 * edit on a missing binary.
 */
export async function composeRejects(abs: string): Promise<string | null> {
  const probe = await execa('docker', ['compose', 'version'], { reject: false, timeout: 15_000 })
  if ((probe.exitCode ?? 1) !== 0) return null
  const cfg = await execa('docker', ['compose', '-f', abs, 'config', '--no-interpolate', '-q'], {
    reject: false,
    timeout: 60_000,
    cwd: env.repoDir,
  })
  return (cfg.exitCode ?? 1) === 0 ? null : String(cfg.stderr ?? '').slice(0, 200)
}
