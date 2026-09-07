import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from 'execa'
import { parse as parseYaml } from 'yaml'
import { applyOps, type Op } from './apply.ts'
import { canWrite, isStructured, type Boundary } from './paths.ts'

/**
 * Turning a set of operations into edited files on disk, or refusing to.
 *
 * Shared by the proposal path and the revision path, and that sharing is the point
 * rather than a tidy-up. Everything that makes a model-chosen edit safe happens here --
 * the boundary check on every target, the deterministic applier, the restore on a failed
 * parse. A second caller that reimplemented this would be a second enforcement path, and
 * a second enforcement path is how a boundary check quietly stops being applied to one
 * of them.
 *
 * Writes files; does not commit. The caller decides what a successful edit means.
 */

export interface ApplyRequest {
  /** The work clone. Never the live checkout. */
  repoDir: string
  ops: Op[]
  /** Where an operation that names no file goes. */
  composeFile: string
  /** The service an operation that names no service applies to. */
  service: string
  boundary: Boundary
  /** Services `applyOps` will accept, already resolved from the rung. */
  allowed: string[]
  selfStack: string
  /** Paths the operator has ruled out at every scope. */
  never: string[]
}

export type ApplyOutcome =
  | {
      ok: true
      /** Human-readable list of what changed, for the comment and the record. */
      changed: string[]
      /** file -> new text, for hunk rendering. */
      results: Map<string, string>
      /** file -> text as it was, for hunk rendering. */
      originals: Map<string, string>
    }
  | { ok: false; reason: string }

export function checkAndApply(req: ApplyRequest): ApplyOutcome {
  const { repoDir, composeFile, service, boundary, allowed, selfStack, never } = req

  // Grouped by the file each operation names; anything unnamed edits the compose file.
  // Every target is checked before a byte is written, so the permission is enforced here
  // rather than trusted from the model's output.
  const byFile = new Map<string, Op[]>()
  for (const op of req.ops) {
    const file = op.file ?? composeFile
    let peek: string | undefined
    try {
      peek = readFileSync(join(repoDir, file), 'utf8').slice(0, 8192)
    } catch {
      peek = undefined
    }
    const verdict = canWrite(file, boundary, selfStack, peek, never)
    if (!verdict.ok) return { ok: false, reason: verdict.reason }
    byFile.set(file, [...(byFile.get(file) ?? []), op])
  }

  const originals = new Map<string, string>()
  const results = new Map<string, string>()
  const changed: string[] = []

  for (const [file, ops] of byFile) {
    let text: string
    try {
      text = readFileSync(join(repoDir, file), 'utf8')
    } catch {
      return { ok: false, reason: `${file} does not exist` }
    }
    originals.set(file, text)
    const step = applyOps(text, service, ops, allowed)
    if (!step.ok) return { ok: false, reason: step.reason }
    results.set(file, step.text)
    changed.push(...step.changed.map((x) => (byFile.size > 1 ? `${file}: ${x}` : x)))
  }

  for (const [file, text] of results) writeFileSync(join(repoDir, file), text)

  const bad = firstUnparseable(results)
  if (bad) {
    for (const [file, text] of originals) writeFileSync(join(repoDir, file), text)
    return { ok: false, reason: bad }
  }

  return { ok: true, changed, results, originals }
}

/** Put every file back as it was. For a caller that failed a later gate. */
export function restore(repoDir: string, originals: Map<string, string>): void {
  for (const [file, text] of originals) writeFileSync(join(repoDir, file), text)
}

/**
 * Every structured file that was written must still parse.
 *
 * `docker compose config` only ever looked at the service's own compose file, so an edit
 * to a sibling -- which is the whole point of the wider rungs -- was committed with
 * nothing checking it at all. Compose cannot help there: it does not know the file
 * exists. Re-parsing is a weaker claim than "compose accepts this", but it is a claim
 * about the file that actually changed.
 */
function firstUnparseable(results: Map<string, string>): string | null {
  for (const [file, text] of results) {
    if (!isStructured(file)) continue
    try {
      if (/\.json$/i.test(file)) JSON.parse(text)
      else parseYaml(text)
    } catch (err) {
      return `${file} no longer parses: ${(err as Error).message.slice(0, 160)}`
    }
  }
  return null
}

/** Does compose still accept this file? Only meaningful for a compose file. */
export async function composeAccepts(
  repoDir: string,
  composeFile: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const r = await execa(
    'docker',
    ['compose', '-f', join(repoDir, composeFile), 'config', '--no-interpolate', '-q'],
    { reject: false, timeout: 60_000, cwd: repoDir },
  )
  return (r.exitCode ?? 1) === 0
    ? { ok: true }
    : { ok: false, reason: String(r.stderr ?? '').slice(0, 200) }
}

/** The service's own block, so the model sees its configuration and nothing else. */
export function blockFor(text: string, service: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((l) =>
    new RegExp(`^\\s{1,4}${service.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*$`).test(l),
  )
  if (start === -1) return text.slice(0, 4000)
  const indent = lines[start]!.match(/^\s*/)![0].length
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!
    if (!l.trim()) continue
    if (l.match(/^\s*/)![0].length <= indent) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}
