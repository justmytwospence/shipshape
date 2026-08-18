import type { FC } from 'hono/jsx'
import { Icon, type IconName } from './icon.tsx'
import {
  Change,
  MagnitudeBadge,
  Relative,
  ServiceName,
  StageBadge,
  VerdictChip,
  stageOf,
  verdictLabel,
} from './parts.tsx'
import type { Milestone, UpdateView } from '../../../updates/queries.ts'
import type { Verb } from '../../../updates/actions.ts'

/**
 * One update: as a row in a list, and as the pane you open from it.
 *
 * The row is one line on a desktop and two on a phone -- the same element, a CSS grid
 * that changes shape at lg -- and it carries enough to decide without opening anything:
 * service, change, size, and what the review said including how sure it was. The pane
 * carries the reasoning, the history and the diff.
 */

const VERB: Record<
  Verb,
  { label: string; short?: string; icon?: IconName; style: string; confirm?: boolean }
> = {
  'merge-deploy': { label: 'Merge & deploy', icon: 'merge', style: 'btn-primary', confirm: true },
  'open-pr': { label: 'Open pull request', short: 'Open PR', icon: 'pull-request', style: 'btn-primary' },
  deploy: { label: 'Deploy', icon: 'rocket', style: 'btn-primary' },
  redeploy: { label: 'Redeploy', icon: 'refresh', style: 'btn-primary' },
  retry: { label: 'Try again', short: 'Retry', icon: 'refresh', style: 'btn-primary' },
  rollback: { label: 'Roll back', icon: 'undo', style: 'btn-error btn-outline', confirm: true },
  'rerun-review': { label: 'Re-run review', icon: 'eye', style: 'btn-primary' },
  propose: { label: 'Draft config changes', icon: 'plus', style: 'btn-ghost' },
  skip: { label: 'Skip', icon: 'skip', style: 'btn-ghost' },
  ack: { label: 'Acknowledge', short: 'Ack', icon: 'check', style: 'btn-ghost' },
}

/**
 * Where each verb posts. Merging is the one that addresses a pull request, not an update.
 *
 * `reply` says what should come back: `view=row` or `view=detail`, plus the list the
 * button was pressed in, so the server can render the same fragment the button sat in.
 */
function endpoint(u: UpdateView, verb: Verb, reply: string): string {
  if (verb === 'merge-deploy') return `/prs/${u.pr?.number}/merge?update=${u.id}&${reply}`
  if (verb === 'propose') return `/prs/${u.pr?.number}/propose?update=${u.id}&${reply}`
  return `/updates/${u.id}/${verb === 'skip' ? 'dismiss' : verb}?${reply}`
}

/** Verbs safe to offer straight from a list: nothing that needs the analysis on screen. */
const INLINE: ReadonlySet<Verb> = new Set<Verb>(['deploy', 'open-pr', 'redeploy', 'retry', 'ack'])

/**
 * A verb as a button. `target` is what the response replaces: the row when pressed in a
 * list, the pane when pressed in the pane. They used to share an id, so a verb pressed in
 * the pane replaced the row instead.
 */
const ActionButton: FC<{
  update: UpdateView
  verb: Verb
  target: string
  reply: string
  primary?: boolean
  size?: 'xs' | 'sm'
}> = ({ update, verb, target, reply, primary, size = 'sm' }) => {
  const v = VERB[verb]
  const attrs = v.confirm
    ? { 'data-open': `#confirm-${verb}-${update.id}` }
    : {
        'hx-post': endpoint(update, verb, reply),
        'hx-target': target,
        'hx-swap': 'outerHTML',
        'hx-disabled-elt': 'this',
        'hx-sync': `${target}:replace`,
        'hx-indicator': '#busy',
      }
  // In a row the button is small, tinted rather than solid (a column of twenty solid
  // buttons is a wall), and says the short thing.
  const cls =
    size === 'xs'
      ? `btn btn-xs btn-soft ${v.style === 'btn-ghost' ? '' : v.style} tap gap-1 whitespace-nowrap`
      : `btn btn-sm ${v.style} tap gap-1.5`
  return (
    <button
      type="button"
      class={cls}
      data-primary={primary ? 'true' : undefined}
      data-verb={verb}
      {...attrs}
    >
      {v.icon ? <Icon name={v.icon} class="size-3.5" /> : null}
      {size === 'xs' ? (v.short ?? v.label) : v.label}
    </button>
  )
}

