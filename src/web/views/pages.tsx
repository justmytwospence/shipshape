import type { FC } from 'hono/jsx'
import { Layout } from './ui/shell.tsx'
import { InboxBody, StatusStrip, type InboxData } from './ui/inbox.tsx'
import { UpdateCard, UpdateDetail, UpdateRow } from './ui/update.tsx'
import { EmptyState } from './ui/parts.tsx'
import {
  RawPolicy,
  SettingsForm,
  SettingsTabs,
  StatusBody,
  type SettingValue,
  type StatusData,
} from './ui/settings.tsx'
import {
  ActivityList,
  ActivityToolbar,
  type ActivityRow,
} from './ui/activity.tsx'
import {
  ServiceDetail,
  ServicesList,
  ServicesToolbar,
  type ServiceDetailData,
  type ServiceRowData,
} from './ui/services.tsx'
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
          class="btn btn-sm tap md:min-h-8"
          aria-label={s.label}
          checked={s.key === stage}
        />
      ))}
    </div>
    <label class="input input-sm tap w-full max-w-56 md:min-h-8">
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

export const ServicesPage: FC<{
  services: ServiceRowData[]
  filter: string
  q: string
  grouped: boolean
  chrome: PageChrome
}> = ({ services, filter, q, grouped, chrome }) => (
  <Layout
    title="Services"
    nav="services"
    paused={chrome.paused}
    missing={chrome.missing}
    theme={chrome.theme}
    toolbar={<ServicesToolbar filter={filter} q={q} grouped={grouped} />}
    subtitle={`${services.length} shown`}
  >
    <div id="services-list">
      <ServicesList services={services} grouped={grouped} />
    </div>
  </Layout>
)

export const ServicePage: FC<{ data: ServiceDetailData; chrome: PageChrome }> = ({
  data,
  chrome,
}) => (
  <Layout
    title={data.svc.service}
    nav="services"
    back={{ href: '/services', label: 'Services' }}
    paused={chrome.paused}
    missing={chrome.missing}
    theme={chrome.theme}
  >
    <ServiceDetail data={data} />
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

export const ActivityPage: FC<{
  rows: ActivityRow[]
  repo: string
  kind: string
  problems: boolean
  q: string
  more?: string | null
  chrome: PageChrome
}> = ({ rows, repo, kind, problems, q, more, chrome }) => (
  <Layout
    title="Activity"
    nav="activity"
    paused={chrome.paused}
    missing={chrome.missing}
    theme={chrome.theme}
    toolbar={<ActivityToolbar kind={kind} problems={problems} q={q} />}
  >
    <div id="activity-list">
      <ActivityList rows={rows} repo={repo} more={more} />
    </div>
  </Layout>
)

export const SettingsPage: FC<{
  tab: string
  groups: { title: string; blurb?: string; items: SettingValue[] }[]
  models?: string[]
  banner?: { level: 'info' | 'error'; text: string } | null
  readyCount?: number
  chrome: PageChrome
}> = ({ tab, groups, models, banner, readyCount, chrome }) => (
  <Layout
    title="Settings"
    nav="settings"
    paused={chrome.paused}
    missing={chrome.missing}
    theme={chrome.theme}
    toolbar={<SettingsTabs active={tab} />}
    subtitle={
      tab === 'advanced' ? 'Tuning. Correct out of the box.' : 'What happens without you.'
    }
  >
    <SettingsForm
      groups={groups}
      models={models}
      banner={banner}
      advanced={tab === 'advanced'}
      readyCount={readyCount}
    />
  </Layout>
)

export const StatusPage: FC<{ data: StatusData; chrome: PageChrome }> = ({ data, chrome }) => (
  <Layout
    title="Status"
    nav="settings"
    paused={chrome.paused}
    missing={chrome.missing}
    theme={chrome.theme}
    toolbar={<SettingsTabs active="status" />}
    subtitle="What shipshape is doing, and what it has spent."
  >
    <StatusBody data={data} />
  </Layout>
)

export const PromptsPage: FC<{ editors: unknown; chrome: PageChrome }> = ({ editors, chrome }) => (
  <Layout
    title="Prompts"
    nav="settings"
    paused={chrome.paused}
    missing={chrome.missing}
    theme={chrome.theme}
    toolbar={<SettingsTabs active="prompts" />}
    subtitle="What the model is asked. Editing one is rarely the answer."
  >
    <div class="flex flex-col gap-4">{editors}</div>
  </Layout>
)

export const RawPolicyPage: FC<{ text: string; chrome: PageChrome }> = ({ text, chrome }) => (
  <Layout
    title="policy.yaml"
    nav="settings"
    back={{ href: '/settings', label: 'Settings' }}
    paused={chrome.paused}
    missing={chrome.missing}
    theme={chrome.theme}
  >
    <RawPolicy text={text} />
  </Layout>
)

export const DocsPage: FC<{ sections: unknown; chrome: PageChrome }> = ({ sections, chrome }) => (
  <Layout
    title="How it works"
    nav="settings"
    back={{ href: '/settings', label: 'Settings' }}
    paused={chrome.paused}
    missing={chrome.missing}
    theme={chrome.theme}
  >
    <div class="prose prose-sm max-w-3xl">{sections}</div>
  </Layout>
)
