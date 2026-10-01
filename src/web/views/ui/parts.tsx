import { OUTCOMES, type Outcome } from '../../../updates/vocabulary.ts'
import type { FC, PropsWithChildren } from 'hono/jsx'
import { Icon, type IconName } from './icon.tsx'
import type { UpdateView } from '../../../updates/queries.ts'

/**
 * The vocabulary, rendered.
 *
 * Every colour and every word an update can wear is decided here, once. The old views
 * defined the same mappings twice under different names and put half the meaning in
 * `title` attributes, which do not exist on a touch screen -- so the single most
 * decision-relevant fact, how confident the review was, was invisible on the device the
 * decision is usually made on.
 *
 * Class names are written out in full because Tailwind only emits what it can see: a
 * template like `badge-${kind}` produces no CSS at all.
 */

// ------------------------------------------------------------------- badges

const MAGNITUDE: Record<string, string> = {
  major: 'badge-error',
  minor: 'badge-warning',
  patch: 'badge-ghost',
  digest: 'badge-ghost',
}

export const MagnitudeBadge: FC<{ value: string }> = ({ value }) => (
  <span class={`badge badge-xs badge-soft ${MAGNITUDE[value] ?? 'badge-ghost'}`}>{value}</span>
)

/** What an update is doing, in the words used everywhere else. */
export function stageOf(u: UpdateView): { label: string; cls: string; live?: boolean } {
  const d = u.deploy?.status
  // Outcomes are named by the shared vocabulary, so the badge says what the Inbox line does.
  const o = (k: Outcome) => ({ label: OUTCOMES[k].badge, cls: OUTCOMES[k].badgeCls })
  switch (u.state) {
    case 'detected':
      return u.rolling
        ? { label: 'Rolling tag moved', cls: 'badge-warning' }
        : { label: 'Detected', cls: 'badge-ghost' }
    case 'held':
      return { label: 'Held on request', cls: 'badge-ghost' }
    case 'pr_open':
      return o('opened')
    case 'merged':
      if (d === 'ready' || d === 'pending') return { label: 'Ready to deploy', cls: 'badge-info' }
      if (d === 'failed' || d === 'error') return o('failed')
      return o('merged')
    case 'deploying':
      return { label: 'Deploying', cls: 'badge-info', live: true }
    case 'deployed':
      return d === 'degraded' ? o('degraded') : { ...o('deployed'), live: true }
    case 'verified':
      return o('verified')
    case 'left-stopped':
      return o('left-stopped')
    case 'failed':
      return u.detail?.includes('rolled back') || d === 'rolled-back'
        ? o('rolled-back')
        : { label: 'Failed', cls: 'badge-error' }
    case 'skipped':
      return o('skipped')
    case 'superseded':
      return o('superseded')
  }
}

export const StageBadge: FC<{ update: UpdateView }> = ({ update }) => {
  const s = stageOf(update)
  return (
    <span class={`badge badge-xs badge-soft ${s.cls} gap-1 whitespace-nowrap`}>
      {s.live ? <span class="status status-info status-xs animate-pulse" /> : null}
      {s.label}
    </span>
  )
}

// ------------------------------------------------------------------ verdicts

/**
 * The review, in the operator's words rather than the model's enum.
 *
 * "approve" is what the model returned; "Safe to apply" is what it means. The confidence
 * is rendered as text beside it, always -- a high-confidence caution and a low-confidence
 * approval are different claims, and putting that distinction in a tooltip hid it from
 * every phone.
 */
export function verdictLabel(u: UpdateView): {
  label: string
  cls: string
  icon: IconName
  confidence: string | null
} | null {
  const v = u.verdict
  if (!v) return null
  if (v.error) return { label: 'Review failed', cls: 'text-error', icon: 'alert', confidence: null }
  switch (v.recommendation) {
    case 'approve':
      return { label: 'Safe to apply', cls: 'text-success', icon: 'check', confidence: v.confidence }
    case 'caution':
      return { label: 'Read first', cls: 'text-warning', icon: 'alert', confidence: v.confidence }
    case 'block':
      return { label: 'Breaking changes', cls: 'text-error', icon: 'ban', confidence: v.confidence }
    default:
      return null
  }
}