/**
 * A second tap, with the consequences written out.
 *
 * Merging is not a preference, it is a change to a running host: what follows -- verify,
 * soak, and an automatic rollback if it fails -- is the part worth knowing before rather
 * than after.
 */
const Confirm: FC<{
  update: UpdateView
  verb: Verb
  target: string
  reply: string
  warnings?: string[]
}> = ({ update, verb, target, reply, warnings }) => {
  const v = VERB[verb]
  const steps =
    verb === 'merge-deploy'
      ? [
          `squash #${update.pr?.number} into main`,
          'sync the checkout on this host',
          `bring ${update.stack} up with docker compose`,
          'watch it for five minutes',
          'soak for thirty more before calling it verified',
          'put the old version back automatically if it fails',
        ]
      : [
          `revert the commit that landed ${update.toTag}`,
          `bring ${update.stack} back up on ${update.fromTag}`,
          'publish the revert so the next scan does not re-offer it',
        ]
  return (
    <dialog id={`confirm-${verb}-${update.id}`} class="modal modal-bottom sm:modal-middle">
      <div class="modal-box pb-safe">
        <h3 class="text-base font-semibold">
          {v.label} — {update.service}
        </h3>
        <p class="mt-1 font-mono text-xs opacity-70">
          {update.fromTag} → {update.toTag}
        </p>
        {warnings && warnings.length > 0 ? (
          <div class="alert alert-warning alert-soft mt-3 flex-col items-start gap-1 py-2 text-xs">
            {warnings.map((w) => (
              <span>{w}</span>
            ))}
          </div>
        ) : null}
        <p class="mt-4 text-sm font-medium">What happens</p>
        <ol class="mt-1 list-decimal space-y-0.5 pl-5 text-sm opacity-80">
          {steps.map((s) => (
            <li>{s}</li>
          ))}
        </ol>
        <form method="dialog" class="modal-action">
          <button class="btn btn-ghost btn-sm tap">Cancel</button>
          <button
            type="button"
            class={`btn btn-sm tap ${v.style}`}
            hx-post={endpoint(update, verb, reply)}
            hx-target={target}
            hx-swap="outerHTML"
            hx-disabled-elt="this"
            hx-indicator="#busy"
            onclick="this.closest('dialog').close()"
          >
            {v.label}
          </button>
        </form>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button>close</button>
      </form>
    </dialog>
  )
}

/**
 * The row.
 *
 * A link first: on a phone it navigates to the update's own page, and on a desktop htmx
 * intercepts the same element and fills the pane instead, pushing a URL that carries which
 * list it came from so a reload puts it back. Which of the two happens is decided in
 * app.js, not in a trigger filter -- htmx cancels a link's default click *before* it
 * evaluates `click[...]`, so a filtered trigger left the phone with rows that did
 * nothing. Selection is `aria-current`, set by the server on a direct load and by app.js
 * afterwards. Every class is a literal: Tailwind only emits what it can see.
 */
const ROW =
  'group border-l-2 border-transparent hover:bg-base-200/60 aria-[current=true]:border-primary ' +
  'aria-[current=true]:bg-primary/8 focus-visible:outline-primary block min-h-12 px-3 py-1.5 ' +
  'focus-visible:outline-2 lg:min-h-9 lg:py-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 ' +
  'gap-y-0.5 items-center '
/**
 * service · change · size · review · age-or-action. The last cell is fixed so the columns
 * line up from row to row (each row is its own grid); it holds the age, or the row's
 * one inline button in its place, since a row that can be acted on is what the button
 * says more than when it last moved.
 */
const COLS = 'lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_2.75rem_minmax(0,1.6fr)_5rem]'
/** service · change · size · stage · review · age-or-action */
const COLS_STAGE =
  'lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_2.75rem_6rem_minmax(0,1.5fr)_5rem]'

