import type { FC } from 'hono/jsx'
import { Icon, type IconName } from './icon.tsx'
import { Change, EmptyState, Relative, ScanStatus, ServiceName } from './parts.tsx'
import { GroupHeader, UpdateRow } from './update.tsx'
import type { AttentionItem, AttentionKind, RecentItem, UpdateView } from '../../../updates/queries.ts'

/**
 * The first screen: what is waiting on you, then what happened without you.
 *
 * On a desktop the two live side by side -- the list of what needs you, and, until you
 * pick something, the recent history in the pane. On a phone the list is the page and
 * the history is a section under it.
 */

const GROUPS: Record<AttentionKind, { title: string; hint: string; icon: IconName }> = {
  'deploy-failed': {
    title: 'Deploy failed',
    hint: 'the change is in the tree and the service is not running it',
    icon: 'alert',
  },
  'rolled-back': {
    title: 'Rolled back',
    hint: 'it failed verification and the previous version was put back',
    icon: 'undo',
  },
  degraded: {
    title: 'Degraded after the soak',
    hint: 'it came up, then stopped looking healthy; nothing was reverted',
    icon: 'alert',
  },
  'ready-to-deploy': {
    title: 'Ready to deploy',
    hint: 'merged and waiting, because shipshape is paused',
    icon: 'rocket',
  },
  'pr-waiting': {
    title: 'Waiting for you',
    hint: 'a pull request is open and nothing merges it but you',
    icon: 'pull-request',
  },
  'on-request': {
    title: 'Held on request',
    hint: 'datastores and migrations: listed until you ask for the pull request',
    icon: 'clock',
  },
  'rolling-moved': {
    title: 'Rolling tags moved',
    hint: 'nothing to change in git — redeploy to adopt it',
    icon: 'refresh',
  },
  'review-failed': {
    title: 'Changelog unread',
    hint: 'the review could not run, so nothing has read these release notes',
    icon: 'eye',
  },
}

const RECENT: Record<RecentItem['kind'], { cls: string; verb: string }> = {
  opened: { cls: 'bg-info', verb: 'opened' },
  merged: { cls: 'bg-info', verb: 'merged' },
  deployed: { cls: 'bg-info', verb: 'deployed' },
  verified: { cls: 'bg-success', verb: 'verified' },
  degraded: { cls: 'bg-warning', verb: 'went degraded' },
  failed: { cls: 'bg-error', verb: 'failed to deploy' },
  'rolled-back': { cls: 'bg-error', verb: 'was rolled back' },
  skipped: { cls: 'bg-base-300', verb: 'skipped' },
  superseded: { cls: 'bg-base-300', verb: 'superseded' },
}

export interface InboxData {
  needsYou: AttentionItem[]
  recent: RecentItem[]
  parked: UpdateView[]
  scan: { lastAt: number | null; nextAt: string | null; running: boolean; watched: number }
}

/** The scan chip and the Scan-now button, for the toolbar. */
export const ScanControls: FC<{ scan: InboxData['scan'] }> = ({ scan }) => (
  <>
    <span id="scan-status" class="hidden text-xs opacity-70 lg:inline">
      {scan.running ? (
        <ScanStatus running lastAt={null} />
      ) : scan.lastAt ? (
        <>
          scanned <Relative at={new Date(scan.lastAt).toISOString()} />
        </>
      ) : (
        'never scanned'
      )}
    </span>
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
    >
      <Icon name="refresh" class="size-3.5" />
      <span class="hidden lg:inline">Scan now</span>
    </button>
  </>
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
      hx-trigger="every 10s [document.getElementById('scan-running')], every 60s"
      hx-swap="innerHTML"
    >
      {groups.size === 0 ? (
        <EmptyState
          icon="check"
          title="Nothing needs you."
          hint={
            data.scan.nextAt
              ? `Everything tracked is current or on its way. Next scan ${relativeish(data.scan.nextAt)}.`
              : 'Everything tracked is current or on its way.'
          }
        />
      ) : (
        [...groups].map(([kind, items]) => (
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
        ))
      )}

      {data.parked.length > 0 ? (
        <details class="group/parked">
          <summary class="border-base-300 hover:bg-base-200/60 flex min-h-11 cursor-pointer items-center gap-2 border-y px-3 text-xs opacity-70 lg:min-h-8 [&::-webkit-details-marker]:hidden">
            <Icon name="chevron-right" class="size-3.5 transition-transform group-open/parked:rotate-90" />
            {data.parked.length} tracked, not opening a pull request
            <span class="hidden truncate normal-case lg:inline">
              · another updater applies these; shipshape coexists with it
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

const RecentList: FC<{ recent: RecentItem[] }> = ({ recent }) => (
  <section>
    <GroupHeader title="Recently" />
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
  <div>
    <div class="border-base-300 flex h-10 items-center gap-4 border-b px-4 text-xs opacity-70">
      <span>
        {/* Plain text here, not the chip: the chip's id is the poll's on-switch and must
            exist exactly once, in the toolbar. */}
        {data.scan.running ? (
          <span class="text-info">scanning…</span>
        ) : data.scan.lastAt ? (
          <>
            last scan <Relative at={new Date(data.scan.lastAt).toISOString()} />
          </>
        ) : (
          'never scanned'
        )}
      </span>
      {data.scan.nextAt && !data.scan.running ? (
        <span>
          next <Relative at={data.scan.nextAt} />
        </span>
      ) : null}
      <span>{data.scan.watched} watched</span>
    </div>
    <RecentList recent={data.recent} />
  </div>
)

function relativeish(iso: string): string {
  const mins = Math.round((Date.parse(iso) - Date.now()) / 60_000)
  if (mins < 60) return `in ${Math.max(1, mins)}m`
  if (mins < 1440) return `in ${Math.round(mins / 60)}h`
  return `in ${Math.round(mins / 1440)}d`
}
