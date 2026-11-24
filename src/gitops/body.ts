import { type UpdateGroup } from '../groups.ts'
import { FORKS_GUIDE_URL } from '../links.ts'
import { short, changeText } from '../updates/vocabulary.ts'
import { getDb } from '../db.ts'
import { parseImageRef, displayName } from '../images/ref.ts'
import { type UpdateHolds } from '../updates/holds.ts'

/**
 * What a pull request says.
 *
 * Rendering only, in its own module, with the resolved upstreams passed in rather than
 * looked up. Two reasons, and the second is the real one:
 *
 * 1. It is testable without a database, a GitHub token, or a network -- the body is the
 *    thing a human reads to decide whether to merge, so it is worth asserting on.
 * 2. It cannot silently read a cache that has not been filled yet. The resolution cache
 *    is populated by analysis, which runs *after* the pull request opens; a renderer free
 *    to reach for it would quietly print "no upstream resolved" on almost every pull
 *    request. Making the caller supply the answer forces that resolution to happen
 *    somewhere it can be awaited.
 */


/**
 * What a fork's pull request carries beyond the version (the forks guide): the replay that was
 * pushed to the fork, the commits it kept, the ones it dropped as already upstream, and
 * where each reference the fork waits on stands. A `retire` has no replay: the fork is
 * replaced by the plain upstream image.
 */
export interface ForkPrInfo {
  kind: 'bump' | 'retire'
  /** The pin the file carried before. */
  fromSha: string
  /** The replayed commit and its tag on the fork, for a bump. */
  sha: string | null
  tag: string | null
  /** The fork repository, as `build.context` names it. */
  forkUrl: string
  /** The upstream reference the file moves to: `shipshape.fork.upstream` (bump) or `image:` (retire). */
  upstreamRef: string
  carried: { sha: string; short: string; subject: string; author: string }[]
  dropped: { sha: string; short: string; subject: string; author: string; reason: string }[]
  waitsOn: { ref: string; state: string; releasedIn: string | null }[]
}

/** The fork repository's web address, for linking a commit, when it is on GitHub. */
function forkWeb(forkUrl: string): string | null {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(forkUrl)
  return m ? `https://github.com/${m[1]}` : null
}