export const UpdateRow: FC<{
  update: UpdateView
  /** The query that names the list this row lives in, so the URL can carry it. */
  ctx: string
  selected?: boolean
  /** Updates and history show the stage; the Inbox's groups already say it. */
  showStage?: boolean
}> = ({ update, ctx, selected, showStage }) => {
  const inline = update.primary && INLINE.has(update.primary) ? update.primary : null
  const href = `/updates/${update.id}`
  return (
    <div
      id={`upd-${update.id}`}
      {...(update.transient
        ? {
            'hx-get': `/updates/${update.id}/card?${ctx}`,
            'hx-trigger': 'every 5s',
            'hx-swap': 'outerHTML',
          }
        : {})}
      class="relative"
    >
      <a
        href={`${href}?${ctx}`}
        data-row
        hx-get={`/updates/${update.id}/panel?${ctx}`}
        hx-target="#pane"
        hx-swap="innerHTML scroll:top"
        hx-push-url={`${href}?${ctx}`}
        hx-indicator="#busy"
        aria-current={selected ? 'true' : undefined}
        class={ROW + (showStage ? COLS_STAGE : COLS)}
      >
        {/* line 1 / col 1 */}
        <span class="min-w-0 truncate text-sm">
          <ServiceName stack={update.stack} service={update.service} />
        </span>
        {/* phone: age at the right of line 1; desktop: this cell becomes the change */}
        <span class="lg:hidden">
          <Relative at={update.updatedAt} />
        </span>
        <span class="hidden min-w-0 truncate lg:block">
          <Change from={update.fromTag} to={update.toTag} />
        </span>
        <span class="hidden lg:block">
          <MagnitudeBadge value={update.magnitude} />
        </span>
        {showStage ? (
          <span class="hidden min-w-0 lg:block">
            <StageBadge update={update} />
          </span>
        ) : null}
        <span class="hidden min-w-0 items-center truncate lg:flex">
          <VerdictChip update={update} />
        </span>
        <span class="hidden text-right lg:block">
          {inline ? null : <Relative at={update.updatedAt} />}
        </span>
        {/* line 2 on the phone: change · size · verdict; hidden at lg where each has a cell */}
        <span class="col-span-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs lg:hidden">
          <Change from={update.fromTag} to={update.toTag} />
          <MagnitudeBadge value={update.magnitude} />
          {showStage ? <StageBadge update={update} /> : null}
          <VerdictChip update={update} />
        </span>
      </a>
      {inline ? (
        <div class="absolute top-1/2 right-3 -translate-y-1/2">
          <ActionButton
            update={update}
            verb={inline}
            target={`#upd-${update.id}`}
            reply={`view=row&${ctx}`}
            size="xs"
          />
        </div>
      ) : null}
    </div>
  )
}

/** A sticky group header inside a list: what these rows have in common, and how many. */
export const GroupHeader: FC<{
  title: string
  count?: number
  hint?: string
  icon?: IconName
}> = ({ title, count, hint, icon }) => (
  <div class="bg-base-100 border-base-300 sticky top-0 z-10 flex h-7 items-center gap-2 border-b px-3 text-xs font-medium tracking-wide uppercase opacity-70">
    {icon ? <Icon name={icon} class="size-3.5 shrink-0" /> : null}
    <span class="shrink-0 whitespace-nowrap">{title}</span>
    {count !== undefined ? <span class="badge badge-xs badge-ghost">{count}</span> : null}
    {hint ? (
      <span class="hidden min-w-0 truncate font-normal normal-case tracking-normal opacity-70 lg:inline">
        · {hint}
      </span>
    ) : null}
  </div>
)

// -------------------------------------------------------------------- pane

/**
 * The review, as a bordered block rather than a card. The accent on the left is the
 * verdict's colour, so the block reads at a glance from across the pane.
 */
