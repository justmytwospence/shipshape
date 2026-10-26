import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LineCounter, parseDocument, isScalar } from 'yaml'
import { env } from './config.ts'
import { getDb } from './db.ts'
import { bumpFork, retireFork } from './compose/fork-edit.ts'
import { forkConflictFor, forkPreparedFor, type ForkPrepared } from './forks.ts'
import { formatImageRef, parseImageRef } from './images/ref.ts'
import { rewriteFroms } from './compose/dockerfile.ts'

/**
 * The exact one-line change a PR for this update would contain, rendered as a diff.
 *
 * Read-only and independent of the M2 editor, but deliberately the same operation:
 * locate `services.<service>.image` through the YAML CST and touch nothing else. If
 * this preview ever shows more than a single replaced line, the editor would too, and
 * that is a bug worth seeing before a PR exists rather than after.
 */

export interface DiffLine {
  kind: 'ctx' | 'del' | 'add'
  /** 1-based line in the file; null for the inserted line, which has no old position. */
  no: number | null
  text: string
}

export interface DiffHunk {
  file: string
  header: string
  lines: DiffLine[]
}

/** What a fork's change carries beyond its hunks (FORKS.md): the replay and its commits. */
export type ForkChange = Pick<ForkPrepared, 'kind' | 'sha' | 'tag' | 'forkUrl' | 'upstreamRef' | 'carried' | 'dropped' | 'waitsOn'>

export type DiffResult = { hunks: DiffHunk[]; fork?: ForkChange } | { error: string }

const CONTEXT = 3

export function buildUpdateDiff(updateId: number): DiffResult {
  const row = getDb()
    .prepare(
      `SELECT u.stack, u.service, u.image, u.from_tag, u.to_tag, u.detail, i.compose_file, i.image_ref,
              i.base_dockerfile
       FROM updates u JOIN images i ON i.stack = u.stack AND i.service = u.service
       WHERE u.id = ?`,
    )
    .get(updateId) as
    | {
        stack: string
        service: string
        from_tag: string
        to_tag: string
        image: string
        detail: string | null
        compose_file: string
        image_ref: string
        base_dockerfile: string | null
      }
    | undefined

  if (!row) return { error: 'no such update' }

  // Our own build, watched through its base: the change is the Dockerfile's FROM line.
  if (row.base_dockerfile) return baseDiff({ ...row, base_dockerfile: row.base_dockerfile })

  // A rolling tag still reads `latest` after the image moves, so there is nothing in
  // git to change and nothing to diff.
  if (row.detail === 'rolling') {
    return {
      error:
        'Nothing changes in git — the compose file still reads the same rolling tag. ' +
        'Redeploy the service to adopt the new image.',
    }
  }

  const abs = join(env.repoDir, row.compose_file)
  let src: string
  try {
    src = readFileSync(abs, 'utf8')
  } catch (err) {
    return { error: `cannot read ${row.compose_file}: ${(err as Error).message}` }
  }

  // A fork's change is the replay of our fixes onto the new release and the compose edit
  // that pins the result -- known once the pull request pass has made the replay (FORKS.md).
  if (row.detail === 'fork' || isForkService(row.stack, row.service)) {
    return forkDiff(row, src)
  }

  const located = locateImageLine(src, row.service)
  if ('error' in located) return located

  // Assert the file still holds what this update was computed against, before deriving
  // anything from it. Without this a stale row renders a plausible-looking diff that
  // proposes a DOWNGRADE: the row's from_tag is replaced into whatever the file happens
  // to say now. The M2 editor makes the identical assertion before splicing bytes.
  const expectedOld = rewriteRef(row.image_ref, row.from_tag)
  if (expectedOld !== located.value) {
    return {
      error:
        `line ${located.line} now reads "${located.value}", but this update was computed ` +
        `against "${expectedOld}" — rescan to refresh it`,
    }
  }

  const newRef = rewriteRef(row.image_ref, row.to_tag)
  if (!newRef) return { error: `cannot build the new reference from "${row.to_tag}"` }

  const lines = src.split('\n')
  const idx = located.line - 1
  const current = lines[idx] ?? ''

  // Preserve the original indentation and key spelling; only the value changes.
  const replaced = current.replace(located.value, newRef)
  if (replaced === current) {
    return { error: `could not rewrite the reference on line ${located.line}` }
  }

  const from = Math.max(0, idx - CONTEXT)
  const to = Math.min(lines.length - 1, idx + CONTEXT)
  const out: DiffLine[] = []
  for (let i = from; i < idx; i++) out.push({ kind: 'ctx', no: i + 1, text: lines[i] ?? '' })
  out.push({ kind: 'del', no: idx + 1, text: current })
  out.push({ kind: 'add', no: null, text: replaced })
  for (let i = idx + 1; i <= to; i++) out.push({ kind: 'ctx', no: i + 1, text: lines[i] ?? '' })

  const span = to - from + 1
  return {
    hunks: [
      {
        file: row.compose_file,
        header: `@@ -${from + 1},${span} +${from + 1},${span} @@ ${row.service}`,
        lines: out,
      },
    ],
  }
}

