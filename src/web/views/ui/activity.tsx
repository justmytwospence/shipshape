import type { FC } from 'hono/jsx'
import { EmptyState, Relative } from './parts.tsx'

/**
 * The log, readable.
 *
 * 83% of the rows in this database were two sentences repeated -- one of them 2,266
 * times -- so the page that exists to show what happened mostly showed one thing that
 * had not changed. Repetition is a count now, and this renders it as one.
 */

export const KINDS = ['scan', 'policy', 'pr', 'analysis', 'deploy', 'sync', 'system'] as const
export type EventKind = (typeof KINDS)[number]

export interface ActivityRow {
  id: number
  at: string
  lastAt: string | null
  count: number
  level: 'info' | 'warn' | 'error'
  kind: string
  stack: string | null
  service: string | null
  message: string
  detail: string | null
}

const LEVEL_DOT: Record<string, string> = {
  info: 'bg-base-300',
  warn: 'bg-warning',
  error: 'bg-error',
}

export const ActivityToolbar: FC<{ kind: string; problems: boolean; q: string }> = ({
  kind,
  problems,
  q,
}) => (
  <form
    class="flex flex-wrap items-center gap-2"
    hx-get="/fragments/activity"
    hx-target="#activity-list"
    hx-swap="innerHTML"
    hx-push-url="true"
    hx-trigger="change, input changed delay:250ms from:[data-search], search from:[data-search]"
    hx-indicator="#busy"
  >
    <div class="filter">
      <input
        type="radio"
        name="kind"
        value="all"
        class="btn btn-sm tap md:min-h-8"
        aria-label="All"
        checked={kind === 'all'}
      />
      {KINDS.map((k) => (
        <input
          type="radio"
          name="kind"
          value={k}
          class="btn btn-sm tap md:min-h-8"
          aria-label={k}
          checked={k === kind}
        />
      ))}
    </div>
    <label class="input input-sm tap w-full max-w-48 md:min-h-8">
      <input type="search" name="q" value={q} data-search placeholder="message" class="grow" />
    </label>
    <label class="label tap cursor-pointer gap-2 text-sm md:min-h-8">
      <input
        type="checkbox"
        name="level"
        value="problems"
        class="toggle toggle-sm"
        checked={problems}
      />
      Problems only
    </label>
  </form>
)

/** `#41` becomes a link, because it is the only thing in a log line worth clicking. */
function linkify(message: string, repo: string): unknown[] {
  const parts: unknown[] = []
  let last = 0
  for (const m of message.matchAll(/#(\d+)/g)) {
    const at = m.index ?? 0
    if (at > last) parts.push(message.slice(last, at))
    parts.push(
      <a
        href={`https://github.com/${repo}/pull/${m[1]}`}
        target="_blank"
        rel="noreferrer"
        class="link link-hover"
      >
        {m[0]}
      </a>,
    )
    last = at + m[0].length
  }
  if (last < message.length) parts.push(message.slice(last))
  return parts
}

function dayOf(iso: string): string {
  return iso.slice(0, 10)
}

function dayLabel(day: string): string {
  const today = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  if (day === today) return 'Today'
  if (day === yesterday) return 'Yesterday'
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
  })
}

export const ActivityList: FC<{ rows: ActivityRow[]; repo: string; more?: string | null }> = ({
  rows,
  repo,
  more,
}) => {
  if (rows.length === 0) {
    return <EmptyState icon="activity" title="Nothing logged for this filter." />
  }
  const days = new Map<string, ActivityRow[]>()
  for (const r of rows) {
    const day = dayOf(r.lastAt ?? r.at)
    const list = days.get(day) ?? []
    list.push(r)
    days.set(day, list)
  }
  return (
    <div class="flex flex-col gap-4">
      {[...days].map(([day, list]) => (
        <section>
          <h2 class="mb-1 px-1 text-xs font-medium tracking-wide uppercase opacity-50">
            {dayLabel(day)}
          </h2>
          <div class="card card-border bg-base-100">
            {list.map((r) => (
              <div class="border-base-300 flex items-start gap-2.5 border-b px-3 py-2 text-sm last:border-0">
                <span
                  class={`mt-1.5 size-2 shrink-0 rounded-full ${LEVEL_DOT[r.level] ?? 'bg-base-300'}`}
                />
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-baseline gap-x-2">
                    <span class="badge badge-xs badge-ghost">{r.kind}</span>
                    {r.stack ? (
                      <a
                        href={`/services/${r.stack}/${r.service ?? ''}`}
                        class="link-hover text-xs opacity-70"
                      >
                        {r.stack}
                        {r.service ? `/${r.service}` : ''}
                      </a>
                    ) : null}
                  </div>
                  <div class="mt-0.5">{linkify(r.message, repo)}</div>
                  {r.detail ? (
                    <div class="line-clamp-2 text-xs opacity-60">{r.detail}</div>
                  ) : null}
                </div>
                <div class="flex shrink-0 flex-col items-end gap-0.5">
                  <Relative at={r.lastAt ?? r.at} />
                  {r.count > 1 ? (
                    <span
                      class="badge badge-xs badge-neutral badge-soft"
                      title={`first seen ${r.at}`}
                    >
                      ×{r.count}
                    </span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
      {more ? (
        <button
          type="button"
          class="btn btn-ghost btn-sm tap self-center"
          hx-get={more}
          hx-target="this"
          hx-swap="outerHTML"
          hx-indicator="#busy"
        >
          Load more
        </button>
      ) : null}
    </div>
  )
}