function waitsOnLine(w: ForkPrInfo['waitsOn'][number]): string {
  const url = /^([^#]+)#(\d+)$/.exec(w.ref)
  const name = url ? `[${w.ref}](https://github.com/${url[1]}/issues/${url[2]})` : w.ref
  const state =
    w.state === 'released'
      ? `released in ${w.releasedIn}`
      : w.state === 'merged-unreleased'
        ? 'merged, not released'
        : w.state === 'closed-unfixed'
          ? 'closed without a fix'
          : w.state === 'open'
            ? 'open'
            : 'could not be looked up'
  return `- ${name}: ${state}`
}

/**
 * The section a fork's pull request adds. Each commit kept, each dropped and why, and the
 * waits-on states, so the person merging can see what the new build still carries. A
 * retire says what the fork is replaced with and flags the comment block, which
 * shipshape does not rewrite.
 */
export function carriedFixesSection(g: UpdateGroup, forks: Map<number, ForkPrInfo>): string {
  const lines: string[] = []
  for (const m of g.members) {
    const f = forks.get(m.id)
    if (!f) continue
    const web = forkWeb(f.forkUrl)
    const commit = (c: { sha: string; short: string; subject: string; author: string }) =>
      `${web ? `[\`${c.short}\`](${web}/commit/${c.sha})` : `\`${c.short}\``} ${c.subject} — ${c.author}`
    const head = g.members.length > 1 ? ` — ${m.service}` : ''
    if (f.kind === 'retire') {
      lines.push(`### Retiring the fork${head}`, '')
      lines.push(
        `Nothing is left to carry: every fix the fork had is in upstream \`${short(m.to_tag)}\`. ` +
          `This puts the plain upstream image back (\`${f.upstreamRef}\`) and removes the \`build:\` block and the \`shipshape.fork.*\` labels.`,
        '',
      )
      if (f.dropped.length > 0) {
        lines.push('Dropped, already upstream:', '', ...f.dropped.map((c) => `- ${commit(c)} — ${c.reason}`), '')
      }
      lines.push(
        `> **Tidy the comment block by hand.** The service's comment still describes the fork; shipshape does not rewrite prose. ` +
          `The branch shipshape pushed to the fork (\`forks.branch\`) can go once this has shipped: ${FORKS_GUIDE_URL}#retiring-a-fork.`,
        '',
      )
      continue
    }
    lines.push(`### Carried fixes${head}`, '')
    lines.push(
      `Our fixes were replayed onto upstream \`${short(m.to_tag)}\` and pushed to the fork as ` +
        `${web && f.sha ? `[\`${f.tag}\`](${web}/commit/${f.sha})` : `\`${f.tag}\``} ` +
        `(\`${f.sha?.slice(0, 7)}\`, was \`${f.fromSha.slice(0, 7)}\`). The build pins that commit.`,
      '',
    )
    lines.push(f.carried.length > 0 ? 'Kept:' : 'Kept: nothing', '')
    if (f.carried.length > 0) lines.push(...f.carried.map((c) => `- ${commit(c)}`), '')
    if (f.dropped.length > 0) {
      lines.push('Dropped, already upstream:', '', ...f.dropped.map((c) => `- ${commit(c)} — ${c.reason}`), '')
    }
    if (f.waitsOn.length > 0) lines.push('Waiting on:', '', ...f.waitsOn.map(waitsOnLine), '')
  }
  return lines.join('\n').trimEnd()
}

/**
 * Our own build, watched through its base image (compose/dockerfile.ts): which Dockerfile
 * the pull request edits, and the `FROM` it moves.
 */
export interface BasePrInfo {
  /** Relative to the repository root. */
  dockerfile: string
  fromRef: string
  toRef: string
  /** How many `FROM` lines named the base: a builder stage on the same image moves too. */
  lines: number
}

/**
 * The section a base-image pull request adds: the image is ours, built here, so the
 * version in the table is the base's, and merging rebuilds rather than pulls.
 */
export function baseImageSection(g: UpdateGroup, bases: Map<number, BasePrInfo>): string {
  const lines: string[] = []
  for (const m of g.members) {
    const b = bases.get(m.id)
    if (!b) continue
    const head = g.members.length > 1 ? ` — ${m.service}` : ''
    lines.push(`### Base image${head}`, '')
    lines.push(
      `\`${m.service}\` is built here from \`${b.dockerfile}\`. This moves ` +
        `${b.lines === 1 ? 'its final stage' : `the ${b.lines} stages built`} on ` +
        `\`${short(b.fromRef)}\` to \`${short(b.toRef)}\`, and nothing else. ` +
        `Merging rebuilds the image on the new base and deploys it; a rollback reverts the line and rebuilds on the old one.`,
      '',
    )
  }
  return lines.join('\n').trimEnd()
}

/** The local branch a group ships from. Never pushed. */
export function shipBranchFor(g: UpdateGroup): string {
  if (g.branchKey?.endsWith('--decision')) return `shipshape/${g.branchKey}-${g.members[0]!.id}`.slice(0, 120)
  const base = g.members.length > 1 ? g.members[0]!.stack + '--group' : `${g.members[0]!.stack}--${g.members[0]!.service}`
  const tag = g.members[0]!.to_tag.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return `shipshape/${base}--${tag}`.slice(0, 120)
}


/** The merge commit's body: what moved, what the review said, what waived a hold. */
export function commitBody(
  group: UpdateGroup,
  built: { forks: Map<number, ForkPrInfo>; bases: Map<number, BasePrInfo> },
  statuses: UpdateHolds[],
): string {
  const lines: string[] = []
  for (const m of group.members) {
    lines.push(`- ${m.stack}/${m.service}: ${short(m.from_tag)} -> ${short(m.to_tag)} (${m.magnitude})`)
  }
  const v = getDb()
    .prepare(`SELECT recommendation, confidence, summary FROM verdicts WHERE image = ? AND from_tag = ? AND to_tag = ? AND error IS NULL`)
    .get(group.members[0]!.image, group.members[0]!.from_tag, group.members[0]!.to_tag) as
    | { recommendation: string | null; confidence: string | null; summary: string | null }
    | undefined
  if (v?.recommendation) {
    lines.push('', `Review: ${v.recommendation} (${v.confidence ?? 'unknown'} confidence)`)
    if (v.summary) lines.push(v.summary.replace(/\s+/g, ' ').trim().slice(0, 600))
  }
  const rules = [...new Set(statuses.flatMap((s) => s.waived.map((h) => h.waivedBy!)))]
  if (rules.length > 0) lines.push('', `Shipped under rule ${rules.join(', ')}.`)
  if (statuses.some((s) => s.row.approved_at)) lines.push('', 'Approved by the operator.')
  if (built.forks.size > 0) lines.push('', carriedFixesSection(group, built.forks))
  if (built.bases.size > 0) lines.push('', baseImageSection(group, built.bases))
  return lines.join('\n')
}



/** The group and its versions, named even when it is one service. See `changeText`. */
export function describe(g: UpdateGroup): string {
  return changeText(g.members, { named: true }) ?? ''
}


export function changeTitle(g: UpdateGroup, forks?: Map<number, ForkPrInfo>, bases?: Map<number, BasePrInfo>): string {
  const m = g.members[0]!
  const names = g.members.map((x) => x.service).join(', ')
  // A stack shipped from one card: each service names its own move.
  if (new Set(g.members.map((x) => `${x.from_tag}|${x.to_tag}`)).size > 1) {
    const moves = g.members.map((x) => `${x.service} ${short(x.from_tag)} -> ${short(x.to_tag)}`).join(', ')
    return `chore(deps): ${m.stack}: bump ${moves}`
  }
  // A retire is still a version change, but "bump" would undersell what the diff does.
  if (forks && g.members.every((x) => forks.get(x.id)?.kind === 'retire')) {
    return `chore(deps): ${m.stack}: retire the ${names} fork, back to upstream ${short(m.to_tag)}`
  }
  // The version in the title is the base's, so the title says it is the base that moves:
  // "bump obsidian-sync 22-slim -> 24-slim" would read as a release of obsidian-sync.
  if (bases && g.members.every((x) => bases.has(x.id))) {
    const base = displayName(parseImageRef(m.image))
    return `chore(deps): ${m.stack}: rebuild ${names} on ${base} ${short(m.from_tag)} -> ${short(m.to_tag)}`
  }
  return `chore(deps): ${m.stack}: bump ${names} ${short(m.from_tag)} -> ${short(m.to_tag)}`
}