export const VerdictChip: FC<{ update: UpdateView; long?: boolean }> = ({ update, long }) => {
  const v = verdictLabel(update)
  if (!v) {
    // "Reading changelog…" used to show here whenever a pull request had no review --
    // including when nothing was going to read it: the budget spent, or no key set. It
    // promised activity that was not happening. Pending says what is true either way.
    return update.state === 'pr_open' ? (
      <span class="inline-flex items-center gap-1 text-xs opacity-60">
        <Icon name="eye" class="size-3.5" />
        Review pending
      </span>
    ) : null
  }
  // Only the screen has judged it. Said, because a screened approval rests on narrow
  // answers about the notes rather than a reading of them.
  const screened = update.verdict?.source === 'screen'
  return (
    <span class={`inline-flex items-center gap-1 text-xs ${v.cls}`}>
      <Icon name={v.icon} class="size-3.5" />
      <span class="font-medium">{v.label}</span>
      {v.confidence ? (
        <span class="opacity-70">
          · {v.confidence}
          {long ? ' confidence' : ''}
        </span>
      ) : null}
      {screened ? <span class="opacity-70">· {update.verdict?.provisional ? 'screened, reading queued' : 'screened'}</span> : null}
    </span>
  )
}

// -------------------------------------------------------------------- bits

export const Mono: FC<PropsWithChildren> = ({ children }) => (
  <span class="font-mono text-xs">{children}</span>
)

/** `1.2.3 → 1.3.0`, with digests shortened to something a person can compare. */
export const Change: FC<{ from: string; to: string }> = ({ from, to }) => (
  <span class="font-mono text-xs whitespace-nowrap">
    {shorten(from)} <span class="opacity-50">→</span>{' '}
    <span class="font-medium">{shorten(to)}</span>
  </span>
)

export function shorten(tag: string): string {
  const at = tag.indexOf('@sha256:')
  return at === -1 ? tag : `${tag.slice(0, at)}@${tag.slice(at + 8, at + 20)}`
}

export const ServiceName: FC<{ stack: string; service: string }> = ({ stack, service }) => (
  <span class="truncate">
    {stack === service ? null : <span class="opacity-55">{stack}/</span>}
    <span class="font-medium">{service}</span>
  </span>
)

export const Relative: FC<{ at: string | null | undefined }> = ({ at }) =>
  at ? (
    <time datetime={at} class="text-xs whitespace-nowrap opacity-60">
      {relative(at)}
    </time>
  ) : null

export function relative(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  const abs = Math.abs(ms)
  const mins = Math.round(abs / 60_000)
  const say = (n: number, unit: string) => `${n}${unit}`
  const span =
    mins < 1
      ? 'just now'
      : mins < 60
        ? say(mins, 'm')
        : abs < 86_400_000
          ? say(Math.round(mins / 60), 'h')
          : say(Math.round(mins / 1440), 'd')
  if (span === 'just now') return span
  return ms >= 0 ? `${span} ago` : `in ${span}`
}

/**
 * The scan chip, which is also the poll's on switch.
 *
 * The `scan-running` id exists only while a scan is in flight, and other regions key
 * their polling off it -- so when the scan ends the id goes with it, and every poll that
 * depended on it stops rather than running all night.
 */
export const ScanStatus: FC<{ running: boolean; lastAt: string | null }> = ({
  running,
  lastAt,
}) =>
  running ? (
    <span
      id="scan-running"
      class="text-info inline-flex items-center gap-1 text-xs"
      hx-get="/scan/status"
      hx-trigger="every 3s"
      hx-swap="outerHTML"
    >
      <span class="loading loading-ring loading-xs" /> scanning…
    </span>
  ) : (
    <span class="text-xs opacity-60">{lastAt ? `scanned ${relative(lastAt)}` : 'idle'}</span>
  )

