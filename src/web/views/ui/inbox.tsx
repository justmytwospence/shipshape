import type { FC } from 'hono/jsx'
import { Icon, type IconName } from './icon.tsx'
import { Change, EmptyState, Relative, ScanStatus, ServiceName } from './parts.tsx'
import { UpdateCard } from './update.tsx'
import type { AttentionItem, AttentionKind, RecentItem, UpdateView } from '../../../updates/queries.ts'

/**
 * The first screen: what is waiting on you, then what happened without you.
 *
 * The page it replaces led with four counters and a table of everything in three states,
 * which answers "how many things exist" -- a question nobody has. These two lists answer
 * the two that get asked: is there anything for me to do, and did last night go fine.
 */

const GROUPS: Record<AttentionKind, { title: string; hint: string; icon: IconName }> = {
  'deploy-failed': {
    title: 'Deploy failed',
    hint: 'The change is in the tree and the service is not running it.',
    icon: 'alert',
  },
  'rolled-back': {
    title: 'Rolled back',
    hint: 'It failed verification and the previous version was put back.',
    icon: 'undo',
  },
  degraded: {
    title: 'Degraded after the soak',
    hint: 'It came up, then stopped looking healthy. Nothing was reverted — by then a migration may have run.',
    icon: 'alert',
  },
  'ready-to-deploy': {
    title: 'Ready to deploy',
    hint: 'Merged and waiting, because shipshape is paused.',
    icon: 'rocket',
  },
  'pr-waiting': {
    title: 'Waiting for you',
    hint: 'A pull request is open and nothing merges it but you.',
    icon: 'pull-request',
  },
  'on-request': {
    title: 'Held on request',
    hint: 'Datastores and migrations: listed until you ask for the pull request.',
    icon: 'clock',
  },
  'rolling-moved': {
    title: 'Rolling tags moved',
    hint: 'The tag points somewhere new. There is nothing to change in git — redeploy to adopt it.',
    icon: 'refresh',
  },
  'review-failed': {
    title: 'Changelog unread',
    hint: 'The review could not run, so nothing has read these release notes.',
    icon: 'eye',
  },
}

const RECENT: Record<RecentItem['kind'], { icon: IconName; cls: string; verb: string }> = {
  opened: { icon: 'pull-request', cls: 'status-info', verb: 'opened' },
  merged: { icon: 'merge', cls: 'status-info', verb: 'merged' },
  deployed: { icon: 'rocket', cls: 'status-info', verb: 'deployed' },
  verified: { icon: 'check', cls: 'status-success', verb: 'verified' },
  degraded: { icon: 'alert', cls: 'status-warning', verb: 'went degraded' },
  failed: { icon: 'alert', cls: 'status-error', verb: 'failed to deploy' },
  'rolled-back': { icon: 'undo', cls: 'status-error', verb: 'was rolled back' },
  skipped: { icon: 'skip', cls: 'status-neutral', verb: 'skipped' },
  superseded: { icon: 'x', cls: 'status-neutral', verb: 'superseded' },
}

export interface InboxData {
  needsYou: AttentionItem[]
  recent: RecentItem[]
  parked: UpdateView[]
  scan: { lastAt: number | null; nextAt: string | null; running: boolean; watched: number }
}

export const StatusStrip: FC<{ scan: InboxData['scan'] }> = ({ scan }) => (
  <div class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs opacity-70">
    <span>
      {scan.running ? (
        // The id lives here and nowhere else: every poll that should stop when the scan
        // stops keys off it, so it must be exactly as durable as the scan itself.
        <ScanStatus running lastAt={null} />
      ) : scan.lastAt ? (
        <>
          last scan <Relative at={new Date(scan.lastAt).toISOString()} />
        </>
      ) : (
        'never scanned'
      )}
    </span>
    {scan.nextAt && !scan.running ? (
      <span>
        next <Relative at={scan.nextAt} />
      </span>
    ) : null}
    <span>{scan.watched} services watched</span>
    <button
      type="button"
      class="btn btn-ghost btn-xs ml-auto gap-1"
      hx-post="/scan"
      hx-target="#scan-status"
      hx-swap="innerHTML"
      hx-disabled-elt="this"
      hx-indicator="#busy"
    >
      <Icon name="refresh" class="size-3.5" />
      Scan now
    </button>
    <span id="scan-status" />
  </div>
)

export const InboxBody: FC<{ data: InboxData }> = ({ data }) => {
  const groups = new Map<AttentionKind, AttentionItem[]>()
  for (const item of data.needsYou) {
    const list = groups.get(item.kind) ?? []
    list.push(item)
    groups.set(item.kind, list)
  }

  return (
    <div id="inbox" class="flex flex-col gap-6">
      {groups.size === 0 ? (
        <EmptyState
          icon="check"
          title="Nothing needs you."
          hint={
            data.scan.nextAt
              ? `Everything tracked is either current or on its way. Next scan ${relativeish(data.scan.nextAt)}.`
              : 'Everything tracked is either current or on its way.'
          }
        />
      ) : (
        [...groups].map(([kind, items]) => (
          <section>
            <header class="mb-2 flex items-baseline gap-2">
              <h2 class="flex items-center gap-1.5 text-sm font-semibold">
                <Icon name={GROUPS[kind].icon} class="size-4 opacity-70" />
                {GROUPS[kind].title}
              </h2>
              <span class="badge badge-sm badge-neutral badge-soft">{items.length}</span>
            </header>
            <p class="mb-2 text-xs opacity-60">{GROUPS[kind].hint}</p>
            <div class="flex flex-col gap-2">
              {items.map((i) => (
                <UpdateCard update={i.update} />
              ))}
            </div>
          </section>
        ))
      )}

      {data.parked.length > 0 ? (
        <details class="collapse-arrow border-base-300 collapse border">
          <summary class="collapse-title text-sm">
            {data.parked.length} tracked, not opening a pull request
          </summary>
          <div class="collapse-content">
            <p class="mb-2 text-xs opacity-60">
              Another updater applies these. shipshape is set to coexist with it, so it takes only
              what that tool leaves alone.
            </p>
            <div class="flex flex-col gap-2">
              {data.parked.map((u) => (
                <UpdateCard update={u} />
              ))}
            </div>
          </div>
        </details>
      ) : null}

      <section>
        <header class="mb-2 flex items-baseline justify-between">
          <h2 class="text-sm font-semibold">Recently</h2>
          <a href="/activity" class="link link-hover text-xs">
            All activity →
          </a>
        </header>
        {data.recent.length === 0 ? (
          <p class="text-sm opacity-60">Nothing has happened in the last day.</p>
        ) : (
          <ul class="flex flex-col gap-1.5">
            {data.recent.map((r) => (
              <li class="flex items-baseline gap-2 text-sm">
                <span class={`status status-sm ${RECENT[r.kind].cls} shrink-0`} />
                <a href={`/updates/${r.updateId}`} class="link-hover min-w-0 flex-1 truncate">
                  <ServiceName stack={r.stack} service={r.service} />{' '}
                  <span class="opacity-70">{RECENT[r.kind].verb}</span>{' '}
                  <Change from={r.fromTag} to={r.toTag} />
                </a>
                <Relative at={r.at} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function relativeish(iso: string): string {
  const mins = Math.round((Date.parse(iso) - Date.now()) / 60_000)
  if (mins < 60) return `in ${Math.max(1, mins)}m`
  if (mins < 1440) return `in ${Math.round(mins / 60)}h`
  return `in ${Math.round(mins / 1440)}d`
}
