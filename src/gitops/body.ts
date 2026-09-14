import type { Policy } from '../config.ts'
import type { UpdateGroup } from '../groups.ts'
import { parseImageRef, displayName } from '../images/ref.ts'
import { refLinks } from '../links.ts'
import { foldGroupMagnitude, foldGroupTier, type EffectiveTier } from '../policy.ts'
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

export function prBody(
  g: UpdateGroup,
  policy: Policy,
  sources: Map<number, string | null>,
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
    policy.claude.mode === 'off'
      ? '_Changelog analysis is disabled._'
      : '_Changelog analysis has not run yet._'

  return `**${magnitude}** update · policy rung \`${tier}\`
${grouped}
| Service | Image | From | To |
|---|---|---|---|
${rows}

${referenceSection(g, sources)}

<!-- shipshape:verdict:start -->
### Changelog analysis

${analysis}
<!-- shipshape:verdict:end -->

---
<sub>Opened by [shipshape](https://github.com/justmytwospence/shipshape). Merging this deploys the change on the host.</sub>
<!-- shipshape: stack=${m0.stack} services=${g.members.map((m) => m.service).join(',')} from=${m0.from_tag} to=${m0.to_tag} -->`
}
