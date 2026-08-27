import type { FC } from 'hono/jsx'
import { Layout, Split, type Chrome } from './ui/shell.tsx'
import { InboxAside, InboxList, ScanControls, type InboxData } from './ui/inbox.tsx'
import { UpdateRow } from './ui/update.tsx'
import { ReleaseList } from './ui/releases.tsx'
import { EmptyState, ListCount, Search, Tabs } from './ui/parts.tsx'
import {
  RawPolicy,
  SettingsForm,
  SettingsNav,
  SettingsTabs,
  type SettingValue,
} from './ui/settings.tsx'
import { StatusBody, type StatusData } from './ui/status.tsx'
import { ActivityList, ActivityToolbar, type ActivityRow } from './ui/activity.tsx'
import {
  ServicesList,
  ServicesToolbar,
  type ServiceRowData,
} from './ui/services.tsx'
import type { ReleaseView, StageFilter, UpdateView } from '../../updates/queries.ts'

/**
 * The pages, assembled from the parts.
 *
 * Every list page is the same shape: a toolbar, a list, and a pane. On a desktop all
 * three are on screen at once and a row fills the pane; on a phone the list is the page
 * and a row navigates to its own. A `detail` turns the same page inside out -- the pane
 * is filled, the row is marked, and below lg only the pane renders -- which is what a
 * direct load of `/updates/7?list=inbox` produces, so back and reload always land on
 * something the server drew whole.
 */

export type PageChrome = Chrome

/** A filled pane, and what the phone bar says while it is the page. */
export interface Detail {
  pane: unknown
  title: string
  back: { href: string; label: string }
}

// ------------------------------------------------------------------- inbox

export const InboxPage: FC<{
  data: InboxData
  chrome: PageChrome
  selectedId?: number
  detail?: Detail
}> = ({ data, chrome, selectedId, detail }) => (
  <Layout
    title={detail?.title ?? 'Inbox'}
    section="Inbox"
    nav="inbox"
    back={detail?.back}
    detail={!!detail}
    actions={<ScanControls scan={data.scan} />}
    count={<ListCount n={data.needsYou.length} />}
    chrome={chrome}
  >
    <Split
      list={<InboxList data={data} selectedId={selectedId} />}
      pane={detail?.pane ?? <InboxAside data={data} />}
      mode={detail ? 'detail' : 'list'}
    />
  </Layout>
)

// ----------------------------------------------------------------- updates

const STAGES: { key: StageFilter; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'rolling', label: 'Rolling out' },
  { key: 'done', label: 'Done' },
  { key: 'closed', label: 'Closed' },
  { key: 'all', label: 'All' },
  { key: 'releases', label: 'Releases' },
]

const MAGNITUDES = [
  { key: 'all', label: 'Any size' },
  { key: 'major', label: 'Major' },
  { key: 'minor', label: 'Minor' },
  { key: 'patch', label: 'Patch' },
  { key: 'digest', label: 'Digest' },
]

/** The filter asks the page itself for its list, so the URL it pushes reloads whole. */
export const UpdatesToolbar: FC<{ stage: StageFilter; q: string; magnitude: string }> = ({
  stage,
  q,
  magnitude,
}) => (
  <form
    class="flex shrink-0 items-center gap-2"
    hx-get="/updates"
    hx-target="#updates-list"
    hx-swap="innerHTML"
    hx-push-url="true"
    hx-trigger="change, input changed delay:250ms from:[data-search], search from:[data-search]"
    hx-indicator="#busy"
  >
    <Tabs name="stage" value={stage} options={STAGES} label="Stage" />
    <Tabs name="magnitude" value={magnitude} options={MAGNITUDES} label="Size" />
    <Search value={q} placeholder="service, stack or image" />
  </form>
)

export const UpdatesList: FC<{ updates: UpdateView[]; ctx: string; selectedId?: number }> = ({
  updates,
  ctx,
  selectedId,
}) => {
  if (updates.length === 0) {
    return <EmptyState icon="check" title="Nothing here." hint="Try another filter." />
  }
  return (
    <div class="divide-base-300 divide-y">
      {updates.map((u) => (
        <UpdateRow update={u} ctx={ctx} selected={u.id === selectedId} showStage />
      ))}
    </div>
  )
}

export const UpdatesPage: FC<{
  updates: UpdateView[]
  stage: StageFilter
  q: string
  magnitude: string
  ctx: string
  chrome: PageChrome
  selectedId?: number
  detail?: Detail
}> = ({ updates, stage, q, magnitude, ctx, chrome, selectedId, detail }) => (
  <Layout
    title={detail?.title ?? 'Updates'}
    section="Updates"
    nav="updates"
    back={detail?.back}
    detail={!!detail}
    toolbar={<UpdatesToolbar stage={stage} q={q} magnitude={magnitude} />}
    count={<ListCount n={updates.length} />}
    chrome={chrome}
  >
    <Split
      list={
        <div id="updates-list">
          <UpdatesList updates={updates} ctx={ctx} selectedId={selectedId} />
        </div>
      }
      pane={
        detail?.pane ?? (
          <EmptyState icon="updates" title="Select an update" hint="What the review said, and what you can do about it, shows here." />
        )
      }
      mode={detail ? 'detail' : 'list'}
    />
  </Layout>
)

