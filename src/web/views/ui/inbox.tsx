import { OUTCOMES } from '../../../updates/vocabulary.ts'
import type { FC } from 'hono/jsx'
import { Icon, type IconName } from './icon.tsx'
import { Change, EmptyState, ExtLink, Relative, ServiceName, relative } from './parts.tsx'
import { GroupHeader, UpdateRow } from './update.tsx'
import type { AttentionItem, AttentionKind, RecentItem, UpdateView } from '../../../updates/queries.ts'
import type { SetupState } from '../../onboarding.ts'

/**
 * The first screen: what is waiting on you, then what happened without you.
 *
 * On a desktop the two live side by side -- the list of what needs you, and, until you
 * pick something, the recent history in the pane. On a phone the list is the page and
 * the history is a section under it.
 */

const GROUPS: Record<AttentionKind, { title: string; hint: string; icon: IconName }> = {
  broken: {
    title: 'Broken',
    hint: 'a deploy failed, rolled back or went degraded, and nothing newer has replaced it',
    icon: 'alert',
  },
  decision: {
    title: 'Waiting on you',
    hint: 'one question each: ship, snooze, always ship or skip',
    icon: 'rocket',
  },
  'ready-to-deploy': {
    title: 'Ready to deploy',
    hint: 'shipped, waiting for you to press Deploy',
    icon: 'rocket',
  },
  'rolling-moved': {
    title: 'Rolling tag moved',
    hint: 'nothing to change in git — redeploy to adopt it',
    icon: 'refresh',
  },
}

/** Read from the one vocabulary, so a line here says what the row's badge says. */
const RECENT = Object.fromEntries(
  Object.entries(OUTCOMES).map(([k, w]) => [k, { cls: w.dotCls, verb: w.verb }]),
) as Record<RecentItem['kind'], { cls: string; verb: string }>

export interface InboxData {
  needsYou: AttentionItem[]
  recent: RecentItem[]
  parked: UpdateView[]
  /** Nothing holds these but Pause. */
  pausedOnly: UpdateView[]
  setup: SetupState
  scan: { lastAt: number | null; nextAt: string | null; running: boolean; watched: number }
}

/**
 * The Scan-now button, for the toolbar. Its answer lands in the sidebar's scan chip
 * (`#scan-status`), which is the poll's on-switch; the toast says it started.
 */
export const ScanControls: FC<{ scan: InboxData['scan'] }> = ({ scan }) => (
  <button
    type="button"
    class="btn btn-ghost btn-sm tap gap-1"
    hx-post="/scan"
    hx-target="#scan-status"
    hx-swap="innerHTML"
    hx-disabled-elt="this"
    hx-indicator="#busy"
    aria-label="Scan now"
    title="Scan now"
    disabled={scan.running || undefined}
  >
    <Icon name="refresh" class="size-3.5" />
    <span class="hidden lg:inline">{scan.running ? 'Scanning…' : 'Scan now'}</span>
  </button>
)

/** What a new install still needs, in order; it ticks itself off on the Inbox's poll. */
export const SetupChecklist: FC<{ setup: SetupState }> = ({ setup }) => (
  <section aria-labelledby="setup-title" class="border-base-300 border-b px-3 py-3">
    <h2 id="setup-title" class="text-sm font-semibold">
      Getting started
    </h2>
    <p class="text-xs opacity-70">
      {setup.done} of {setup.required} done
    </p>
    <ol class="mt-2 flex flex-col gap-2">
      {setup.steps.map((s, i) => (
        <li class={s.done ? 'flex gap-2.5 opacity-70' : 'flex gap-2.5'}>
          {s.done ? (
            <>
              <Icon name="check" class="text-success mt-0.5 size-4 shrink-0" />
              <span class="sr-only">Done:</span>
            </>
          ) : (
            <span class="badge badge-sm badge-ghost mt-0.5 shrink-0 font-mono">{i + 1}</span>
          )}
          <div class="min-w-0">
            <p class="text-sm font-medium">
              {s.title}
              {s.optional ? <span class="badge badge-xs badge-ghost ml-1.5 align-middle">optional</span> : null}
            </p>
            <p class="text-xs opacity-70">{s.body}</p>
            {s.done || !s.action ? null : s.action.kind === 'scan' ? (
              <button
                type="button"
                class="btn btn-primary btn-xs tap mt-1"
                hx-post="/scan"
                hx-target="#scan-status"
                hx-swap="innerHTML"
                hx-disabled-elt="this"
                hx-indicator="#busy"
              >
                {s.action.label}
              </button>
            ) : s.action.href.startsWith('https://') ? (
              <ExtLink href={s.action.href} class="link link-primary tap inline-flex items-center text-xs">
                {s.action.label} →
              </ExtLink>
            ) : (
              <a href={s.action.href} class="link link-primary tap inline-flex items-center text-xs">
                {s.action.label} →
              </a>
            )}
          </div>
        </li>
      ))}
    </ol>
  </section>
)

