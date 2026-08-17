import type { FC } from 'hono/jsx'
import { Icon } from './icon.tsx'
import { EmptyState, Mono, Relative, ServiceName } from './parts.tsx'
import { UpdateCard } from './update.tsx'
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
}

export const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'watched', label: 'Watched' },
  { key: 'unlabelled', label: 'Unlabelled' },
  { key: 'unwatchable', label: 'Not watchable' },
  { key: 'attention', label: 'Needs attention' },
] as const

export const ServicesToolbar: FC<{ filter: string; q: string; grouped: boolean }> = ({
  filter,
  q,
  grouped,
}) => (
  <form
    class="flex flex-wrap items-center gap-2"
    hx-get="/fragments/services"
    hx-target="#services-list"
    hx-swap="innerHTML"
    hx-push-url="true"
    hx-trigger="change, input changed delay:250ms from:[data-search], search from:[data-search]"
    hx-indicator="#busy"
  >
    <div class="filter">
      {FILTERS.map((f) => (
        <input
          type="radio"
          name="filter"
          value={f.key}
          class="btn btn-sm tap md:min-h-8"
          aria-label={f.label}
          checked={f.key === filter}
        />
      ))}
    </div>
    <label class="input input-sm tap w-full max-w-56 md:min-h-8">
      <input
        type="search"
        name="q"
        value={q}
        data-search
        placeholder="stack, service or image"
        class="grow"
      />
    </label>
    <label class="label tap cursor-pointer gap-2 text-sm md:min-h-8">
      <input
        type="checkbox"
        name="group"
        value="stack"
        class="toggle toggle-sm"
        checked={grouped}
      />
      Group by stack
    </label>
  </form>
)

function statusOf(s: ServiceRowData): { label: string; cls: string; detail?: string | null } {
  if (s.lastStatus) return { label: s.lastStatus, cls: 'badge-error', detail: s.lastDetail }
  if (s.unwatchable) return { label: s.unwatchable, cls: 'badge-neutral' }
  if (s.watched) {
    return s.constrainedFrom
      ? { label: 'pinned', cls: 'badge-warning', detail: `${s.constrainedFrom} available` }
      : { label: 'watched', cls: 'badge-success' }
  }
  return { label: 'unlabelled', cls: 'badge-warning' }
}

export const ServiceRow: FC<{ svc: ServiceRowData; grouped?: boolean }> = ({ svc, grouped }) => {
  const st = statusOf(svc)
  return (
    <div
      id={`svc-${svc.stack}-${svc.service}`}
      class="border-base-300 hover:bg-base-200/50 flex items-center gap-3 border-b px-3 py-2 last:border-0"
    >
      <a
        href={`/services/${svc.stack}/${svc.service}`}
        data-row
        hx-get={`/services/${svc.stack}/${svc.service}/panel`}
        hx-target="#sheet-body"
        hx-swap="innerHTML"
        hx-trigger="click[matchMedia('(min-width:1024px)').matches]"
        hx-indicator="#busy"
        class="focus-visible:outline-primary tap flex min-w-0 flex-1 flex-col justify-center focus-visible:outline-2"
      >
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          {grouped ? (
            <span class="font-medium">{svc.service}</span>
          ) : (
            <ServiceName stack={svc.stack} service={svc.service} />
          )}
          <span class={`badge badge-xs badge-soft ${st.cls}`}>{st.label}</span>
        </div>
        <div class="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs opacity-60">
          <Mono>{svc.image ?? '—'}</Mono>
          {svc.tag ? <Mono>:{svc.tag}</Mono> : null}
        </div>
        {st.detail ? <div class="text-error/80 mt-0.5 text-xs">{st.detail}</div> : null}
      </a>
      {svc.watched ? (
        <button
          type="button"
          class="btn btn-ghost btn-sm btn-square tap"
          aria-label={`Check ${svc.service} now`}
          title="Check now"
          hx-post={`/services/${svc.stack}/${svc.service}/check`}
          hx-target={`#svc-${svc.stack}-${svc.service}`}
          hx-swap="outerHTML"
          hx-disabled-elt="this"
          hx-indicator="#busy"
        >
          <Icon name="refresh" />
        </button>
      ) : null}
    </div>
  )
}