/**
 * The releases feed: the same page furniture as Updates, a different list inside it.
 *
 * Kept as its own component rather than a branch inside UpdatesPage so that neither has
 * to accept an array it might not be able to render -- a ReleaseView carries links an
 * UpdateView does not, and a cast at the render site would be a promise the type system
 * could not check.
 */
export const ReleasesPage: FC<{
  releases: ReleaseView[]
  stage: StageFilter
  q: string
  magnitude: string
  ctx: string
  chrome: PageChrome
  selectedId?: number
  detail?: Detail
}> = ({ releases, stage, q, magnitude, ctx, chrome, selectedId, detail }) => (
  <Layout
    title={detail?.title ?? 'Releases'}
    section="Updates"
    nav="updates"
    back={detail?.back}
    detail={!!detail}
    toolbar={<UpdatesToolbar stage={stage} q={q} magnitude={magnitude} />}
    count={<ListCount n={releases.length} />}
    chrome={chrome}
  >
    <Split
      list={
        <div id="updates-list">
          <ReleaseList releases={releases} ctx={ctx} selectedId={selectedId} />
        </div>
      }
      pane={
        detail?.pane ?? (
          <EmptyState
            icon="updates"
            title="Select a release"
            hint="What the review said, and what you can do about it, shows here."
          />
        )
      }
      mode={detail ? 'detail' : 'list'}
    />
  </Layout>
)

// ---------------------------------------------------------------- services

export const ServicesPage: FC<{
  services: ServiceRowData[]
  filter: string
  q: string
  grouped: boolean
  ctx: string
  chrome: PageChrome
  selected?: { stack: string; service: string } | null
  detail?: Detail
}> = ({ services, filter, q, grouped, ctx, chrome, selected, detail }) => (
  <Layout
    title={detail?.title ?? 'Services'}
    section="Services"
    nav="services"
    back={detail?.back}
    detail={!!detail}
    toolbar={<ServicesToolbar filter={filter} q={q} grouped={grouped} />}
    count={<ListCount n={services.length} />}
    chrome={chrome}
  >
    <Split
      list={
        <div id="services-list">
          <ServicesList services={services} grouped={grouped} ctx={ctx} selected={selected} />
        </div>
      }
      pane={
        detail?.pane ?? (
          <EmptyState icon="services" title="Select a service" hint="Where each of its settings came from, and its history, show here." />
        )
      }
      mode={detail ? 'detail' : 'list'}
    />
  </Layout>
)

// ---------------------------------------------------------------- activity

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
    chrome={chrome}
    toolbar={<ActivityToolbar kind={kind} problems={problems} q={q} />}
    count={<ListCount n={rows.length} />}
  >
    <Split
      variant="wide"
      list={
        <div id="activity-list">
          <ActivityList rows={rows} repo={repo} more={more} />
        </div>
      }
    />
  </Layout>
)

// ---------------------------------------------------------------- settings

export const SettingsPage: FC<{
  tab: string
  groups: { title: string; prose?: string[]; items: SettingValue[] }[]
  models?: string[]
  banner?: { level: 'info' | 'error'; text: string } | null
  readyCount?: number
  /** Rendered after the fields: the prompt editors, on Advanced. */
  extra?: unknown
  extraNav?: { href: string; label: string }[]
  chrome: PageChrome
}> = ({ tab, groups, models, banner, readyCount, extra, extraNav, chrome }) => (
  <Layout
    title="Settings"
    nav="settings"
    chrome={chrome}
    toolbar={<SettingsTabs active={tab} />}
  >
    <Split
      variant="nav"
      list={<SettingsNav sections={groups.map((g) => g.title)} extra={extraNav} />}
      pane={
        <div class="flex flex-col lg:max-w-5xl">
          <SettingsForm
            groups={groups}
            models={models}
            banner={banner}
            advanced={tab === 'advanced'}
            readyCount={readyCount}
          />
          {extra ? <div class="flex flex-col">{extra}</div> : null}
        </div>
      }
    />
  </Layout>
)

export const StatusPage: FC<{ data: StatusData; chrome: PageChrome }> = ({ data, chrome }) => (
  <Layout title="Status" nav="status" chrome={chrome}>
    <Split variant="wide" list={<StatusBody data={data} />} />
  </Layout>
)

export const RawPolicyPage: FC<{ text: string; chrome: PageChrome }> = ({ text, chrome }) => (
  <Layout
    title="policy.yaml"
    section="Settings · policy.yaml"
    nav="settings"
    back={{ href: '/settings', label: 'Settings' }}
    chrome={chrome}
  >
    <Split variant="wide" list={<RawPolicy text={text} />} />
  </Layout>
)