export const VerdictBlock: FC<{ update: UpdateView }> = ({ update }) => {
  const v = update.verdict
  const label = verdictLabel(update)
  const accent =
    label?.cls === 'text-success'
      ? 'border-success'
      : label?.cls === 'text-warning'
        ? 'border-warning'
        : label?.cls === 'text-error'
          ? 'border-error'
          : 'border-base-300'
  if (!v) {
    return (
      <section class="border-base-300 border-t px-4 py-3 text-sm">
        <span class="font-medium">No review.</span>{' '}
        <span class="opacity-70">
          {update.state === 'held'
            ? 'Nothing is read until a pull request exists.'
            : 'The changelog review has not run for this version.'}
        </span>
      </section>
    )
  }
  if (v.error) {
    return (
      <section class="border-base-300 border-t px-4 py-3">
        <div class="border-error border-l-2 pl-3">
          <p class="text-error text-sm font-medium">Review failed — attempt {v.attempts}</p>
          <p class="text-xs opacity-80">{v.error}</p>
          {v.nextAttemptAt ? (
            <p class="text-xs opacity-60">
              Trying again <Relative at={v.nextAttemptAt} />.
            </p>
          ) : null}
        </div>
      </section>
    )
  }
  return (
    <section class="border-base-300 border-t px-4 py-3">
      <div class={`border-l-2 pl-3 ${accent} flex flex-col gap-2`}>
        <VerdictChip update={update} long />
        {v.summary ? <p class="text-sm leading-relaxed">{v.summary}</p> : null}
        {v.breakingChanges.length > 0 ? (
          <div>
            <p class="text-error text-xs font-medium tracking-wide uppercase">Breaking changes</p>
            <ul class="mt-0.5 list-disc space-y-0.5 pl-4 text-xs">
              {v.breakingChanges.map((b) => (
                <li>{b}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {v.migrationSteps.length > 0 ? (
          <div>
            <p class="text-xs font-medium tracking-wide uppercase opacity-70">Migration steps</p>
            <ol class="mt-0.5 list-decimal space-y-0.5 pl-4 text-xs">
              {v.migrationSteps.map((s) => (
                <li>{s}</li>
              ))}
            </ol>
          </div>
        ) : null}
        <p class="text-xs opacity-50">
          {v.sources.length > 0 ? (
            <>
              {v.sources.map((s) => (
                <a href={s} target="_blank" rel="noreferrer" class="link link-hover mr-2">
                  {hostOf(s)}
                </a>
              ))}
              ·{' '}
            </>
          ) : null}
          read by {v.model ?? 'the model'} <Relative at={v.createdAt} />. It can hold an update
          back, never cause one.
        </p>
      </div>
    </section>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url.slice(0, 40)
  }
}

/**
 * The passage of one update, as a rail. Details are clamped: the review summary has a
 * block of its own above, and repeating it in full here would swamp the history.
 */
export const Timeline: FC<{ milestones: Milestone[] }> = ({ milestones }) => (
  <ol class="border-base-300 ml-1 space-y-2.5 border-l pl-4">
    {milestones.map((m) => (
      <li class={`relative ${m.future ? 'tl-future' : ''}`}>
        <span
          class={`ring-base-100 absolute top-1 -left-[1.3rem] size-2 rounded-full ring-4 ${
            m.level === 'error'
              ? 'bg-error'
              : m.level === 'warn'
                ? 'bg-warning'
                : m.future
                  ? 'bg-base-300'
                  : 'bg-success'
          }`}
        />
        <div class="flex items-baseline gap-2">
          <span class="text-sm">{m.label}</span>
          <Relative at={m.at} />
        </div>
        {m.detail ? <div class="line-clamp-2 text-xs opacity-60">{m.detail}</div> : null}
      </li>
    ))}
  </ol>
)

/**
 * Everything you can do, with the one thing you probably want as a button.
 *
 * Sticky: above the dock on a phone, at the top of the pane on a desktop -- so a long
 * changelog never puts the decision off screen in either direction.
 */
export const ActionBar: FC<{
  update: UpdateView
  target: string
  reply: string
  warnings?: string[]
}> = ({ update, target, reply, warnings }) => {
  const [primary, ...rest] = update.actions
  if (!primary) return null
  const secondary = rest.filter((v) => v !== 'skip')
  return (
    <>
      <div class="actionbar bg-base-100/95 border-base-300 order-last flex items-center gap-2 border-t px-4 py-2 backdrop-blur lg:order-none lg:border-t-0 lg:border-b">
        <ActionButton update={update} verb={primary} target={target} reply={reply} primary />
        {update.actions.includes('skip') ? (
          <ActionButton update={update} verb="skip" target={target} reply={reply} />
        ) : null}
        {secondary.length > 0 || update.pr ? (
          <details class="dropdown dropdown-end ml-auto">
            <summary class="btn btn-ghost btn-sm btn-square tap" aria-label="More actions">
              <Icon name="dots" />
            </summary>
            <ul class="dropdown-content menu menu-md lg:menu-sm bg-base-100 rounded-box border-base-300 z-20 w-60 border p-1.5 shadow">
              {secondary.map((verb) => (
                <li>
                  <button
                    type="button"
                    class="tap"
                    data-verb={verb}
                    hx-post={endpoint(update, verb, reply)}
                    hx-target={target}
                    hx-swap="outerHTML"
                    hx-disabled-elt="this"
                    hx-indicator="#busy"
                  >
                    {VERB[verb].icon ? <Icon name={VERB[verb].icon!} /> : null}
                    {VERB[verb].label}
                  </button>
                </li>
              ))}
              {update.pr ? (
                <li>
                  <a href={update.pr.url} target="_blank" rel="noreferrer" class="tap">
                    <Icon name="external" />
                    Open #{update.pr.number} on GitHub
                  </a>
                </li>
              ) : null}
            </ul>
          </details>
        ) : null}
      </div>
      {warnings && warnings.length > 0 ? (
        <div class="alert alert-warning alert-soft rounded-none border-x-0 border-t-0 py-1.5 text-xs">
          <span>{warnings.join(' · ')}</span>
        </div>
      ) : null}
      {update.actions
        .filter((v) => VERB[v].confirm)
        .map((v) => (
          <Confirm update={update} verb={v} target={target} reply={reply} warnings={warnings} />
        ))}
    </>
  )
}

/**
 * The pane, and the phone page's body. Its root id is distinct from the row's, so a verb
 * pressed here replaces the pane and not a row somewhere off to the left.
 */
export const UpdateDetail: FC<{
  update: UpdateView
  milestones: Milestone[]
  warnings?: string[]
  diff?: unknown
  /** Where the list this came from lives, for the close control on a desktop. */
  listHref?: string
  /** A "back to service" link when the pane was reached from a service's history. */
  fromService?: { stack: string; service: string }
  /** The list this was opened from, so a verb pressed here comes back the same way. */
  ctx?: string
}> = ({ update, milestones, warnings, diff, listHref, fromService, ctx }) => {
  const stage = stageOf(update)
  const target = `#upd-${update.id}-detail`
  const reply = `view=detail${ctx ? `&${ctx}` : ''}`
  return (
    <div id={`upd-${update.id}-detail`} class="flex flex-col">
      <header class="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pt-3 pb-2">
        {fromService ? (
          <a
            href={`/services/${fromService.stack}/${fromService.service}`}
            class="link link-hover text-xs opacity-70"
          >
            ← {fromService.service}
          </a>
        ) : null}
        <h2 class="text-sm font-semibold">
          <ServiceName stack={update.stack} service={update.service} />
        </h2>
        <MagnitudeBadge value={update.magnitude} />
        <span class={`badge badge-xs badge-soft ${stage.cls}`}>{stage.label}</span>
        <Change from={update.fromTag} to={update.toTag} />
        <span class="text-xs">
          {update.pr ? (
            <a href={update.pr.url} target="_blank" rel="noreferrer" class="link link-hover mr-2">
              #{update.pr.number} ↗
            </a>
          ) : null}
          <a
            href={`/services/${update.stack}/${update.service}`}
            class="link link-hover opacity-70"
          >
            {update.tier} rung
          </a>
        </span>
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

      <ActionBar update={update} target={target} reply={reply} warnings={warnings} />
      <VerdictBlock update={update} />

      <section class="border-base-300 border-t px-4 py-3">
        <h3 class="mb-2 text-xs font-medium tracking-wide uppercase opacity-60">History</h3>
        <Timeline milestones={milestones} />
      </section>

      {diff ? (
        <details class="collapse-arrow border-base-300 collapse rounded-none border-t">
          <summary class="collapse-title min-h-11 px-4 py-2.5 text-sm font-medium lg:min-h-0">The change</summary>
          <div class="collapse-content px-2">{diff}</div>
        </details>
      ) : null}
    </div>
  )
}
