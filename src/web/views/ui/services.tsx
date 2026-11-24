import type { FC } from 'hono/jsx'
import { Icon } from './icon.tsx'
import { ExtLink, EmptyState, Mono, Relative, Search, ServiceName, Tabs } from './parts.tsx'
import { GroupHeader, UpdateRow } from './update.tsx'
import type { UpdateView } from '../../../updates/queries.ts'
import type { LinkPreview } from '../../../resolver/preview.ts'
import type { UnwatchableReason } from '../../../compose/scan.ts'
import { FORKS_GUIDE_URL } from './auth.tsx'

/**
 * Every service shipshape can see, and what it has been told about each one.
 *
 * The old page was a five-column table and a "Check now" link 18 pixels tall. What it
 * could not answer at all is the question that brings you here: why is this service on
 * the rung it is on -- and it offered no way to change it, so the answer was always
 * "open the compose file".
 */

export interface ServiceRowData {
  stack: string
  service: string
  image: string | null
  tag: string | null
  watched: boolean
  unwatchable: string | null
  lastStatus: string | null
  lastDetail: string | null
  constrainedFrom: string | null
  lastSeenAt?: string | null
  /** The compose file it was read from. */
  composeFile?: string | null
  /** v1 labels the compose file still carries, as the scan read them. */
  legacyLabels?: string | null
  /** The service's class, when it is not the default `normal`. */
  policy?: string | null
  /** Whether the repository its release notes come from is certain, only likely, or unknown. */
  upstream?: 'linked' | 'likely' | 'none'
  /** Our own build of the upstream image, waiting on an upstream fix. */
  fork?: boolean
}

export const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'watched', label: 'Watched' },
  { key: 'unwatched', label: 'Not watched' },
  { key: 'unlinked', label: 'Unlinked' },
  { key: 'unwatchable', label: 'Not watchable' },
  { key: 'attention', label: 'Needs attention' },
] as const

/** The filter, which asks the page for its list and pushes the page's own URL. */
export const ServicesToolbar: FC<{ filter: string; q: string; grouped: boolean }> = ({
  filter,
  q,
  grouped,
}) => (
  <form
    class="flex shrink-0 items-center gap-2"
    hx-get="/services"
    hx-target="#services-list"
    hx-swap="innerHTML"
    hx-push-url="true"
    hx-trigger="change, input changed delay:250ms from:[data-search], search from:[data-search]"
    hx-indicator="#busy"
  >
    <Tabs name="filter" value={filter} options={FILTERS} label="Show" />
    <Search value={q} placeholder="stack, service or image" />
    <label class="label tap cursor-pointer gap-1.5 text-xs whitespace-nowrap">
      <input
        type="checkbox"
        name="group"
        value="stack"
        class="toggle toggle-xs"
        checked={grouped}
      />
      Group
    </label>
  </form>
)

const UNWATCHABLE: Record<UnwatchableReason, string> = {
  excluded: 'excluded',
  'no-image': 'no image',
  build: 'built here',
  interpolated: 'variable image',
}

function statusOf(s: ServiceRowData): { label: string; cls: string; detail?: string | null } {
  if (s.lastStatus) return { label: s.lastStatus, cls: 'badge-error', detail: s.lastDetail }
  if (s.unwatchable) {
    return { label: UNWATCHABLE[s.unwatchable as UnwatchableReason] ?? s.unwatchable, cls: 'badge-ghost' }
  }
  if (s.watched) {
    return s.constrainedFrom
      ? { label: 'pinned', cls: 'badge-warning', detail: `${s.constrainedFrom} available` }
      : { label: 'watched', cls: 'badge-success' }
  }
  return { label: 'not watched', cls: 'badge-ghost' }
}

/** Where a row's own URL and pane request point. `ctx` names the list for the URL. */
export const serviceHref = (svc: { stack: string; service: string }) =>
  `/services/${svc.stack}/${svc.service}`

const ROW =
  'group border-l-2 border-transparent hover:bg-base-200/60 aria-[current=true]:border-primary ' +
  'aria-[current=true]:bg-primary/8 focus-visible:outline-primary block min-h-12 px-3 py-1.5 ' +
  'focus-visible:outline-2 lg:min-h-9 lg:py-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 ' +
  'gap-y-0.5 items-center lg:gap-x-3 ' +
  'lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1.7fr)_5rem_4.5rem_2.75rem_1.75rem]'

/**
 * One service, one line at lg and two on a phone: name · image:tag · status · policy ·
 * seen · check. The whole row is the link; the check button sits over its last cell.
 */