function isForkService(stack: string, service: string): boolean {
  const r = getDb()
    .prepare(`SELECT fork_upstream FROM images WHERE stack = ? AND service = ?`)
    .get(stack, service) as { fork_upstream: string | null } | undefined
  return !!r?.fork_upstream
}

/**
 * The fork's change, rendered from the last replay the pull request pass recorded for this
 * target: the same editor the branch was built with, run against the file as it is now, so
 * what is shown is exactly what the branch carries. Before a replay there is nothing to
 * show but what will happen; a conflict says why nothing has.
 */
function forkDiff(
  row: { stack: string; service: string; from_tag: string; to_tag: string; compose_file: string },
  src: string,
): DiffResult {
  const target = row.to_tag.split('@')[0]!
  const conflict = forkConflictFor(row.stack, row.service)
  if (conflict && conflict.toTag === target) {
    return {
      error:
        `The fork's fixes could not be replayed onto ${target}: ${conflict.detail}. ` +
        `Nothing was pushed and no pull request opened. Rebase the fork's homelab branch by hand and move the pinned sha, or drop the commit (FORKS.md).`,
    }
  }
  const prepared = forkPreparedFor(row.stack, row.service)
  if (!prepared || prepared.toTag !== target) {
    return {
      error:
        `This service is a fork of its upstream image. When the pull request opens, shipshape replays the fork's ` +
        `fixes onto ${target}, pushes the result to the fork, and moves the build pin, the image tag and the upstream ` +
        `reference here; the exact commit and the fixes it carries are shown once that has happened (FORKS.md).`,
    }
  }
  const edit =
    prepared.kind === 'retire'
      ? retireFork(src, row.service, { expectedSha: prepared.fromSha, upstreamRef: prepared.upstreamRef })
      : bumpFork(src, row.service, {
          expectedSha: prepared.fromSha,
          newSha: prepared.sha ?? '',
          newTag: target,
          newUpstream: prepared.upstreamRef,
        })
  const fork: ForkChange = {
    kind: prepared.kind,
    sha: prepared.sha,
    tag: prepared.tag,
    forkUrl: prepared.forkUrl,
    upstreamRef: prepared.upstreamRef,
    carried: prepared.carried,
    dropped: prepared.dropped,
    waitsOn: prepared.waitsOn,
  }
  if (!edit.ok) {
    if (edit.alreadyApplied) return { hunks: [], fork }
    return { error: `${row.compose_file}: ${edit.reason} — rescan to refresh it` }
  }
  return { hunks: lineDiff(row.compose_file, src, edit.text, row.service), fork }
}

/**
 * A base image's change: the Dockerfile's `FROM` lines naming the base, moved to the new
 * one, by the same editor the branch is built with (compose/dockerfile.ts). A digest pin
 * is kept, so a version bump on a pinned base needs the new tag's digest; this reads the
 * one the scan saw, and says so when it has none rather than showing an unpinned line the
 * branch would never carry.
 */
