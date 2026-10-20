import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LineCounter, parseDocument, isScalar } from 'yaml'
import { env } from './config.ts'
import { getDb } from './db.ts'
import { formatImageRef, parseImageRef } from './images/ref.ts'

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

export type DiffResult = { hunks: DiffHunk[] } | { error: string }

const CONTEXT = 3

export function buildUpdateDiff(updateId: number): DiffResult {
  const row = getDb()
    .prepare(
      `SELECT u.stack, u.service, u.from_tag, u.to_tag, u.detail, i.compose_file, i.image_ref
       FROM updates u JOIN images i ON i.stack = u.stack AND i.service = u.service
       WHERE u.id = ?`,
    )
    .get(updateId) as
    | {
        stack: string
        service: string
        from_tag: string
        to_tag: string
        detail: string | null
        compose_file: string
        image_ref: string
      }
    | undefined

  if (!row) return { error: 'no such update' }

  // A rolling tag still reads `latest` after the image moves, so there is nothing in
  // git to change and nothing to diff.
  if (row.detail === 'rolling') {
    return {
      error:
        'Nothing changes in git — the compose file still reads the same rolling tag. ' +
        'Redeploy the service to adopt the new image.',
    }
  }

  // A fork's `image:` is the local build, not the upstream the update is about; the
  // change it needs is a rebase of the fork, or its retirement, neither of which is an
  // image line (FORKS.md).
  if (row.detail === 'fork') {
    return {
      error:
        'Nothing to change in git — this service runs its own build of the upstream image. ' +
        'Rebase the fork onto the new release, or retire it; see FORKS.md.',
    }
  }

  const abs = join(env.repoDir, row.compose_file)
  let src: string
  try {
    src = readFileSync(abs, 'utf8')
  } catch (err) {
    return { error: `cannot read ${row.compose_file}: ${(err as Error).message}` }
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