/** The list: groups of rows, worst first, with sticky headers. */
export const InboxList: FC<{ data: InboxData; selectedId?: number }> = ({ data, selectedId }) => {
  const groups = new Map<AttentionKind, AttentionItem[]>()
  for (const item of data.needsYou) {
    const list = groups.get(item.kind) ?? []
    list.push(item)
    groups.set(item.kind, list)
  }
  const ctx = 'list=inbox'
  return (
    <div
      id="inbox"
      hx-get="/fragments/inbox"
      hx-trigger="every 60s, scan-progress from:body"
      hx-swap="innerHTML"
    >
      {data.setup.complete ? null : <SetupChecklist setup={data.setup} />}
      {groups.size > 0 ? null : !data.setup.complete || data.pausedOnly.length > 0 ? null : (
        <EmptyState
          icon="check"
          title="Nothing needs you."
          hint={
            data.scan.nextAt ? (
              <>
                Everything tracked is current or on its way. Next scan{' '}
                <time datetime={data.scan.nextAt} data-format="relative">
                  {relative(data.scan.nextAt)}
                </time>
                .
              </>
            ) : (
              'Everything tracked is current or on its way.'
            )
          }
        />
      )}
      {[...groups].map(([kind, items]) => (
          <section>
            <GroupHeader
              title={GROUPS[kind].title}
              count={items.length}
              hint={GROUPS[kind].hint}
              icon={GROUPS[kind].icon}
            />
            <div class="divide-base-300 divide-y">
              {items.map((i) => (
                <UpdateRow update={i.update} ctx={ctx} selected={i.update.id === selectedId} />
              ))}
            </div>
          </section>
        ))}

      {data.pausedOnly.length > 0 ? (
        <section>
          <GroupHeader
            title="Ships when you unpause"
            count={data.pausedOnly.length}
            hint="nothing holds these; Pause does"
            icon="pause"
          />
          <div class="divide-base-300 divide-y">
            {data.pausedOnly.map((u) => (
              <UpdateRow update={u} ctx={ctx} selected={u.id === selectedId} />
            ))}
          </div>
        </section>
      ) : null}

      {data.parked.length > 0 ? (
        <details class="group/parked">
          <summary class="border-base-300 hover:bg-base-200/60 flex min-h-11 cursor-pointer items-center gap-2 border-y px-3 text-xs opacity-70 lg:min-h-8 [&::-webkit-details-marker]:hidden">
            <Icon name="chevron-right" class="size-3.5 transition-transform group-open/parked:rotate-90" />
            {data.parked.length} parked
            <span class="hidden truncate normal-case lg:inline">
              · frozen services and snoozed decisions; ship one when you want it
            </span>
          </summary>
          <div class="divide-base-300 divide-y">
            {data.parked.map((u) => (
              <UpdateRow update={u} ctx={ctx} selected={u.id === selectedId} />
            ))}
          </div>
        </details>
      ) : null}

      {/* On a phone the history is a section under the list; on a desktop it lives in the
          pane instead, so this copy is hidden there. */}
      <div class="lg:hidden">
        <RecentList recent={data.recent} />
      </div>
    </div>
  )
}

const RecentList: FC<{ recent: RecentItem[]; hint?: string }> = ({ recent, hint }) => (
  <section>
    <GroupHeader title="Recently" hint={hint} />
    {recent.length === 0 ? (
      <p class="px-3 py-3 text-xs opacity-60">Nothing has happened in the last day.</p>
    ) : (
      <ul class="divide-base-300 divide-y">
        {recent.map((r) => (
          <li>
            <a
              href={`/updates/${r.updateId}?list=inbox`}
              hx-get={`/updates/${r.updateId}/panel?list=inbox`}
              hx-target="#pane"
              hx-swap="innerHTML scroll:top"
              hx-push-url={`/updates/${r.updateId}?list=inbox`}
              hx-indicator="#busy"
              class="hover:bg-base-200/60 flex min-h-11 items-center gap-2 px-3 py-1 text-xs lg:min-h-7"
            >
              <span class={`size-1.5 shrink-0 rounded-full ${RECENT[r.kind].cls}`} />
              <span class="min-w-0 flex-1 truncate">
                <ServiceName stack={r.stack} service={r.service} />{' '}
                <span class="opacity-70">{RECENT[r.kind].verb}</span>{' '}
                <Change from={r.fromTag} to={r.toTag} />
              </span>
              <Relative at={r.at} />
            </a>
          </li>
        ))}
      </ul>
    )}
    <a href="/activity" class="link link-hover flex min-h-11 items-center px-3 text-xs opacity-70 lg:min-h-8">
      All activity →
    </a>
  </section>
)

/** What the pane shows when nothing is selected: the night's history and the clocks. */
export const InboxAside: FC<{ data: InboxData }> = ({ data }) => (
  <div class="lg:max-w-4xl">
    <RecentList recent={data.recent} hint="what happened without you, last 24 hours" />
  </div>
)
