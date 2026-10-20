import type { Policy } from '../config.ts'
import type { UpdateGroup } from '../groups.ts'
import { parseImageRef, displayName } from '../images/ref.ts'
import { refLinks } from '../links.ts'
import { foldGroupMagnitude, foldGroupTier, reviewMode, type EffectiveTier } from '../policy.ts'
import type { Magnitude } from '../versions/patterns.ts'

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

/** Digest refs are unreadable at full length; keep the tag and 12 hex. */
export function short(ref: string): string {
  const at = ref.indexOf('@sha256:')
  return at === -1 ? ref : `${ref.slice(0, at)}@${ref.slice(at + 8, at + 20)}`
}

/**
 * The versions a set of updates moves between, as one line: `1.37.2 -> 1.37.3`.
 *
 * One function, so the line a pull request opened with, the line it was retargeted with
 * and the line its deploy records cannot drift apart. They were three hand-written
 * template strings once, and the deploy's said something else entirely -- "jackett up in
 * 47s" -- which answers how long it took when the reader wanted to know what landed.
 *
 * A group whose members all move between the same two tags is written once, after their
 * names, because that is what a group almost always is. Members on different tags are
 * each written out: folding them onto the first member's tags would state a version one
 * of them never ran. `named` puts the service in front of a lone update too, for the
 * places that have nothing else saying which service it is.
 */
export function changeText(
  members: readonly { service: string; from_tag: string; to_tag: string }[],
  opts: { named?: boolean } = {},
): string | null {
  const m = members[0]
  if (!m) return null
  const shared = members.every((x) => x.from_tag === m.from_tag && x.to_tag === m.to_tag)
  if (shared) {
    const arrow = `${short(m.from_tag)} -> ${short(m.to_tag)}`
    if (members.length === 1) return `${opts.named ? `${m.service} ` : ''}${arrow}`
    return `${members.map((x) => x.service).join(', ')} ${arrow}`
  }
  return members.map((x) => `${x.service} ${short(x.from_tag)} -> ${short(x.to_tag)}`).join(', ')
}

/** `[text](url)`, or bare text when there is no URL worth pointing at. */
function link(text: string, url: string | null): string {
  return url ? `[${text}](${url})` : text
}

/**
 * What the reviewer needs to read, that the table above does not already link.
 *
 * The judgement being asked for is "is this version safe to run here", and answering it
 * means reading the release notes and often the image's own documentation. Making that a
 * click rather than a search is most of what a pull request offers over a notification.
 *
 * Deliberately excludes the registry and per-tag pages: the table's Image and To cells
 * are already those links, and a reference list that restates them is decoration. What is
 * left is exactly the reading -- notes, project, docs -- which is what makes the heading
 * honest.
 *
 * Only links that resolve are emitted; refLinks returns null wherever a registry serves
 * no page for something rather than guessing a URL that 404s. An unresolved upstream is
 * stated rather than omitted: it means the changelog verdict had nothing authoritative to
 * read, which changes how much weight the verdict deserves.
 */
function referenceSection(g: UpdateGroup, sources: Map<number, string | null>): string {
  const lines: string[] = ['### Reference', '']

  for (const m of g.members) {
    const ref = parseImageRef(m.image)
    const source = sources.get(m.id) ?? null
    const l = refLinks(ref, m.to_tag, source)

    const parts: string[] = []
    if (l.releases) parts.push(link(`release notes for \`${short(m.to_tag)}\``, l.releases))
    if (l.source) parts.push(link('project', l.source))
    if (l.docs) parts.push(link('image docs', l.docs))

    const head = g.members.length > 1 ? `**${m.service}** — ` : ''
    lines.push(
      parts.length > 0
        ? `- ${head}${parts.join(' · ')}`
        : `- ${head}nothing to read: no documentation is published at a known address for \`${displayName(ref)}\``,
    )
    if (!source) {
      lines.push(
        `  <sub>No upstream repository resolved for this image, so the review had no release notes to read. ` +
          `A \`shipshape.source\` label on the service fixes that permanently -- shipshape's page for the service previews and writes one.</sub>`,
      )
    }
  }

  return lines.join('\n')
}

/**
 * What a fork's pull request carries beyond the version (FORKS.md): the replay that was
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
          `The \`homelab\` branch on the fork can go once this is merged (FORKS.md, "Retiring a fork").`,
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

export function prBody(
  g: UpdateGroup,
  policy: Policy,
  sources: Map<number, string | null>,
  forks: Map<number, ForkPrInfo> = new Map(),
): string {
  const m0 = g.members[0]!
  const magnitude = foldGroupMagnitude(g.members.map((m) => m.magnitude as Magnitude))
  const tier = foldGroupTier(g.members.map((m) => m.tier as EffectiveTier))

  // The image and the target tag carry their own links, so the table is navigable
  // without repeating every URL underneath it. The tag being left behind gets none:
  // there is nothing to read about the version you already ran.
  const rows = g.members
    .map((m) => {
      const ref = parseImageRef(m.image)
      const l = refLinks(ref, m.to_tag, sources.get(m.id) ?? null)
      return `| \`${m.service}\` | ${link(`\`${displayName(ref)}\``, l.image)} | \`${short(m.from_tag)}\` | ${link(`\`${short(m.to_tag)}\``, l.tag)} |`
    })
    .join('\n')

  const grouped =
    g.members.length > 1
      ? `\n> These services are pinned to the same version upstream and are bumped together —\n> merging them separately would leave the stack running mismatched versions.\n`
      : ''

  const analysis =
    reviewMode(policy) === 'off'
      ? '_Changelog analysis is disabled._'
      : '_Changelog analysis has not run yet._'

  return `**${magnitude}** update · policy rung \`${tier}\`
${grouped}
| Service | Image | From | To |
|---|---|---|---|
${rows}

${referenceSection(g, sources)}
${forks.size > 0 ? `\n${carriedFixesSection(g, forks)}\n` : ''}
<!-- shipshape:verdict:start -->
### Changelog analysis

${analysis}
<!-- shipshape:verdict:end -->

---
<sub>Opened by [shipshape](https://github.com/justmytwospence/shipshape). Merging this deploys the change on the host.</sub>
<!-- shipshape: stack=${m0.stack} services=${g.members.map((m) => m.service).join(',')} from=${m0.from_tag} to=${m0.to_tag} -->`
}
