import type { FC } from 'hono/jsx'
import { EmptyState, Relative, Search, Tabs } from './parts.tsx'
import { GroupHeader } from './update.tsx'
import { clockText, dayKey } from '../../time.ts'
import { EVENT_KINDS, type ActivityRow, type EventKind } from '../../../events.ts'

/**
 * The log, readable.
 *
 * 83% of the rows in this database were two sentences repeated -- one of them 2,266
 * times -- so the page that exists to show what happened mostly showed one thing that
 * had not changed. Repetition is a count now, and this renders it as one line.
 *
 * No pane: nothing per-line exists that the row cannot show inline, so the log takes
 * the whole width and a day is a sticky header.
 */


const LEVEL_DOT: Record<string, string> = {
  info: 'bg-base-content/50',
  warn: 'bg-warning',
  error: 'bg-error',
}

const KIND_LABEL: Record<EventKind, string> = {
  scan: 'Scans',
  policy: 'Policy',
  ship: 'Ships',
  analysis: 'Reviews',
  deploy: 'Deploys',
  sync: 'Git',
  system: 'System',
}

const KIND_TABS = [{ key: 'all', label: 'All' }, ...EVENT_KINDS.map((k) => ({ key: k, label: KIND_LABEL[k] }))]

export const ActivityToolbar: FC<{ kind: string; problems: boolean; q: string }> = ({
  kind,
  problems,
  q,
}) => (
  <form
    class="flex shrink-0 items-center gap-2"
    hx-get="/activity"
    hx-target="#activity-list"
    hx-swap="innerHTML"
    hx-push-url="true"
    hx-trigger="change, input changed delay:250ms from:[data-search], search from:[data-search]"
    hx-indicator="#busy"
  >
    <Tabs name="kind" value={kind} options={KIND_TABS} label="Kind" />
    <Search value={q} placeholder="message" />
    <label class="label tap cursor-pointer gap-1.5 text-xs whitespace-nowrap">
      <input
        type="checkbox"
        name="level"
        value="problems"
        class="toggle toggle-xs"
        checked={problems}
      />
      Problems
    </label>
  </form>
)

function dayOf(iso: string): string {
  return dayKey(iso)
}

function dayLabel(day: string): string {
  const today = dayKey(new Date().toISOString())
  const yesterday = dayKey(new Date(Date.now() - 86_400_000).toISOString())
  if (day === today) return 'Today'
  if (day === yesterday) return 'Yesterday'
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

/**
 * One line at lg -- dot · time · kind · target · message · count -- and two on a phone.
 * A line with a detail is a disclosure: the whole row is the summary, so the thing you
 * tap is the row and not a 19px caret, and the detail opens under it.
 */
const LINE =
  'hover:bg-base-200/60 grid min-h-12 grid-cols-[0.5rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 px-3 py-1.5 lg:min-h-8 lg:grid-cols-[0.5rem_3rem_4.5rem_minmax(0,10rem)_minmax(0,1fr)_2.5rem] lg:gap-x-3 lg:py-0'

const ActivityLine: FC<{ row: ActivityRow }> = ({ row: r }) => {
  const cells = (
    <>
      <span aria-hidden="true" class={`size-2 rounded-full ${LEVEL_DOT[r.level] ?? 'bg-base-content/50'}`} />
      {r.level === 'error' || r.level === 'warn' ? (
        <span class="sr-only">{r.level === 'error' ? 'Error:' : 'Warning:'}</span>
      ) : null}
      {/* phone: line 1 is target + when */}
      <span class="min-w-0 truncate text-xs opacity-70 lg:hidden">
        <span class="badge badge-xs badge-ghost mr-1">{KIND_LABEL[r.kind as EventKind] ?? r.kind}</span>
        {r.stack ? (
          <>
            {r.stack}
            {r.service ? `/${r.service}` : ''}
          </>
        ) : null}
      </span>
      <span class="lg:hidden">
        <Relative at={r.lastAt ?? r.at} />
      </span>
      {/* lg cells */}
      <time datetime={r.lastAt ?? r.at} data-format="clock" class="hidden font-mono text-xs opacity-70 lg:block">
        {clockText(r.lastAt ?? r.at)}
      </time>
      <span class="hidden lg:block">
        <span class="badge badge-xs badge-ghost">{KIND_LABEL[r.kind as EventKind] ?? r.kind}</span>
      </span>
      <span class="hidden min-w-0 truncate text-xs lg:block">
        {r.stack ? (
          <a href={`/services/${r.stack}/${r.service ?? ''}`} class="link-hover opacity-80">
            {r.stack}
            {r.service ? `/${r.service}` : ''}
          </a>
        ) : null}
      </span>
      <span class="col-span-2 flex min-w-0 items-center gap-1 text-sm lg:col-span-1">
        <span class="truncate">{r.message}</span>
        {r.detail ? <span class="text-xs opacity-70 group-open/line:hidden">…</span> : null}
      </span>
      <span class="hidden text-right lg:block">
        {r.count > 1 ? <span class="badge badge-xs badge-ghost">×{r.count}</span> : null}
      </span>
      {/* phone: the count rides on line 2's right */}
      {r.count > 1 ? (
        <span class="col-start-3 row-start-2 lg:hidden">
          <span class="badge badge-xs badge-ghost">×{r.count}</span>
        </span>
      ) : null}
    </>
  )
  if (!r.detail) return <div class={LINE}>{cells}</div>
  return (
    <details class="group/line">
      <summary class={`${LINE} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>
        {cells}
      </summary>
      <p class="px-3 pb-2 pl-7 font-mono text-xs break-words whitespace-pre-wrap opacity-70 lg:pl-[10.75rem]">
        {r.detail}
      </p>
    </details>
  )
}

export const ActivityList: FC<{ rows: ActivityRow[]; more?: string | null; filtered: boolean }> = ({
  rows,
  more,
  filtered,
}) => {
  if (rows.length === 0) {
    return filtered ? (
      <EmptyState icon="activity" title="Nothing logged for this filter." />
    ) : (
      <EmptyState
        icon="activity"
        title="Nothing has happened yet."
        hint="Scans, ships, deploys and reviews are written here as they happen."
      />
    )
  }
  const days = new Map<string, ActivityRow[]>()
  for (const r of rows) {
    const day = dayOf(r.lastAt ?? r.at)
    const list = days.get(day) ?? []
    list.push(r)
    days.set(day, list)
  }
  return (
    <div>
      {[...days].map(([day, list]) => (
        <section>
          <GroupHeader title={dayLabel(day)} count={list.length} />
          <div class="divide-base-300 divide-y">
            {list.map((r) => (
              <ActivityLine row={r} />
            ))}
          </div>
        </section>
      ))}
      {more ? (
        <div class="flex justify-center py-2">
          {/* The wrapper is what the next page replaces, or the rows would land centred. */}
          <button
            type="button"
            class="btn btn-ghost btn-xs tap"
            hx-get={more}
            hx-target="closest div"
            hx-swap="outerHTML"
            hx-indicator="#busy"
          >
            Load more
          </button>
        </div>
      ) : null}
    </div>
  )
}