export const ServiceRow: FC<{
  svc: ServiceRowData
  ctx: string
  grouped?: boolean
  selected?: boolean
}> = ({ svc, ctx, grouped, selected }) => {
  const st = statusOf(svc)
  const href = serviceHref(svc)
  const id = `svc-${svc.stack}-${svc.service}`
  return (
    <div id={id} class="relative">
      <a
        href={`${href}?${ctx}`}
        data-row
        hx-get={`${href}/panel?${ctx}`}
        hx-target="#pane"
        hx-swap="innerHTML scroll:top"
        hx-push-url={`${href}?${ctx}`}
        hx-indicator="#busy"
        aria-current={selected ? 'true' : undefined}
        class={ROW}
      >
        <span class="min-w-0 truncate text-sm">
          {grouped ? (
            <span class="font-medium">{svc.service}</span>
          ) : (
            <ServiceName stack={svc.stack} service={svc.service} />
          )}
        </span>
        {/* phone, line 1 right: the status */}
        <span class="flex items-center gap-1 lg:hidden">
          {svc.fork ? <ForkBadge /> : null}
          <span class={`badge badge-xs badge-soft ${st.cls}`}>{st.label}</span>
        </span>
        {/* The fork badge sits by the image rather than the status: the status cell is
            5rem, and the thing it qualifies is the image, which is not the one running. */}
        <span class="hidden min-w-0 items-center gap-1.5 lg:flex">
          <span class="min-w-0 truncate">
            <Mono>
              {svc.image ?? '—'}
              {svc.tag ? <span class="opacity-60">:{svc.tag}</span> : null}
            </Mono>
          </span>
          {svc.fork ? <ForkBadge /> : null}
        </span>
        <span class="hidden min-w-0 items-center gap-1.5 lg:flex">
          <span class={`badge badge-xs badge-soft ${st.cls}`}>{st.label}</span>
        </span>
        <span class="hidden truncate font-mono text-xs opacity-70 lg:block">{svc.policy ?? ''}</span>
        <span class="hidden text-right lg:block">
          <Relative at={svc.lastSeenAt} />
        </span>
        {/* phone, line 2: image · detail */}
        <span class="col-span-2 flex min-w-0 items-center gap-x-2 text-xs opacity-70 lg:hidden">
          <span class="truncate font-mono">
            {svc.image ?? '—'}
            {svc.tag ? `:${svc.tag}` : ''}
          </span>
          {st.detail ? <span class="text-error/80 truncate">{st.detail}</span> : null}
        </span>
        <span class="hidden lg:block" />
      </a>
      {svc.watched ? (
        <button
          type="button"
          class="btn btn-ghost btn-xs btn-square absolute top-1/2 right-2 hidden -translate-y-1/2 lg:inline-flex"
          aria-label={`Check ${svc.service} now`}
          title="Check now"
          hx-post={`${href}/check?${ctx}`}
          hx-target="#pane"
          hx-swap="innerHTML"
          hx-disabled-elt="this"
          hx-indicator="#busy"
        >
          <Icon name="refresh" class="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}

/** The one word that says this service is not running the image it watches. */
const ForkBadge: FC = () => <span class="badge badge-xs badge-soft badge-info">fork</span>

export const ServicesList: FC<{
  services: ServiceRowData[]
  grouped: boolean
  ctx: string
  selected?: { stack: string; service: string } | null
  /** Services before filtering, so an empty list can say why it is empty. */
  total: number
  filter?: string
  q?: string
}> = ({ services, grouped, ctx, selected, total, filter, q }) => {
  // The Not watched filter offers to watch everything it shows, in one commit per file.
  const watchAll =
    filter === 'unwatched' && services.length > 0 ? (
      <>
        <div class="border-base-300 flex min-h-11 items-center gap-2 border-b px-3 text-xs">
          <span class="opacity-70">
            {services.length} {services.length === 1 ? 'service is' : 'services are'} not watched.
          </span>
          <button type="button" class="btn btn-primary btn-xs tap ml-auto" data-open="#watch-all">
            Watch all {services.length}
          </button>
        </div>
        <WatchAllDialog
          n={services.length}
          files={new Set(services.map((s) => `${s.stack}\0${s.composeFile ?? ''}`)).size}
          q={q ?? ''}
        />
      </>
    ) : null
  if (services.length === 0) {
    return total === 0 ? (
      <EmptyState
        icon="services"
        title="No compose services found."
        hint="shipshape reads services from the compose files in REPO_DIR. Status shows what the last scan found."
      />
    ) : (
      <EmptyState icon="services" title="No services match." hint="Try another filter, or clear the search." />
    )
  }
  const isSel = (s: ServiceRowData) =>
    !!selected && s.stack === selected.stack && s.service === selected.service
  if (!grouped) {
    return (
      <>
        {watchAll}
        <div class="divide-base-300 divide-y">
          {services.map((s) => (
            <ServiceRow svc={s} ctx={ctx} selected={isSel(s)} />
          ))}
        </div>
      </>
    )
  }
  const stacks = new Map<string, ServiceRowData[]>()
  for (const s of services) {
    const list = stacks.get(s.stack) ?? []
    list.push(s)
    stacks.set(s.stack, list)
  }
  return (
    <div>
      {watchAll}
      {[...stacks].map(([stack, rows]) => (
        <section>
          <GroupHeader
            title={stack}
            hint={`${rows.filter((r) => r.watched).length}/${rows.length} watched`}
          />
          <div class="divide-base-300 divide-y">
            {rows.map((s) => (
              <ServiceRow svc={s} ctx={ctx} grouped selected={isSel(s)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------- detail

/** Where a setting came from. The provenance is the point: it is why, not just what. */
export type Provenance = 'label' | 'default' | 'inferred' | 'locked' | 'none'

export interface ConfigLine {
  key: string
  value: string
  source: Provenance
  note?: string
}

/** One upstream reference a fork waits on, as the last scan left it. */
export interface ForkRefLine {
  ref: string
  url: string | null
  state: 'open' | 'merged-unreleased' | 'released' | 'closed-unfixed' | 'unknown'
  /** The state in words: "merged, not released", "released in v3.4.0". */
  label: string
  releasedIn: string | null
  releaseUrl: string | null
  detail: string | null
  checkedAt: string | null
}

export interface ServiceDetailData {
  svc: ServiceRowData
  /** Present for a fork: the upstream base, the references it waits on, and whether its last replay conflicted. */
  fork?: { upstream: string; refs: ForkRefLine[]; conflict?: string | null } | null
  composeFile: string | null
  config: ConfigLine[]
  history: UpdateView[]
  canEdit: boolean
  /** Whether Watch is offered: a compose file to write, and a service that is not watched but could be. */
  canWatch?: boolean
  /** How its tags would be compared once watched, read from the running tag; null when shipshape cannot tell. */
  watchPattern?: string | null
  /** What the link dialog starts from: the labels as the compose file has them. */
  link?: { source: string | null; changelog: string | null; inferred: string | null }
}

const FORK_STATE_CLS: Record<ForkRefLine['state'], string> = {
  open: 'badge-ghost',
  'merged-unreleased': 'badge-warning',
  released: 'badge-success',
  'closed-unfixed': 'badge-error',
  unknown: 'badge-ghost',
}

const SOURCE_CLS: Record<Provenance, string> = {
  label: 'badge-primary',
  default: 'badge-ghost',
  inferred: 'badge-ghost',
  locked: 'badge-ghost',
  none: 'badge-ghost',
}

/** The six classes, in the order a service usually moves between them. */
const RUNGS = [
  { value: 'normal', label: 'normal', what: 'ships on its own once the review finds nothing to do and the release has aged' },
  { value: 'stateful', label: 'stateful', what: 'ships on its own after a restore point; a one-way migration or a jump with no evidence asks' },
  { value: 'ask', label: 'ask', what: 'always asks before shipping' },
  { value: 'lifeline', label: 'lifeline', what: 'always asks, and no rule can waive it — the way back in' },
  { value: 'frozen', label: 'frozen', what: 'tracked; nothing happens until you ask' },
  { value: 'skip', label: 'skip', what: 'not tracked at all: no updates are looked for' },
]

/** What the radio should show as chosen: no class at all is a normal service. */
function currentRung(cls: string | null | undefined): string {
  return (cls ?? '').trim().toLowerCase() || 'normal'
}

/**
 * The pane, and the phone page's body. `ctx` is the list it was opened from; the history
 * rows carry it forward as `list=service` so an update opened from here comes back here.
 */
export const ServiceDetail: FC<{ data: ServiceDetailData; ctx?: string; listHref?: string }> = ({
  data,
  ctx,
  listHref,
}) => {
  const { svc } = data
  const st = statusOf(svc)
  const cardId = `svc-card-${svc.stack}-${svc.service}`
  // The history rows name this service as their list, and keep the services filter
  // behind it, so an update opened from here reloads with this pane one step back.
  const hp = new URLSearchParams(ctx ?? '')
  hp.set('list', 'service')
  hp.set('stack', svc.stack)
  hp.set('service', svc.service)
  const historyCtx = hp.toString()
  return (
    <div id={cardId} class="flex flex-col lg:max-w-4xl">
      <header class="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pt-3 pb-2">
        <h2 class="text-sm font-semibold">
          <ServiceName stack={svc.stack} service={svc.service} />
        </h2>
        <span class={`badge badge-xs badge-soft ${st.cls}`}>{st.label}</span>
        {svc.fork ? <ForkBadge /> : null}
        <Mono>
          {svc.image ?? 'no image'}
          {svc.tag ? `:${svc.tag}` : ''}
        </Mono>
        {svc.lastSeenAt ? (
          <span class="text-xs opacity-50">
            seen <Relative at={svc.lastSeenAt} />
          </span>
        ) : null}
        {listHref ? (
          <a
            href={listHref}
            class="btn btn-ghost btn-xs btn-square ml-auto hidden lg:inline-flex"
            aria-label="Close"
            title="Close"
          >
            <Icon name="x" />
          </a>
        ) : null}
      </header>
      {st.detail ? <p class="text-error/80 px-4 pb-2 text-xs">{st.detail}</p> : null}

      <div class="actionbar bg-base-100/95 border-base-300 order-last flex items-center gap-2 border-t px-4 py-2 backdrop-blur lg:order-none lg:border-t-0 lg:border-b">
        {svc.watched ? (
          <button
            type="button"
            class="btn btn-sm btn-primary tap gap-1"
            hx-post={`/services/${svc.stack}/${svc.service}/check${ctx ? `?${ctx}` : ''}`}
            hx-target={`#${cardId}`}
            hx-swap="outerHTML"
            hx-disabled-elt="this"
            hx-indicator="#busy"
          >
            <Icon name="refresh" class="size-3.5" />
            Check now
          </button>
        ) : data.canWatch ? (
          <button
            type="button"
            class="btn btn-sm btn-primary tap gap-1"
            data-open={`#watch-${svc.stack}-${svc.service}`}
          >
            <Icon name="eye" class="size-3.5" />
            Watch this service
          </button>
        ) : (
          <span class="text-xs opacity-70">{NOT_WATCHABLE[svc.unwatchable ?? ''] ?? 'Not watched.'}</span>
        )}
        {data.canEdit ? (
          <button
            type="button"
            class="btn btn-sm btn-ghost tap"
            data-open={`#rung-${svc.stack}-${svc.service}`}
          >
            Change class
          </button>
        ) : null}
      </div>

      <section class="border-base-300 border-t px-4 py-3">
        <h3 class="mb-1.5 text-xs font-medium tracking-wide uppercase opacity-60">
          Effective configuration
        </h3>
        <div class="divide-base-300 border-base-300 divide-y border-y text-xs">
          {data.config.map((line) => {
            const actions = [
              line.key === 'class' && data.canEdit ? (
                <button
                  type="button"
                  class="btn btn-ghost btn-xs tap"
                  data-open={`#rung-${svc.stack}-${svc.service}`}
                >
                  Change
                </button>
              ) : null,
              line.key === 'watch' && data.canEdit && line.value === 'off' && data.canWatch ? (
                <button type="button" class="btn btn-ghost btn-xs tap" data-open={`#watch-${svc.stack}-${svc.service}`}>
                  Watch
                </button>
              ) : null,
              line.key === 'watch' && data.canEdit && line.value === 'on' ? (
                <button type="button" class="btn btn-ghost btn-xs tap" data-open={`#unwatch-${svc.stack}-${svc.service}`}>
                  Stop
                </button>
              ) : null,
              (line.key === 'upstream' || line.key === 'notes') && data.canEdit ? (
                <button
                  type="button"
                  class="btn btn-ghost btn-xs tap"
                  data-open={`#link-${svc.stack}-${svc.service}`}
                >
                  Change
                </button>
              ) : null,
              line.key === 'upstream' && svc.image ? (
                <button
                  type="button"
                  class="btn btn-ghost btn-xs tap"
                  hx-post={`/services/${svc.stack}/${svc.service}/resolve${ctx ? `?${ctx}` : ''}`}
                  hx-target={`#${cardId}`}
                  hx-swap="outerHTML"
                  hx-disabled-elt="this"
                  hx-indicator="#busy"
                >
                  Look again
                </button>
              ) : null,
            ].filter((a) => a !== null)
            return (
              <div class="flex min-h-11 flex-wrap items-center gap-x-3 lg:min-h-7 lg:flex-nowrap">
                <span class="w-24 shrink-0 opacity-70">{line.key}</span>
                <span class="min-w-0 flex-1">
                  {/* Wrapped on a phone, where a badge and a button leave the value a narrow
                      column and truncation cut the upstream repository's name in half. */}
                  <span class="block font-mono break-words lg:truncate">{line.value}</span>
                  {line.note ? <span class="block opacity-60">{line.note}</span> : null}
                </span>
                <span class={`badge badge-xs badge-soft ${SOURCE_CLS[line.source]}`}>
                  {line.source}
                </span>
                {/* Two buttons beside a badge left the upstream value four characters wide on
                    a phone, so there they take a line of their own; one still fits beside. */}
                {actions.length > 0 ? (
                  <span
                    class={
                      actions.length > 1
                        ? 'flex basis-full justify-end gap-1 pb-1 lg:basis-auto lg:pb-0'
                        : 'flex gap-1'
                    }
                  >
                    {actions}
                  </span>
                ) : null}
              </div>
            )
          })}
        </div>
        {data.composeFile ? (
          <p class="mt-1.5 font-mono text-xs opacity-50">{data.composeFile}</p>
        ) : null}
      </section>

      {data.fork ? <ForkSection fork={data.fork} /> : null}

      {data.canEdit ? <RungDialog svc={svc} ctx={ctx} /> : null}
      {data.canEdit && data.canWatch ? (
        <WatchDialog svc={svc} ctx={ctx} composeFile={data.composeFile ?? ''} pattern={data.watchPattern ?? null} />
      ) : null}
      {data.canEdit && svc.watched ? <UnwatchDialog svc={svc} ctx={ctx} composeFile={data.composeFile ?? ''} /> : null}
      {data.canEdit ? <LinkDialog svc={svc} link={data.link} ctx={ctx} /> : null}

      <section class="border-base-300 border-t">
        <GroupHeader title="History" count={data.history.length} />
        {data.history.length === 0 ? (
          <p class="px-4 py-3 text-xs opacity-60">Nothing has been detected for this service yet.</p>
        ) : (
          <div class="divide-base-300 divide-y">
            {data.history.slice(0, 20).map((u) => (
              <UpdateRow update={u} ctx={historyCtx} showStage />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

/**
 * What a fork is waiting for. Each reference links out to GitHub with where it stands;
 * a released one links to the release too. A conflict -- the one thing a fork can need a
 * person for -- is said first, in the sentence the update shows.
 */
const ForkSection: FC<{ fork: NonNullable<ServiceDetailData['fork']> }> = ({ fork }) => (
  <section class="border-base-300 border-t px-4 py-3">
    <h3 class="mb-1.5 text-xs font-medium tracking-wide uppercase opacity-60">Fork</h3>
    {fork.conflict ? (
      <p class="text-warning mb-1.5 text-xs">
        Cannot be rebased: {fork.conflict}. Rebase the fork's carried commits by hand and move the pinned sha, or drop
        the commit; shipshape tries again once the pin or the target changes.
      </p>
    ) : null}
    <div class="divide-base-300 border-base-300 divide-y border-y text-xs">
      <div class="flex min-h-11 flex-wrap items-center gap-x-3 lg:min-h-7 lg:flex-nowrap">
        <span class="w-24 shrink-0 opacity-70">based on</span>
        <span class="min-w-0 flex-1 font-mono break-all lg:truncate">{fork.upstream}</span>
      </div>
      {fork.refs.length === 0 ? (
        <div class="flex min-h-11 items-center lg:min-h-7">
          <span class="w-24 shrink-0 opacity-70">waits on</span>
          <span class="opacity-70">nothing listed — add shipshape.fork.waits-on so shipshape can say when it can go</span>
        </div>
      ) : (
        fork.refs.map((r, i) => (
          <div class="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-0.5 py-1 lg:min-h-7 lg:flex-nowrap lg:py-0">
            <span class="w-24 shrink-0 opacity-70">{i === 0 ? 'waits on' : ''}</span>
            <span class="min-w-0 flex-1">
              {r.url ? (
                <ExtLink href={r.url} class="link link-hover font-mono">
                  {r.ref}
                </ExtLink>
              ) : (
                <span class="font-mono">{r.ref}</span>
              )}
              {r.detail ? <span class="block opacity-60">{r.detail}</span> : null}
            </span>
            <span class="flex items-center gap-1.5">
              <span class={`badge badge-xs badge-soft ${FORK_STATE_CLS[r.state]}`}>{r.label}</span>
              {r.releaseUrl ? (
                <ExtLink href={r.releaseUrl} class="link link-hover">
                  release
                </ExtLink>
              ) : null}
            </span>
          </div>
        ))
      )}
    </div>
    <p class="mt-1.5 text-xs opacity-60">
      Follows its class like any service: a new upstream release replays these fixes onto it, and once every fix has
      shipped upstream, shipping retires the fork. A conflict comes to you.{' '}
      <ExtLink href={FORKS_GUIDE_URL} class="link">
        Forks guide
      </ExtLink>
    </p>
  </section>
)

/**
 * Changing a rung writes the label into the compose file and commits it.
 *
 * The same guardrails as the settings page: it refuses on a dirty file rather than
 * folding a hand-edit into shipshape's commit, and the file in git stays the source of
 * truth -- which is the whole reason this can be edited from a browser at all.
 */
/** Why a service that is not watched cannot be, in words. */
const NOT_WATCHABLE: Record<string, string> = {
  excluded: 'Its stack is excluded in the policy file (exclude_stacks), so shipshape never touches it.',
  'no-image': 'It has no image: line, so there is nothing to compare with a registry.',
  interpolated: 'Its image is set by a variable (${…}), which shipshape cannot compare with a registry.',
}

/** The form both watch dialogs share: one label, written into the compose file and committed. */
const WatchForm: FC<{ svc: ServiceRowData; ctx?: string; value: 'true' | 'false'; submit: string; primary: boolean }> = ({
  svc,
  ctx,
  value,
  submit,
  primary,
}) => (
  <form
    hx-post={`/services/${svc.stack}/${svc.service}/labels${ctx ? `?${ctx}` : ''}`}
    hx-target={`#svc-card-${svc.stack}-${svc.service}`}
    hx-swap="outerHTML"
    hx-disabled-elt="find button[type=submit]"
    hx-indicator="#busy"
    data-close-dialog
  >
    <input type="hidden" name="key" value="watch" />
    <input type="hidden" name="value" value={value} />
    <div class="modal-action">
      <button type="button" class="btn btn-ghost btn-sm tap" data-close-dialog>
        Cancel
      </button>
      <button type="submit" class={primary ? 'btn btn-primary btn-sm tap' : 'btn btn-sm tap'}>
        {submit}
      </button>
    </div>
  </form>
)

const WatchDialog: FC<{ svc: ServiceRowData; ctx?: string; composeFile: string; pattern: string | null }> = ({
  svc,
  ctx,
  composeFile,
  pattern,
}) => {
  const build = svc.unwatchable === 'build'
  return (
    <dialog id={`watch-${svc.stack}-${svc.service}`} class="modal modal-bottom sm:modal-middle">
      <div class="modal-box pb-safe">
        <h3 class="text-base font-semibold">Watch {svc.service}</h3>
        <p class="mt-1 text-xs opacity-70">
          {build
            ? `Writes shipshape.watch: "true" into ${composeFile} and commits it. A service built here is watched through the base image its Dockerfile is built FROM.`
            : `Writes shipshape.watch: "true" into ${composeFile} and commits it. From the next scan, shipshape compares ${svc.image ?? ''}:${svc.tag ?? ''} with the newer tags its registry has.`}
        </p>
        {build ? null : (
          <p class="mt-1 text-xs opacity-70">
            {pattern === null
              ? `shipshape cannot tell how "${svc.tag ?? ''}" is numbered, so the service will show under Needs attention until a shipshape.pattern label says how.`
              : `Its tags are compared as ${pattern}, read from the running tag.`}
          </p>
        )}
        <WatchForm svc={svc} ctx={ctx} value="true" submit="Watch it" primary />
      </div>
      <form method="dialog" class="modal-backdrop">
        <button>close</button>
      </form>
    </dialog>
  )
}

const UnwatchDialog: FC<{ svc: ServiceRowData; ctx?: string; composeFile: string }> = ({ svc, ctx, composeFile }) => (
  <dialog id={`unwatch-${svc.stack}-${svc.service}`} class="modal modal-bottom sm:modal-middle">
    <div class="modal-box pb-safe">
      <h3 class="text-base font-semibold">Stop watching {svc.service}</h3>
      <p class="mt-1 text-xs opacity-70">
        Writes shipshape.watch: "false" into {composeFile} and commits it. shipshape stops looking for newer tags for
        it; nothing running changes.
      </p>
      <WatchForm svc={svc} ctx={ctx} value="false" submit="Stop watching" primary={false} />
    </div>
    <form method="dialog" class="modal-backdrop">
      <button>close</button>
    </form>
  </dialog>
)

/** Every service the Not watched filter shows, in one commit per compose file. */
const WatchAllDialog: FC<{ n: number; files: number; q: string }> = ({ n, files, q }) => (
  <dialog id="watch-all" class="modal modal-bottom sm:modal-middle">
    <div class="modal-box pb-safe">
      <h3 class="text-base font-semibold">Watch all {n} services shown</h3>
      <p class="mt-1 text-xs opacity-70">
        Writes shipshape.watch: "true" for each of them, one commit per compose file ({files}{' '}
        {files === 1 ? 'file' : 'files'}). A service whose tags shipshape cannot read shows under Needs attention
        afterwards.
      </p>
      <form
        hx-post="/services/watch"
        hx-target="#services-list"
        hx-swap="innerHTML"
        hx-disabled-elt="find button[type=submit]"
        hx-indicator="#busy"
        data-close-dialog
      >
        <input type="hidden" name="q" value={q} />
        <div class="modal-action">
          <button type="button" class="btn btn-ghost btn-sm tap" data-close-dialog>
            Cancel
          </button>
          <button type="submit" class="btn btn-primary btn-sm tap">
            Watch {n}
          </button>
        </div>
      </form>
    </div>
    <form method="dialog" class="modal-backdrop">
      <button>close</button>
    </form>
  </dialog>
)

const RungDialog: FC<{ svc: ServiceRowData; ctx?: string }> = ({ svc, ctx }) => (
  <dialog id={`rung-${svc.stack}-${svc.service}`} class="modal modal-bottom sm:modal-middle">
    <div class="modal-box pb-safe">
      <h3 class="text-base font-semibold">Class: how much this service asks of you</h3>
      <p class="mt-1 text-xs opacity-70">
        {svc.stack}/{svc.service}. Writes shipshape.class into its compose file and commits it.
        {svc.legacyLabels ? ` It also removes the old label it replaces (${svc.legacyLabels}).` : null}
      </p>
      <form
        class="mt-3 flex flex-col gap-1.5"
        hx-post={`/services/${svc.stack}/${svc.service}/labels${ctx ? `?${ctx}` : ''}`}
        hx-target={`#svc-card-${svc.stack}-${svc.service}`}
        hx-swap="outerHTML"
        hx-disabled-elt="find button[type=submit]"
        hx-indicator="#busy"
        data-close-dialog
      >
        <input type="hidden" name="key" value="class" />
        {RUNGS.map((r) => (
          <label class="border-base-300 hover:bg-base-200 flex cursor-pointer items-start gap-3 rounded border p-2">
            <input
              type="radio"
              name="value"
              value={r.value}
              class="radio radio-sm mt-0.5"
              checked={currentRung(svc.policy) === r.value}
            />
            <span>
              <span class={r.value ? 'font-mono text-sm' : 'text-sm font-medium'}>{r.label}</span>
              <span class="block text-xs opacity-70">{r.what}</span>
            </span>
          </label>
        ))}
        <div class="modal-action">
          <button
            type="button"
            class="btn btn-ghost btn-sm tap"
            data-close-dialog
          >
            Cancel
          </button>
          <button type="submit" class="btn btn-primary btn-sm tap">
            Write it to the compose file
          </button>
        </div>
      </form>
    </div>
    <form method="dialog" class="modal-backdrop">
      <button>close</button>
    </form>
  </dialog>
)

/**
 * Where a service's release notes are, written into its compose file as `shipshape.source`
 * and `shipshape.changelog`.
 *
 * Preview first, and the write only from the preview: a wrong repository is the quiet kind
 * of wrong -- its releases read as this image's and nothing looks broken -- so the dialog
 * shows what the link leads to before it offers to commit it. The write form lives inside
 * the preview it was checked against, so what is written is what was shown.
 */
const LinkDialog: FC<{ svc: ServiceRowData; link?: ServiceDetailData['link']; ctx?: string }> = ({ svc, link, ctx }) => {
  const id = `${svc.stack}-${svc.service}`
  return (
    <dialog id={`link-${id}`} class="modal modal-bottom sm:modal-middle">
      <div class="modal-box pb-safe">
        <h3 class="text-base font-semibold">Where the release notes are</h3>
        <p class="mt-1 text-xs opacity-70">
          {svc.stack}/{svc.service}. Written into its compose file as labels, so the link travels
          with the service. Leave a box empty to remove that label.
        </p>
        <form
          class="mt-2 flex flex-col"
          hx-get={`/services/${svc.stack}/${svc.service}/link/preview${ctx ? `?${ctx}` : ''}`}
          hx-target={`#link-preview-${id}`}
          hx-swap="innerHTML"
          hx-disabled-elt="find button[type=submit]"
          hx-indicator="#busy"
        >
          <fieldset class="fieldset">
            <legend class="fieldset-legend">Upstream repository</legend>
            <input
              type="text"
              name="source"
              value={link?.source ?? ''}
              class="input input-sm w-full font-mono"
              placeholder="owner/repo, or a github.com link"
              autocomplete="off"
            />
            <p class="label whitespace-normal">
              {link?.inferred ? `Found without a label: ${link.inferred}` : 'shipshape has found no repository on its own.'}
            </p>
          </fieldset>
          <fieldset class="fieldset">
            <legend class="fieldset-legend">Release notes, when GitHub releases do not have them</legend>
            <input
              type="text"
              name="changelog"
              value={link?.changelog ?? ''}
              class="input input-sm w-full font-mono"
              placeholder="https://… or a file such as CHANGELOG.md"
              autocomplete="off"
            />
          </fieldset>
          <div class="modal-action mt-3">
            <button type="button" class="btn btn-ghost btn-sm tap" data-close-dialog>
              Cancel
            </button>
            <button type="submit" class="btn btn-sm tap">
              Preview
            </button>
          </div>
        </form>
        <div id={`link-preview-${id}`} class="mt-2" aria-live="polite"></div>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button>close</button>
      </form>
    </dialog>
  )
}

/** The preview, and from it the write. Returned alone, into the dialog it was asked from. */
export const LinkPreviewPane: FC<{ preview?: LinkPreview; failure?: string; ctx?: string }> = ({ preview, failure, ctx }) => {
  if (failure) return <p class="text-warning text-xs">{failure}</p>
  if (!preview) return null
  const p = preview
  if (!p.source && !p.changelog) {
    return <p class="text-xs opacity-70">Nothing to change: both boxes say what the compose file already says.</p>
  }
  return (
    <div class="border-base-300 flex flex-col gap-2 rounded border p-2 text-xs">
      {p.source ? <SourceLines s={p.source} runningTag={p.runningTag} /> : null}
      {p.changelog ? <NotesLines n={p.changelog} runningTag={p.runningTag} /> : null}
      {p.writable ? (
        <form
          hx-post={`/services/${p.stack}/${p.service}/labels${ctx ? `?${ctx}` : ''}`}
          hx-target={`#svc-card-${p.stack}-${p.service}`}
          hx-swap="outerHTML"
          hx-disabled-elt="find button[type=submit]"
          hx-indicator="#busy"
          data-close-dialog
        >
          <input type="hidden" name="link" value="1" />
          {p.source ? <input type="hidden" name="source" value={p.values.source} /> : null}
          {p.changelog ? <input type="hidden" name="changelog" value={p.values.changelog} /> : null}
          <div class="modal-action mt-1">
            <button type="submit" class="btn btn-primary btn-sm tap">
              Write it to the compose file
            </button>
          </div>
        </form>
      ) : (
        <p class="text-warning">Change what is marked above, then preview again.</p>
      )}
    </div>
  )
}

const SourceLines: FC<{ s: NonNullable<LinkPreview['source']>; runningTag: string | null }> = ({ s, runningTag }) => {
  if (s.removing) {
    return (
      <p>
        <span class="font-medium">shipshape.source will be removed.</span>{' '}
        {s.inferred?.repo
          ? `shipshape will use ${s.inferred.repo}, which it found without the label.`
          : 'shipshape has found no repository of its own for this image.'}
      </p>
    )
  }
  if (!s.ok) return <p class="text-error">{s.reason}</p>
  const r = s.releases
  return (
    <div class="flex flex-col gap-0.5">
      <p>
        <span class="font-mono">{s.repo}</span>
        {s.forkOf ? <span class="text-warning"> · a fork of {s.forkOf}</span> : null}
        {s.archived ? <span class="text-warning"> · archived</span> : null}
      </p>
      {r ? (
        <p class="opacity-80">
          {r.count === 0
            ? 'No GitHub releases.'
            : `${r.count === 100 ? '100 or more' : r.count} GitHub releases, the newest ${r.newest}${r.newestPrerelease ? ' (a prerelease)' : ''}.`}{' '}
          {runningTag
            ? s.runningRelease
              ? `The running version has one: ${s.runningRelease}.`
              : `None of them is the running version, ${runningTag}.`
            : null}
        </p>
      ) : null}
      {s.reason ? <p class="text-warning">{s.reason}</p> : null}
      {s.inferred?.repo && s.inferred.repo.toLowerCase() !== (s.repo ?? '').toLowerCase() ? (
        <p class="opacity-70">Without the label, shipshape found {s.inferred.repo}.</p>
      ) : null}
    </div>
  )
}

const NotesLines: FC<{ n: NonNullable<LinkPreview['changelog']>; runningTag: string | null }> = ({ n, runningTag }) => {
  if (n.removing) return <p class="font-medium">shipshape.changelog will be removed.</p>
  if (!n.ok) return <p class="text-error">{n.reason}</p>
  return (
    <div class="flex flex-col gap-0.5">
      {n.where ? (
        <p class="break-words">
          Read {Math.max(1, Math.round(n.bytes / 1024))} KB from <span class="font-mono">{n.where}</span>
        </p>
      ) : null}
      {n.reason ? <p class="text-warning">{n.reason}</p> : null}
      {n.where ? (
        <p class="opacity-80">
          {n.sections === 0
            ? 'It has no version headings, so reviews will be shown its beginning.'
            : `${n.sections} sections named for versions${runningTag ? (n.runningSection ? `, including the running ${runningTag}` : `; none for the running ${runningTag}`) : ''}.`}
        </p>
      ) : null}
      {n.excerpt ? (
        <blockquote class="border-base-300 line-clamp-4 border-l-2 pl-2 whitespace-pre-line opacity-70">{n.excerpt}</blockquote>
      ) : null}
    </div>
  )
}
