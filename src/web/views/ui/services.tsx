import type { FC } from 'hono/jsx'
import { Icon } from './icon.tsx'
import { EmptyState, Mono, Relative, Search, ServiceName, Tabs } from './parts.tsx'
import { GroupHeader, UpdateRow } from './update.tsx'
import type { UpdateView } from '../../../updates/queries.ts'

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
  /** The `shipshape.policy` label, when one is set. */
  policy?: string | null
}

export const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'watched', label: 'Watched' },
  { key: 'unlabelled', label: 'Unlabelled' },
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

function statusOf(s: ServiceRowData): { label: string; cls: string; detail?: string | null } {
  if (s.lastStatus) return { label: s.lastStatus, cls: 'badge-error', detail: s.lastDetail }
  if (s.unwatchable) return { label: s.unwatchable, cls: 'badge-ghost' }
  if (s.watched) {
    return s.constrainedFrom
      ? { label: 'pinned', cls: 'badge-warning', detail: `${s.constrainedFrom} available` }
      : { label: 'watched', cls: 'badge-success' }
  }
  return { label: 'unlabelled', cls: 'badge-warning' }
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
        <span class="lg:hidden">
          <span class={`badge badge-xs badge-soft ${st.cls}`}>{st.label}</span>
        </span>
        <span class="hidden min-w-0 truncate lg:block">
          <Mono>
            {svc.image ?? '—'}
            {svc.tag ? <span class="opacity-60">:{svc.tag}</span> : null}
          </Mono>
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

export const ServicesList: FC<{
  services: ServiceRowData[]
  grouped: boolean
  ctx: string
  selected?: { stack: string; service: string } | null
}> = ({ services, grouped, ctx, selected }) => {
  if (services.length === 0) {
    return <EmptyState icon="services" title="No services match." hint="Try another filter." />
  }
  const isSel = (s: ServiceRowData) =>
    !!selected && s.stack === selected.stack && s.service === selected.service
  if (!grouped) {
    return (
      <div class="divide-base-300 divide-y">
        {services.map((s) => (
          <ServiceRow svc={s} ctx={ctx} selected={isSel(s)} />
        ))}
      </div>
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

export interface ServiceDetailData {
  svc: ServiceRowData
  composeFile: string | null
  config: ConfigLine[]
  history: UpdateView[]
  canEdit: boolean
}

const SOURCE_CLS: Record<Provenance, string> = {
  label: 'badge-primary',
  default: 'badge-ghost',
  inferred: 'badge-ghost',
  locked: 'badge-ghost',
  none: 'badge-ghost',
}

const RUNGS = [
  { value: 'auto', what: 'shipshape merges it, unless the review objects' },
  { value: 'manual', what: 'a pull request opens; you merge it' },
  { value: 'on-request', what: 'nothing opens until you ask' },
  { value: 'skip', what: 'not tracked at all' },
  { value: '', what: 'remove the label and follow the default' },
]

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
        ) : (
          <span class="text-xs opacity-60">Not watched, so there is nothing to check.</span>
        )}
        {data.canEdit ? (
          <button
            type="button"
            class="btn btn-sm btn-ghost tap"
            data-open={`#rung-${svc.stack}-${svc.service}`}
          >
            Change policy
          </button>
        ) : null}
      </div>

      <section class="border-base-300 border-t px-4 py-3">
        <h3 class="mb-1.5 text-xs font-medium tracking-wide uppercase opacity-60">
          Effective configuration
        </h3>
        <div class="divide-base-300 border-base-300 divide-y border-y text-xs">
          {data.config.map((line) => (
            <div class="flex min-h-11 items-center gap-3 lg:min-h-7">
              <span class="w-24 shrink-0 opacity-70">{line.key}</span>
              <span class="min-w-0 flex-1 truncate font-mono">{line.value}</span>
              <span class={`badge badge-xs badge-soft ${SOURCE_CLS[line.source]}`}>
                {line.source}
              </span>
              {line.key === 'policy' && data.canEdit ? (
                <button
                  type="button"
                  class="btn btn-ghost btn-xs tap"
                  data-open={`#rung-${svc.stack}-${svc.service}`}
                >
                  Change
                </button>
              ) : null}
            </div>
          ))}
        </div>
        {data.composeFile ? (
          <p class="mt-1.5 font-mono text-xs opacity-50">{data.composeFile}</p>
        ) : null}
      </section>

      {data.canEdit ? <RungDialog svc={svc} ctx={ctx} /> : null}

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
 * Changing a rung writes the label into the compose file and commits it.
 *
 * The same guardrails as the settings page: it refuses on a dirty file rather than
 * folding a hand-edit into shipshape's commit, and the file in git stays the source of
 * truth -- which is the whole reason this can be edited from a browser at all.
 */
const RungDialog: FC<{ svc: ServiceRowData; ctx?: string }> = ({ svc, ctx }) => (
  <dialog id={`rung-${svc.stack}-${svc.service}`} class="modal modal-bottom sm:modal-middle">
    <div class="modal-box pb-safe">
      <h3 class="text-base font-semibold">How much happens without you</h3>
      <p class="mt-1 text-xs opacity-70">
        {svc.stack}/{svc.service}. Majors and digest moves always wait for a person,
        whatever this says.
      </p>
      <form
        class="mt-3 flex flex-col gap-1.5"
        hx-post={`/services/${svc.stack}/${svc.service}/labels${ctx ? `?${ctx}` : ''}`}
        hx-target={`#svc-card-${svc.stack}-${svc.service}`}
        hx-swap="outerHTML"
        hx-disabled-elt="find button[type=submit]"
        hx-indicator="#busy"
        onsubmit="this.closest('dialog').close()"
      >
        <input type="hidden" name="key" value="policy" />
        {RUNGS.map((r) => (
          <label class="border-base-300 hover:bg-base-200 flex cursor-pointer items-start gap-3 rounded border p-2">
            <input
              type="radio"
              name="value"
              value={r.value}
              class="radio radio-sm mt-0.5"
              checked={(svc.policy ?? '') === r.value}
            />
            <span>
              <span class="font-mono text-sm">{r.value || '(default)'}</span>
              <span class="block text-xs opacity-70">{r.what}</span>
            </span>
          </label>
        ))}
        <div class="modal-action">
          <button
            type="button"
            class="btn btn-ghost btn-sm tap"
            onclick="this.closest('dialog').close()"
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
