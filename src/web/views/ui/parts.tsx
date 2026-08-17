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
  patch: 'badge-neutral',
  digest: 'badge-neutral',
}

export const MagnitudeBadge: FC<{ value: string }> = ({ value }) => (
  <span class={`badge badge-sm badge-soft ${MAGNITUDE[value] ?? 'badge-neutral'}`}>{value}</span>
)

/** What an update is doing, in the words used everywhere else. */
export function stageOf(u: UpdateView): { label: string; cls: string; live?: boolean } {
  const d = u.deploy?.status
  switch (u.state) {
    case 'detected':
      return u.rolling
        ? { label: 'Rolling tag moved', cls: 'badge-warning' }
        : { label: 'Detected', cls: 'badge-neutral' }
    case 'held':
      return { label: 'Held on request', cls: 'badge-neutral' }
    case 'pr_open':
      return { label: 'Waiting on you', cls: 'badge-warning' }
    case 'merged':
      if (d === 'ready' || d === 'pending') return { label: 'Ready to deploy', cls: 'badge-info' }
      if (d === 'failed' || d === 'error') return { label: 'Deploy failed', cls: 'badge-error' }
      return { label: 'Merged', cls: 'badge-info' }
    case 'deploying':
      return { label: 'Deploying', cls: 'badge-info', live: true }
    case 'deployed':
      return d === 'degraded'
        ? { label: 'Degraded', cls: 'badge-warning' }
        : { label: 'Soaking', cls: 'badge-info', live: true }
    case 'verified':
      return { label: 'Verified', cls: 'badge-success' }
    case 'failed':
      return u.detail?.includes('rolled back') || d === 'rolled-back'
        ? { label: 'Rolled back', cls: 'badge-error' }
        : { label: 'Failed', cls: 'badge-error' }
    case 'skipped':
      return { label: 'Skipped', cls: 'badge-neutral' }
    case 'superseded':
      return { label: 'Superseded', cls: 'badge-neutral' }
  }
}

export const StageBadge: FC<{ update: UpdateView }> = ({ update }) => {
  const s = stageOf(update)
  return (
    <span class={`badge badge-sm badge-soft ${s.cls} gap-1`}>
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
    return update.state === 'pr_open' ? (
      <span class="inline-flex items-center gap-1 text-xs opacity-60">
        <span class="loading loading-ring loading-xs" />
        Reading changelog…
      </span>
    ) : null
  }
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

export const EmptyState: FC<{ icon: IconName; title: string; hint?: string }> = ({
  icon,
  title,
  hint,
}) => (
  <div class="flex flex-col items-center gap-2 py-14 text-center">
    <Icon name={icon} class="size-8 opacity-30" />
    <p class="font-medium">{title}</p>
    {hint ? <p class="max-w-sm text-sm opacity-60">{hint}</p> : null}
  </div>
)
