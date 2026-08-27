import type { FC } from 'hono/jsx'
import { Change, EmptyState, MagnitudeBadge, Relative, ServiceName, VerdictChip } from './parts.tsx'
import type { ReleaseView } from '../../../updates/queries.ts'

/**
 * The same updates, read rather than worked.
 *
 * Every other list here answers "what is in my way". This one answers "what came out",
 * which is a different question with different consequences: recency instead of the
 * triage order, every release instead of a slice of the pipeline, and the review's own
 * words on the row instead of behind a click. A worklist is scanned for the one thing
 * that needs a decision; a feed is read top to bottom, so the summary has to be what the
 * eye lands on rather than something a click reveals.
 *
 * No min-w-0 on the row's link: it cancels `.tap`'s 44px min-width, and a short service
 * name like "n8n" then renders a 23px tap target -- too small to hit and flagged by the
 * shot probes. Truncation is ServiceName's own job (it wraps its text in a `truncate`
 * span), so the anchor never needs to shrink below its content to get it.
 *
 * The row is deliberately not an anchor, which every other row in this app is. This one
 * carries outbound links to the changelog, and an anchor inside an anchor is invalid HTML
 * that browsers resolve by closing the outer one early -- so the service name is the link
 * into the pane and the changelog links stand on their own.
 */

/**
 * Most releases have no review, and that is the design rather than a gap to apologise
 * for: reviews are written against pull requests, and an update that applies without one
 * never has a pull request to write against. Saying so plainly beats an empty space, and
 * the links below still lead somewhere -- they are derived from the image reference and
 * the resolved source repository, not from any analysis, so they exist whether or not
 * anything ever read this release. The copy does not promise a changelog, because for an
 * image with no resolved project the only honest link is its registry.
 */
const NO_REVIEW = 'No review — this applied without a pull request.'

/*
 * inline-flex, not inline: `.tap` works by min-height, and an inline box ignores it. As
 * plain inline links these were 15 sub-44px touch targets on a phone, which the shot
 * probes flag and a thumb finds the hard way.
 */
const LINK = 'link link-hover tap inline-flex items-center'

export const ReleaseRow: FC<{
  release: ReleaseView
  /** The query that names the list this row lives in, so the URL can carry it. */
  ctx: string
  selected?: boolean
}> = ({ release, ctx, selected }) => {
  const href = `/updates/${release.id}`
  const summary = release.verdict?.summary ?? null
  const l = release.links
  return (
    <div id={`rel-${release.id}`} class="border-base-300 border-b px-3 py-2">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <a
          href={`${href}?${ctx}`}
          data-row
          hx-get={`/updates/${release.id}/panel?${ctx}`}
          hx-target="#pane"
          hx-swap="innerHTML scroll:top"
          hx-push-url={`${href}?${ctx}`}
          hx-indicator="#busy"
          aria-current={selected ? 'true' : undefined}
          class="tap inline-flex items-center text-sm font-medium"
        >
          <ServiceName stack={release.stack} service={release.service} />
        </a>
        <Change from={release.fromTag} to={release.toTag} />
        <MagnitudeBadge value={release.magnitude} />
        <VerdictChip update={release} />
        <span class="ml-auto shrink-0 text-xs opacity-60">
          <Relative at={release.detectedAt} />
        </span>
      </div>

      {/*
        Clamped, because a verdict summary is written to justify a decision and runs to a
        paragraph, while a feed is skimmed. Three lines is enough to know whether this
        release wants your attention; the pane behind the service name has the whole
        thing, along with the breaking changes and migration steps the summary omits.
        Unclamped, three releases filled a phone screen.
      */}
      <p
        class={
          summary
            ? 'mt-1 line-clamp-3 text-xs leading-relaxed opacity-80'
            : 'mt-1 text-xs leading-relaxed opacity-50'
        }
      >
        {summary ?? NO_REVIEW}
      </p>

      {l.releases || l.source || l.docs || l.tag || l.image ? (
        <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
          {l.releases ? (
            <a href={l.releases} target="_blank" rel="noreferrer" class={LINK}>
              Release notes
            </a>
          ) : null}
          {l.source ? (
            <a href={l.source} target="_blank" rel="noreferrer" class={LINK}>
              Project
            </a>
          ) : null}
          {l.docs ? (
            <a href={l.docs} target="_blank" rel="noreferrer" class={LINK}>
              Image docs
            </a>
          ) : null}
          {/*
            Not every image resolves to a project, and a row with nowhere to go is the
            one thing this view cannot afford -- the whole point of it is to be the way
            out to what actually changed. The registry is always derivable from the image
            reference, so it is the floor: worse than a changelog, better than a dead end.
          */}
          {!l.releases && !l.source && (l.tag || l.image) ? (
            <a href={(l.tag ?? l.image) as string} target="_blank" rel="noreferrer" class={LINK}>
              {release.registry}
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export const ReleaseList: FC<{
  releases: ReleaseView[]
  ctx: string
  selectedId?: number
}> = ({ releases, ctx, selectedId }) =>
  releases.length === 0 ? (
    <EmptyState
      icon="updates"
      title="No releases yet"
      hint="every version shipshape has seen turns up here, newest first"
    />
  ) : (
    <div>
      {releases.map((r) => (
        <ReleaseRow release={r} ctx={ctx} selected={r.id === selectedId} />
      ))}
    </div>
  )
