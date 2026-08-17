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
} from './parts.tsx'
import type { Milestone, UpdateView } from '../../../updates/queries.ts'
import type { Verb } from '../../../updates/actions.ts'

/**
 * One update: as a row in a list, and as the panel you open from it.
 *
 * The row carries enough to decide without opening anything -- service, change, size,
 * and what the review said including how sure it was. The panel carries the reasoning,
 * the history and the diff. Before this, deciding meant leaving for GitHub.
 */

const VERB: Record<Verb, { label: string; icon?: IconName; style: string; confirm?: boolean }> = {
  'merge-deploy': { label: 'Merge & deploy', icon: 'merge', style: 'btn-primary', confirm: true },
  'open-pr': { label: 'Open pull request', icon: 'pull-request', style: 'btn-primary' },
  deploy: { label: 'Deploy', icon: 'rocket', style: 'btn-primary' },
  redeploy: { label: 'Redeploy', icon: 'refresh', style: 'btn-primary' },
  retry: { label: 'Try again', icon: 'refresh', style: 'btn-primary' },
  rollback: { label: 'Roll back', icon: 'undo', style: 'btn-error btn-outline', confirm: true },
  'rerun-review': { label: 'Re-run review', icon: 'eye', style: 'btn-primary' },
  propose: { label: 'Draft config changes', icon: 'plus', style: 'btn-ghost' },
  skip: { label: 'Skip', icon: 'skip', style: 'btn-ghost' },
  ack: { label: 'Acknowledge', icon: 'check', style: 'btn-ghost' },
}

/** Where each verb posts. Merging is the one that addresses a pull request, not an update. */
function endpoint(u: UpdateView, verb: Verb): string {
  if (verb === 'merge-deploy') return `/prs/${u.pr?.number}/merge`
  if (verb === 'propose') return `/prs/${u.pr?.number}/propose`
  return `/updates/${u.id}/${verb === 'skip' ? 'dismiss' : verb}`
}

/** Verbs safe to offer straight from a list: nothing that needs the analysis on screen. */
const INLINE: ReadonlySet<Verb> = new Set<Verb>(['deploy', 'open-pr', 'redeploy', 'retry', 'ack'])