function baseDiff(row: { stack: string; service: string; image: string; to_tag: string; base_dockerfile: string }): DiffResult {
  let src: string
  try {
    src = readFileSync(join(env.repoDir, row.base_dockerfile), 'utf8')
  } catch (err) {
    return { error: `cannot read ${row.base_dockerfile}: ${(err as Error).message}` }
  }
  const ref = parseImageRef(row.image)
  let next: string | null
  if (row.to_tag.includes('@') || !ref.digest) next = rewriteRef(row.image, row.to_tag)
  else {
    const seen = getDb()
      .prepare(`SELECT digest FROM tags_seen WHERE registry = ? AND repository = ? AND tag = ?`)
      .get(ref.registry, ref.repository, row.to_tag) as { digest: string | null } | undefined
    if (!seen?.digest) {
      return {
        error:
          `${row.base_dockerfile} pins its base by digest. The pull request looks up the digest of ` +
          `${row.to_tag} when it opens and moves the FROM line to it; nothing else changes.`,
      }
    }
    next = formatImageRef(ref, row.to_tag, seen.digest)
  }
  if (!next) return { error: `cannot build the new reference from "${row.to_tag}"` }
  const edit = rewriteFroms(src, row.image, next)
  if (!edit.ok) {
    if (edit.alreadyApplied) return { hunks: [] }
    return { error: `${row.base_dockerfile}: ${edit.reason} — rescan to refresh it` }
  }
  return { hunks: lineDiff(row.base_dockerfile, src, edit.text, row.service) }
}

/**
 * Hunks between two texts, by line. The fork edit touches a handful of lines and removes
 * a block, so a plain longest-common-subsequence over lines is enough and exact.
 */
export function lineDiff(file: string, before: string, after: string, label: string): DiffHunk[] {
  const a = before.split('\n')
  const b = after.split('\n')
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs: Uint16Array[] = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  type Op = { kind: 'ctx' | 'del' | 'add'; no: number | null; text: string }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ kind: 'ctx', no: i + 1, text: a[i]! })
      i++
      j++
    } else if (j < b.length && (i >= a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      ops.push({ kind: 'add', no: null, text: b[j]! })
      j++
    } else {
      ops.push({ kind: 'del', no: i + 1, text: a[i]! })
      i++
    }
  }

  // Group changes that sit within 2*CONTEXT lines of each other into one hunk.
  const hunks: DiffHunk[] = []
  let k = 0
  while (k < ops.length) {
    if (ops[k]!.kind === 'ctx') {
      k++
      continue
    }
    const start = Math.max(0, k - CONTEXT)
    let end = k
    let last = k
    while (end < ops.length) {
      if (ops[end]!.kind !== 'ctx') last = end
      else if (end - last > 2 * CONTEXT) break
      end++
    }
    const stop = Math.min(ops.length, last + CONTEXT + 1)
    const slice = ops.slice(start, stop)
    const oldStart = slice.find((o) => o.no !== null)?.no ?? 1
    const oldLen = slice.filter((o) => o.kind !== 'add').length
    const newLen = slice.filter((o) => o.kind !== 'del').length
    // The new-side start: old start shifted by the net lines added before this hunk.
    const before = ops.slice(0, start)
    const shift = before.filter((o) => o.kind === 'add').length - before.filter((o) => o.kind === 'del').length
    hunks.push({
      file,
      header: `@@ -${oldStart},${oldLen} +${oldStart + shift},${newLen} @@ ${label}`,
      lines: slice.map((o) => ({ kind: o.kind, no: o.no, text: o.text })),
    })
    k = stop
  }
  return hunks
}

/**
 * Find the `image:` scalar belonging to one service.
 *
 * Scoped through the document tree rather than by searching text: several services in
 * this repo carry byte-identical image lines (three `postgres:13.2` sidecars), and a
 * whole-file match would happily rewrite the wrong one.
 */
function locateImageLine(
  src: string,
  service: string,
): { line: number; value: string } | { error: string } {
  const lineCounter = new LineCounter()
  let doc
  try {
    doc = parseDocument(src, { lineCounter, keepSourceTokens: true })
  } catch (err) {
    return { error: `cannot parse YAML: ${(err as Error).message}` }
  }

  const node = doc.getIn(['services', service, 'image'], true)
  if (!node || !isScalar(node) || typeof node.value !== 'string') {
    return { error: `no image: found for service "${service}"` }
  }
  const range = node.range
  if (!range) return { error: 'image value has no source range' }

  return { line: lineCounter.linePos(range[0]).line, value: node.value }
}

/**
 * Build the replacement reference. `to_tag` is a plain tag for version bumps and
 * `<tag>@sha256:...` for digest bumps, so both shapes are handled by re-parsing.
 */
function rewriteRef(currentRef: string, toTag: string): string | null {
  const ref = parseImageRef(currentRef)
  const at = toTag.indexOf('@')
  if (at === -1) return formatImageRef(ref, toTag, null)
  const tag = toTag.slice(0, at) || ref.tag
  return formatImageRef(ref, tag, toTag.slice(at + 1))
}
