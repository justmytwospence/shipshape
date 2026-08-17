import type { FC } from 'hono/jsx'
import { Layout } from './ui/shell.tsx'
import { InboxBody, StatusStrip, type InboxData } from './ui/inbox.tsx'
import { UpdateCard, UpdateDetail, UpdateRow } from './ui/update.tsx'
import { EmptyState } from './ui/parts.tsx'
import type { Milestone, StageFilter, UpdateView } from '../../updates/queries.ts'

/**
 * The pages, assembled from the parts.
 *
 * Each one renders as a whole document or as a fragment of itself, because htmx swaps
 * the fragment and a full navigation needs the document -- and on a phone every list row
 * is a real link to a real page, so both paths have to exist for the same content.
 */

export interface PageChrome {
  paused: boolean
  missing: { name: string; why: string }[]
  /** A `?theme=` preview, for putting two candidate looks beside each other. */
  theme?: string
}

export const InboxPage: FC<{ data: InboxData; chrome: PageChrome }> = ({ data, chrome }) => (
  <Layout
    title="Inbox"
    nav="inbox"
    paused={chrome.paused}
    missing={chrome.missing}
    theme={chrome.theme}
    subtitle={summarise(data)}
  >
    <StatusStrip scan={data.scan} />
    <InboxBody data={data} />
  </Layout>
)

function summarise(data: InboxData): string {
  const n = data.needsYou.length
  if (n === 0) return 'Nothing is waiting on you'
  const kinds = new Set(data.needsYou.map((i) => i.kind))
  const bad = [...kinds].some((k) => k === 'deploy-failed' || k === 'rolled-back' || k === 'degraded')
  return `${n} waiting on you${bad ? ' — something is broken' : ''}`
}

const STAGES: { key: StageFilter; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'rolling', label: 'Rolling out' },
  { key: 'done', label: 'Done' },
  { key: 'closed', label: 'Closed' },
  { key: 'all', label: 'All' },
]

export const UpdatesToolbar: FC<{ stage: StageFilter; q: string }> = ({ stage, q }) => (
  <form
    class="flex flex-wrap items-center gap-2"
    hx-get="/fragments/updates"
    hx-target="#updates-list"
    hx-swap="innerHTML"
    hx-push-url="true"
    hx-trigger="change, input changed delay:250ms from:[data-search], search from:[data-search]"
    hx-indicator="#busy"
  >
    <div class="filter">
      {STAGES.map((s) => (
        <input
          type="radio"
          name="stage"
          value={s.key}
          class="btn btn-sm"
          aria-label={s.label}
          checked={s.key === stage}
        />
      ))}
    </div>
    <label class="input input-sm w-full max-w-56">
      <input
        type="search"
        name="q"
        value={q}
        data-search
        placeholder="service, stack or image"
        class="grow"
      />
    </label>
  </form>
)

export const UpdatesList: FC<{ updates: UpdateView[]; twoPane?: boolean }> = ({
  updates,
  twoPane,
}) => {
  if (updates.length === 0) {
    return <EmptyState icon="check" title="Nothing here." hint="Try another filter." />
  }
  const target = twoPane ? '#pane' : '#sheet-body'
  return (
    <>
      {/* Cards on a phone, a table where there is room for one. Two renderings of the
          same rows rather than a table that pretends to work at 390px. */}
      <div class="flex flex-col gap-2 lg:hidden">
        {updates.map((u) => (
          <UpdateCard update={u} target={target} />
        ))}
      </div>
      <div class="hidden overflow-x-auto lg:block">
        <table class="table table-sm">
          <thead>
            <tr>
              <th scope="col">Service</th>
              <th scope="col">Change</th>
              <th scope="col">Size</th>
              <th scope="col">Review</th>
              <th scope="col">Stage</th>
              <th scope="col" class="text-right">
                Updated
              </th>
            </tr>
          </thead>
          <tbody>
            {updates.map((u) => (
              <UpdateRow update={u} target={target} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

export const UpdatesPage: FC<{
  updates: UpdateView[]
  stage: StageFilter
  q: string
  chrome: PageChrome
  pane?: unknown
}> = ({ updates, stage, q, chrome, pane }) => (
  <Layout
    title="Updates"
    nav="updates"
    paused={chrome.paused}
    missing={chrome.missing}
    theme={chrome.theme}
    toolbar={<UpdatesToolbar stage={stage} q={q} />}
    subtitle={`${updates.length} shown`}
  >
    <div class="flex gap-6">
      <div id="updates-list" class="min-w-0 flex-1">
        <UpdatesList updates={updates} twoPane />
      </div>
      {/* The detail lives beside the list on a wide screen and is its own page on a
          phone, so the same row link works either way. */}
      <aside id="pane" class="hidden w-[26rem] shrink-0 xl:block">
        {pane ?? (
          <div class="text-sm opacity-50">Select an update to see what the review said.</div>
        )}
      </aside>
    </div>
  </Layout>
)

export const UpdatePage: FC<{
  update: UpdateView
  milestones: Milestone[]
  warnings?: string[]
  diff?: unknown
  chrome: PageChrome
}> = ({ update, milestones, warnings, diff, chrome }) => (
  <Layout
    title={update.service}
    nav="updates"
    back={{ href: '/updates', label: 'Updates' }}
    paused={chrome.paused}
    missing={chrome.missing}
    theme={chrome.theme}
  >
    <UpdateDetail update={update} milestones={milestones} warnings={warnings} diff={diff} />
  </Layout>
)