const ActionButton: FC<{ update: UpdateView; verb: Verb; primary?: boolean; small?: boolean }> = ({
  update,
  verb,
  primary,
  small,
}) => {
  const v = VERB[verb]
  const target = `#upd-${update.id}`
  const attrs = v.confirm
    ? { 'data-open': `#confirm-${verb}-${update.id}` }
    : {
        'hx-post': endpoint(update, verb),
        'hx-target': target,
        'hx-swap': 'outerHTML',
        'hx-disabled-elt': 'this',
        'hx-sync': `${target}:replace`,
        'hx-indicator': '#busy',
      }
  return (
    <button
      type="button"
      class={`btn ${small ? 'btn-sm' : ''} ${v.style} tap gap-1.5`}
      data-primary={primary ? 'true' : undefined}
      data-verb={verb}
      {...attrs}
    >
      {v.icon ? <Icon name={v.icon} class="size-4" /> : null}
      {v.label}
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
const Confirm: FC<{ update: UpdateView; verb: Verb; warnings?: string[] }> = ({
  update,
  verb,
  warnings,
}) => {
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
        <h3 class="text-lg font-semibold">
          {v.label} — {update.service}
        </h3>
        <p class="mt-1 font-mono text-xs opacity-70">
          {update.fromTag} → {update.toTag}
        </p>
        {warnings && warnings.length > 0 ? (
          <div class="alert alert-warning alert-soft mt-3 flex-col items-start gap-1 py-2 text-sm">
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
            hx-post={endpoint(update, verb)}
            hx-target={`#upd-${update.id}`}
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
 * The list row.
 *
 * A link first: on a phone it navigates to the update's own page, and on a desktop htmx
 * intercepts the same element and fills the panel instead. One piece of markup, both
 * behaviours, and it stays keyboard-reachable -- the old row was a bare `<tr>` with a
 * click handler, which no keyboard could open at all.
 */
export const UpdateCard: FC<{ update: UpdateView; target?: string }> = ({ update, target }) => {
  const inline = update.primary && INLINE.has(update.primary) ? update.primary : null
  const panelTarget = target ?? '#sheet-body'
  return (
    <article
      id={`upd-${update.id}`}
      class="card card-sm card-border bg-base-100 hover:border-primary/40 transition-colors"
      {...(update.transient
        ? {
            'hx-get': `/updates/${update.id}/card`,
            'hx-trigger': 'every 5s',
            'hx-swap': 'outerHTML',
          }
        : {})}
    >
      <div class="card-body gap-2 p-3">
        <div class="flex items-start gap-3">
          <a
            href={`/updates/${update.id}`}
            data-row
            hx-get={`/updates/${update.id}/panel`}
            hx-target={panelTarget}
            hx-swap="innerHTML"
            hx-trigger="click[matchMedia('(min-width:1024px)').matches]"
            hx-indicator="#busy"
            class="focus-visible:outline-primary min-w-0 flex-1 focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <ServiceName stack={update.stack} service={update.service} />
              <MagnitudeBadge value={update.magnitude} />
            </div>
            <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              <Change from={update.fromTag} to={update.toTag} />
              <Relative at={update.updatedAt} />
            </div>
            <div class="mt-1">
              <VerdictChip update={update} />
            </div>
          </a>
          {inline ? <ActionButton update={update} verb={inline} small /> : null}
        </div>
      </div>
    </article>
  )
}

/** The same update as a table row, for the wider Updates page. */
export const UpdateRow: FC<{ update: UpdateView; target?: string }> = ({ update, target }) => (
  <tr id={`upd-${update.id}`} class="hover:bg-base-200/60">
    <td class="max-w-0">
      <a
        href={`/updates/${update.id}`}
        data-row
        hx-get={`/updates/${update.id}/panel`}
        hx-target={target ?? '#sheet-body'}
        hx-swap="innerHTML"
        hx-trigger="click[matchMedia('(min-width:1024px)').matches]"
        hx-indicator="#busy"
        class="focus-visible:outline-primary block truncate focus-visible:outline-2"
      >
        <ServiceName stack={update.stack} service={update.service} />
      </a>
    </td>
    <td>
      <Change from={update.fromTag} to={update.toTag} />
    </td>
    <td>
      <MagnitudeBadge value={update.magnitude} />
    </td>
    <td>
      <VerdictChip update={update} />
    </td>
    <td>
      <StageBadge update={update} />
    </td>
    <td class="text-right">
      <Relative at={update.updatedAt} />
    </td>
  </tr>
)

// ------------------------------------------------------------------- panel

export const VerdictCard: FC<{ update: UpdateView }> = ({ update }) => {
  const v = update.verdict
  if (!v) {
    return (
      <div class="card card-border bg-base-100">
        <div class="card-body gap-1 p-4 text-sm">
          <span class="font-medium">No review</span>
          <span class="opacity-70">
            {update.state === 'held'
              ? 'Nothing is read until a pull request exists.'
              : 'The changelog review has not run for this version.'}
          </span>
        </div>
      </div>
    )
  }
  if (v.error) {
    return (
      <div class="card card-border border-error/40 bg-base-100">
        <div class="card-body gap-1 p-4 text-sm">
          <span class="text-error font-medium">Review failed — attempt {v.attempts}</span>
          <span class="opacity-80">{v.error}</span>
          {v.nextAttemptAt ? (
            <span class="opacity-60">
              Trying again <Relative at={v.nextAttemptAt} />.
            </span>
          ) : null}
        </div>
      </div>
    )
  }
  return (
    <div class="card card-border bg-base-100">
      <div class="card-body gap-3 p-4">
        <VerdictChip update={update} long />
        {v.summary ? <p class="text-sm leading-relaxed">{v.summary}</p> : null}
        {v.breakingChanges.length > 0 ? (
          <div>
            <p class="text-error mb-1 text-xs font-medium tracking-wide uppercase">
              Breaking changes
            </p>
            <ul class="list-disc space-y-1 pl-5 text-sm">
              {v.breakingChanges.map((b) => (
                <li>{b}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {v.migrationSteps.length > 0 ? (
          <div>
            <p class="mb-1 text-xs font-medium tracking-wide uppercase opacity-70">
              Migration steps
            </p>
            <ol class="list-decimal space-y-1 pl-5 text-sm">
              {v.migrationSteps.map((s) => (
                <li>{s}</li>
              ))}
            </ol>
          </div>
        ) : null}
        {v.sources.length > 0 ? (
          <div class="flex flex-wrap gap-2 text-xs">
            {v.sources.map((s) => (
              <a href={s} target="_blank" rel="noreferrer" class="link link-hover opacity-70">
                {hostOf(s)}
              </a>
            ))}
          </div>
        ) : null}
        <p class="text-xs opacity-50">
          Read by {v.model ?? 'the model'} <Relative at={v.createdAt} />. It can hold an update
          back, never cause one.
        </p>
      </div>
    </div>
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
 * The passage of one update, as a rail.
 *
 * daisyUI's timeline reserves both sides of the line even in its compact form, which on
 * a 26rem panel pushes every entry into the right-hand third. This is a list with a
 * border for the rail: predictable at 390px, and nothing to fight.
 *
 * Details are clamped. The review summary is a paragraph and it already has a card of
 * its own above; repeating it in full here would make the history unreadable.
 */
export const Timeline: FC<{ milestones: Milestone[] }> = ({ milestones }) => (
  <ol class="border-base-300 ml-1.5 space-y-4 border-l pl-5">
    {milestones.map((m) => (
      <li class={`relative ${m.future ? 'tl-future' : ''}`}>
        <span
          class={`ring-base-100 absolute top-1.5 -left-[1.6rem] size-2.5 rounded-full ring-4 ${
            m.level === 'error'
              ? 'bg-error'
              : m.level === 'warn'
                ? 'bg-warning'
                : m.future
                  ? 'bg-base-300'
                  : 'bg-success'
          }`}
        />
        <div class="text-sm font-medium">{m.label}</div>
        {m.detail ? <div class="line-clamp-2 text-xs opacity-70">{m.detail}</div> : null}
        <Relative at={m.at} />
      </li>
    ))}
  </ol>
)

/**
 * Everything you can do, with the one thing you probably want as a button.
 *
 * Sticky above the dock on a phone so a long changelog never puts the decision off
 * screen; the same controls sit at the top of the panel on a desktop.
 */
export const ActionBar: FC<{ update: UpdateView; warnings?: string[] }> = ({
  update,
  warnings,
}) => {
  const [primary, ...rest] = update.actions
  if (!primary) return null
  const secondary = rest.filter((v) => v !== 'skip')
  return (
    <>
      {warnings && warnings.length > 0 ? (
        <div class="alert alert-warning alert-soft flex-col items-start gap-1 py-2 text-sm">
          {warnings.map((w) => (
            <span>{w}</span>
          ))}
        </div>
      ) : null}
      <div class="actionbar bg-base-100/95 border-base-300 flex items-center gap-2 border-t py-3 backdrop-blur lg:static lg:border-0 lg:bg-transparent lg:py-0 lg:backdrop-blur-none">
        <ActionButton update={update} verb={primary} primary small />
        {update.actions.includes('skip') ? (
          <ActionButton update={update} verb="skip" small />
        ) : null}
        {secondary.length > 0 ? (
          <details class="dropdown dropdown-top dropdown-end ml-auto">
            <summary class="btn btn-ghost btn-sm btn-square tap" aria-label="More actions">
              <Icon name="dots" />
            </summary>
            <ul class="dropdown-content menu bg-base-100 rounded-box border-base-300 z-20 w-60 border p-2 shadow">
              {secondary.map((verb) => (
                <li>
                  <button
                    type="button"
                    data-verb={verb}
                    hx-post={endpoint(update, verb)}
                    hx-target={`#upd-${update.id}`}
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
                  <a href={update.pr.url} target="_blank" rel="noreferrer">
                    <Icon name="external" />
                    Open #{update.pr.number} on GitHub
                  </a>
                </li>
              ) : null}
            </ul>
          </details>
        ) : null}
      </div>
      {update.actions
        .filter((v) => VERB[v].confirm)
        .map((v) => (
          <Confirm update={update} verb={v} warnings={warnings} />
        ))}
    </>
  )
}

/** The panel and the phone page share this body; only the frame around it differs. */
export const UpdateDetail: FC<{
  update: UpdateView
  milestones: Milestone[]
  warnings?: string[]
  diff?: unknown
}> = ({ update, milestones, warnings, diff }) => {
  const stage = stageOf(update)
  return (
    <div id={`upd-${update.id}`} class="flex flex-col gap-4">
      <header class="flex flex-col gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-lg font-semibold">
            <ServiceName stack={update.stack} service={update.service} />
          </h2>
          <MagnitudeBadge value={update.magnitude} />
          <span class={`badge badge-sm badge-soft ${stage.cls}`}>{stage.label}</span>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <Change from={update.fromTag} to={update.toTag} />
          {update.pr ? (
            <a href={update.pr.url} target="_blank" rel="noreferrer" class="link link-hover text-xs">
              #{update.pr.number} ↗
            </a>
          ) : null}
          <a href={`/services/${update.stack}/${update.service}`} class="link link-hover text-xs">
            {update.tier} rung
          </a>
        </div>
      </header>

      <VerdictCard update={update} />
      <ActionBar update={update} warnings={warnings} />

      <section>
        <h3 class="mb-2 text-xs font-medium tracking-wide uppercase opacity-60">History</h3>
        <Timeline milestones={milestones} />
      </section>

      {diff ? (
        <details class="collapse-arrow border-base-300 bg-base-100 collapse border">
          <summary class="collapse-title text-sm font-medium">The change</summary>
          <div class="collapse-content">{diff}</div>
        </details>
      ) : null}
    </div>
  )
}