export const ServicesList: FC<{ services: ServiceRowData[]; grouped: boolean }> = ({
  services,
  grouped,
}) => {
  if (services.length === 0) {
    return <EmptyState icon="services" title="No services match." hint="Try another filter." />
  }
  if (!grouped) {
    return (
      <div class="card card-border bg-base-100">
        {services.map((s) => (
          <ServiceRow svc={s} />
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
    <div class="flex flex-col gap-4">
      {[...stacks].map(([stack, rows]) => (
        <section>
          <h2 class="mb-1 flex items-baseline gap-2 px-1 text-sm font-semibold">
            {stack}
            <span class="text-xs font-normal opacity-50">
              {rows.filter((r) => r.watched).length}/{rows.length} watched
            </span>
          </h2>
          <div class="card card-border bg-base-100">
            {rows.map((s) => (
              <ServiceRow svc={s} grouped />
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
  default: 'badge-neutral',
  inferred: 'badge-neutral',
  locked: 'badge-neutral',
  none: 'badge-neutral',
}

const RUNGS = [
  { value: 'auto', what: 'shipshape merges it, unless the review objects' },
  { value: 'manual', what: 'a pull request opens; you merge it' },
  { value: 'on-request', what: 'nothing opens until you ask' },
  { value: 'skip', what: 'not tracked at all' },
  { value: '', what: 'remove the label and follow the default' },
]

export const ServiceDetail: FC<{ data: ServiceDetailData }> = ({ data }) => {
  const { svc } = data
  const st = statusOf(svc)
  return (
    <div class="flex flex-col gap-5">
      <div id={`svc-card-${svc.stack}-${svc.service}`} class="flex flex-col gap-4">
        <header class="flex flex-col gap-1">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="text-lg font-semibold">
              <ServiceName stack={svc.stack} service={svc.service} />
            </h2>
            <span class={`badge badge-sm badge-soft ${st.cls}`}>{st.label}</span>
          </div>
          <Mono>
            {svc.image ?? 'no image'}
            {svc.tag ? `:${svc.tag}` : ''}
          </Mono>
          {st.detail ? <p class="text-error/80 text-xs">{st.detail}</p> : null}
          <div class="mt-1 flex items-center gap-2">
            <button
              type="button"
              class="btn btn-sm btn-ghost tap gap-1"
              hx-post={`/services/${svc.stack}/${svc.service}/check`}
              hx-target={`#svc-card-${svc.stack}-${svc.service}`}
              hx-swap="outerHTML"
              hx-disabled-elt="this"
              hx-indicator="#busy"
            >
              <Icon name="refresh" />
              Check now
            </button>
            {svc.lastSeenAt ? (
              <span class="text-xs opacity-50">
                seen <Relative at={svc.lastSeenAt} />
              </span>
            ) : null}
          </div>
        </header>

        <section>
          <h3 class="mb-2 text-xs font-medium tracking-wide uppercase opacity-60">
            Effective configuration
          </h3>
          <div class="card card-border bg-base-100">
            {data.config.map((line) => (
              <div class="border-base-300 flex items-center gap-3 border-b px-3 py-2 text-sm last:border-0">
                <span class="w-28 shrink-0 opacity-70">{line.key}</span>
                <span class="min-w-0 flex-1 font-mono text-xs">{line.value}</span>
                <span class={`badge badge-xs badge-soft ${SOURCE_CLS[line.source]}`}>
                  {line.source}
                </span>
                {line.key === 'policy' && data.canEdit ? (
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs"
                    data-open={`#rung-${svc.stack}-${svc.service}`}
                  >
                    Change
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          {data.composeFile ? (
            <p class="mt-2 font-mono text-xs opacity-50">{data.composeFile}</p>
          ) : null}
        </section>
      </div>

      {data.canEdit ? <RungDialog svc={svc} /> : null}

      <section>
        <h3 class="mb-2 text-xs font-medium tracking-wide uppercase opacity-60">History</h3>
        {data.history.length === 0 ? (
          <p class="text-sm opacity-60">Nothing has been detected for this service yet.</p>
        ) : (
          <div class="flex flex-col gap-2">
            {data.history.slice(0, 12).map((u) => (
              <UpdateCard update={u} />
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
const RungDialog: FC<{ svc: ServiceRowData }> = ({ svc }) => (
  <dialog id={`rung-${svc.stack}-${svc.service}`} class="modal modal-bottom sm:modal-middle">
    <div class="modal-box pb-safe">
      <h3 class="text-lg font-semibold">How much happens without you</h3>
      <p class="mt-1 text-sm opacity-70">
        {svc.stack}/{svc.service}. Majors and digest moves always wait for a person,
        whatever this says.
      </p>
      <form
        class="mt-4 flex flex-col gap-2"
        hx-post={`/services/${svc.stack}/${svc.service}/labels`}
        hx-target={`#svc-card-${svc.stack}-${svc.service}`}
        hx-swap="outerHTML"
        hx-disabled-elt="find button[type=submit]"
        hx-indicator="#busy"
        onsubmit="this.closest('dialog').close()"
      >
        <input type="hidden" name="key" value="policy" />
        {RUNGS.map((r) => (
          <label class="border-base-300 hover:bg-base-200 flex cursor-pointer items-start gap-3 rounded border p-2">
            <input type="radio" name="value" value={r.value} class="radio radio-sm mt-0.5" />
            <span>
              <span class="font-mono text-sm">{r.value || '(default)'}</span>
              <span class="block text-xs opacity-70">{r.what}</span>
            </span>
          </label>
        ))}
        <div class="modal-action">
          <button type="button" class="btn btn-ghost btn-sm tap" onclick="this.closest('dialog').close()">
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