/**
 * What unpausing would set moving, asked of the code that does the merging.
 *
 * On the Inbox while paused. It used to sit at the bottom of Status, where the one
 * question it answers was never being asked, and it called a refusal "held" -- the word
 * the interface reserves for the on-request rung.
 */
export const MergePreview: FC<{
  decisions: { number: number; merge: boolean; reason?: string }[]
  paused: boolean
}> = ({ decisions, paused }) => {
  const would = decisions.filter((d) => d.merge)
  return (
    <div class="flex flex-col gap-1 text-xs">
      <p class="text-sm">
        <span class="font-medium">
          {would.length} {would.length === 1 ? 'pull request' : 'pull requests'}
        </span>{' '}
        would merge on {would.length === 1 ? 'its' : 'their'} own{paused ? ' when unpaused' : ''}.
      </p>
      {decisions.length > 0 ? (
        <details>
          <summary class="tap inline-flex cursor-pointer items-center text-xs opacity-70">Why, for each</summary>
          <div class="mt-1 flex flex-col gap-1">
            {decisions.map((d) => (
              <div class="flex items-baseline gap-2">
                <span class="font-mono text-xs">#{d.number}</span>
                <span class={`badge badge-xs badge-soft ${d.merge ? 'badge-success' : 'badge-neutral'}`}>
                  {d.merge ? 'would merge' : 'waits'}
                </span>
                {d.reason ? <span class="text-xs opacity-60">{d.reason}</span> : null}
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  )
}

export const EmptyState: FC<{ icon: IconName; title: string; hint?: string }> = ({
  icon,
  title,
  hint,
}) => (
  <div class="flex flex-col items-center gap-1.5 px-4 py-8 text-center">
    <Icon name={icon} class="size-6 opacity-30" />
    <p class="text-sm font-medium">{title}</p>
    {hint ? <p class="max-w-sm text-xs opacity-60">{hint}</p> : null}
  </div>
)

// ---------------------------------------------------------------- toolbar

/**
 * A segmented control: radios in a tab box, every option visible all the time.
 *
 * Not daisyUI's `filter`, which hides the unselected options until you hover -- so on a
 * phone the strip collapsed to the single word "Open", and there was no way to know it
 * was a control at all. The tabs are 40px on a phone -- a segmented control's height,
 * filling the toolbar row -- and pointer-height at lg.
 */
export const Tabs: FC<{
  name: string
  value: string
  options: readonly { key: string; label: string }[]
  label: string
}> = ({ name, value, options, label }) => (
  <div
    role="tablist"
    aria-label={label}
    class="tabs tabs-box tabs-xs shrink-0 flex-nowrap p-0.5"
  >
    {options.map((o) => (
      <input
        type="radio"
        name={name}
        value={o.key}
        class="tab min-h-10 whitespace-nowrap lg:min-h-0"
        aria-label={o.label}
        checked={o.key === value}
      />
    ))}
  </div>
)

/** The search box, for a toolbar. `data-search` is what `/` focuses. */
export const Search: FC<{ value: string; placeholder: string }> = ({ value, placeholder }) => (
  <label class="input input-sm tap w-40 shrink-0 lg:w-52">
    <Icon name="search" class="size-3.5 opacity-50" />
    <input type="search" name="q" value={value} data-search placeholder={placeholder} class="grow" />
  </label>
)

/**
 * "56 shown", at the toolbar's right edge. A list fragment carries a copy marked
 * out-of-band, so a filter change updates the number without re-rendering the toolbar.
 */
export const ListCount: FC<{ n: number; oob?: boolean }> = ({ n, oob }) => (
  <span
    id="list-count"
    class="text-xs whitespace-nowrap opacity-60"
    {...(oob ? { 'hx-swap-oob': 'true' } : {})}
  >
    {n} shown
  </span>
)
