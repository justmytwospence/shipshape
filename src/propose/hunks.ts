import type { DiffHunk, DiffLine } from '../diff.ts'

/**
 * The proposal's own diff, built at the moment it is applied.
 *
 * Computed here rather than fetched from GitHub later: at apply time both texts are in
 * hand and exact, whereas reconstructing the diff afterwards means another API call
 * that can disagree with what was actually committed.
 *
 * The comparison is line-based and anchored on the unchanged lines around each edit,
 * which is all that is needed — the applier only ever inserts, deletes, or rewrites
 * whole lines.
 */
const CONTEXT = 3

export function proposalHunks(before: string, after: string, file: string): DiffHunk[] {
  const a = before.split('\n')
  const b = after.split('\n')

  // Longest common subsequence over lines, then walk it to label each line.
  const changed = markChanged(a, b)
  const hunks: DiffHunk[] = []
  let i = 0

  while (i < changed.length) {
    if (!changed[i]!.changed) {
      i++
      continue
    }
    const start = i
    let end = i
    // Absorb nearby edits into one hunk rather than emitting a run of tiny ones.
    while (end < changed.length) {
      const next = changed.findIndex((c, k) => k > end && c.changed)
      if (next === -1 || next - end > CONTEXT * 2) break
      end = next
    }
    const from = Math.max(0, start - CONTEXT)
    const to = Math.min(changed.length - 1, end + CONTEXT)
    const lines: DiffLine[] = []
    for (let k = from; k <= to; k++) {
      const c = changed[k]!
      // `no` is the line's position in the OLD file, which an inserted line has not
      // got. `oldNo` is only the anchor used to build the hunk header.
      lines.push({ kind: c.kind, no: c.no, text: c.text })
    }
    const oldStart = changed[from]!.oldNo ?? 1
    hunks.push({ file, header: `@@ -${oldStart},${to - from + 1} @@`, lines })
    i = to + 1
  }
  return hunks
}

interface Marked {
  kind: 'ctx' | 'del' | 'add'
  no: number | null
  oldNo: number | null
  text: string
  changed: boolean
}

function markChanged(a: string[], b: string[]): Marked[] {
  const lcs = lcsTable(a, b)
  const out: Marked[] = []
  let i = 0
  let j = 0
  let oldNo = 1
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'ctx', no: oldNo, oldNo, text: a[i]!, changed: false })
      i++
      j++
      oldNo++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: 'del', no: oldNo, oldNo, text: a[i]!, changed: true })
      i++
      oldNo++
    } else {
      out.push({ kind: 'add', no: null, oldNo, text: b[j]!, changed: true })
      j++
    }
  }
  while (i < a.length) {
    out.push({ kind: 'del', no: oldNo, oldNo, text: a[i]!, changed: true })
    i++
    oldNo++
  }
  while (j < b.length) {
    out.push({ kind: 'add', no: null, oldNo, text: b[j]!, changed: true })
    j++
  }
  return out
}

/** Standard LCS lengths, built from the end so the walk above can read it forwards. */
function lcsTable(a: string[], b: string[]): number[][] {
  const t: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      t[i]![j] = a[i] === b[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!)
    }
  }
  return t
}
