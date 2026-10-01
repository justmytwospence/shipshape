import type { FC } from 'hono/jsx'
import { Icon } from './icon.tsx'
import type { SettingDef } from '../../../settings.ts'

/**
 * Settings: one page, in the order an update travels through shipshape.
 *
 * It used to be two -- General and Advanced -- and before that twelve panes and
 * thirty-one keys presented as equals. Two tabs made "where is X" a coin toss and let a
 * save on one tab silently skip the other. Now every section shows the decisions that
 * change what shipshape may do, and folds its tuning, and its longer explanation, into a
 * "More" beneath them. Nothing lives on another page.
 */

export interface SettingValue {
  def: SettingDef
  value: string
  changed: boolean
}

export interface SettingGroup {
  title: string
  /** One sentence: what this stage is for. */
  tagline?: string
  /** The longer explanation, folded under More. */
  prose?: string[]
  /** Decisions: what shipshape may do. Always shown. */
  items: SettingValue[]
  /** Tuning: correct out of the box. Folded under More. */
  more?: SettingValue[]
}

/**
 * The section list beside the form on a desktop: a map of the form, not just links.
 * Anchors scroll the pane natively (smoothly -- the pane is `scroll-smooth`); the sections
 * carry `scroll-mt` so a heading lands under the top edge rather than behind it; and
 * app.js marks the section you are reading (`aria-current`) as the pane scrolls, keyed
 * off `data-spy`.
 */
const NAV_LINK =
  'border-l-2 border-transparent hover:bg-base-200 aria-[current=true]:border-primary ' +
  'aria-[current=true]:bg-primary/8 aria-[current=true]:font-medium flex h-7 items-center px-3 text-xs'

export const SettingsNav: FC<{ sections: string[] }> = ({ sections }) => (
  <nav data-spy aria-label="Sections" class="flex flex-col py-2">
    {sections.map((title) => (
      <a href={`#${slug(title)}`} class={NAV_LINK}>
        {title}
      </a>
    ))}
  </nav>
)

const Field: FC<{ item: SettingValue; models?: string[] }> = ({ item, models }) => {
  const { def, value, changed } = item
  const id = def.path.replace(/\./g, '-')
  const help = [
    def.locked ?? def.help,
    def.about,
    !def.locked && changed ? `Default: ${def.defaultLabel ?? def.defaultValue}.` : '',
  ]
    .filter(Boolean)
    .map((part) => String(part).trim())
    // `help` is a fragment ("x.y.Z"), `about` a sentence. Run together they read as one
    // broken sentence, so they are joined rather than concatenated.
    .map((part) => (/[.!?]$/.test(part) ? part : `${part}.`))
    .join(' ')
  return (
    <fieldset class="fieldset border-base-300 grid grid-cols-1 gap-x-4 gap-y-1 border-t py-2 first:border-t-0 lg:grid-cols-[11rem_minmax(0,1fr)] lg:items-start">
      <label for={id} class="flex min-h-8 items-center gap-2 text-sm font-medium">
        {def.label}
        {changed ? <span class="badge badge-xs badge-primary badge-soft">changed</span> : null}
      </label>
      <div class="min-w-0">
        <div class="flex min-h-8 items-center">
          {def.locked ? (
            <span class="font-mono text-xs opacity-70">{value}</span>
          ) : def.kind === 'bool' ? (
            <>
              {/* An unchecked checkbox sends nothing at all, which would read as "no
                  change" rather than "off". The hidden field is the off value; the
                  browser sends the later one when it is checked. */}
              <input type="hidden" name={def.path} value="false" />
              <input
                id={id}
                type="checkbox"
                name={def.path}
                value="true"
                class="toggle toggle-sm"
                checked={value === 'true'}
              />
            </>
          ) : def.kind === 'enum' && def.options ? (
            // Each option says what it does, not only what it is called: `act` or
            // `compose-dir` means nothing until you have read the code behind it.
            <select id={id} name={def.path} class="select select-sm tap w-full max-w-md">
              {def.options.map((o) => (
                <option value={o} selected={o === value}>
                  {o}
                  {def.optionHelp?.[o] ? ` — ${def.optionHelp[o]}` : ''}
                  {o === def.defaultValue ? ' (default)' : ''}
                </option>
              ))}
            </select>
          ) : def.kind === 'model' ? (
            <>
              <input
                id={id}
                name={def.path}
                value={value}
                list={`${id}-models`}
                class="input input-sm tap w-full max-w-xs font-mono"
              />
              <datalist id={`${id}-models`}>
                {(models ?? []).map((m) => (
                  <option value={m} />
                ))}
              </datalist>
            </>
          ) : (
            <input
              id={id}
              name={def.path}
              value={value}
              inputmode={def.kind === 'int' || def.kind === 'number' ? 'decimal' : undefined}
              class={`input input-sm tap w-full max-w-xs ${def.kind === 'cron' || def.kind === 'windows' ? 'font-mono' : ''}`}
            />
          )}
        </div>
        {def.kind === 'cron' && describeCron(value) ? (
          <p class="mt-0.5 text-xs">{describeCron(value)}</p>
        ) : null}
        {help ? <p class="mt-0.5 max-w-prose text-xs opacity-60">{help}</p> : null}
      </div>
    </fieldset>
  )
}

/**
 * A seconds-first cron expression in words, for the shapes this file actually uses.
 *
 * Anything else returns null and the expression speaks for itself: a wrong description
 * of a schedule is worse than none.
 */
export function describeCron(expr: string): string | null {
  const f = expr.trim().split(/\s+/)
  if (f.length !== 6) return null
  const [sec, min, hour, dom, mon, dow] = f as [string, string, string, string, string, string]
  if (sec !== '0' || dom !== '*' || mon !== '*') return null
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour)) return null
  const at = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
  if (dow === '*') return `Every day at ${at}`
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  if (/^[0-6]$/.test(dow)) return `Every ${DAYS[Number(dow)]} at ${at}`
  return null
}

const Section: FC<{
  group: SettingGroup
  models?: string[]
  /** Anything a section carries besides its fields: the digest preview, under Notifications. */
  extra?: unknown
}> = ({ group, models, extra }) => {
  const more = group.more ?? []
  const prose = group.prose ?? []
  return (
    <section id={slug(group.title)} class="border-base-300 scroll-mt-2 border-t px-4 py-3 first:border-t-0">
      <h2 class="text-sm font-semibold">{group.title}</h2>
      {group.tagline ? (
        <p class="mt-0.5 max-w-prose text-xs leading-relaxed opacity-70">{withCode(group.tagline)}</p>
      ) : null}
      <div class="mt-2">
        {group.items.map((item) => (
          <Field item={item} models={models} />
        ))}
      </div>
      {extra ? <div class="mt-2">{extra}</div> : null}
      {more.length > 0 || prose.length > 0 ? (
        // A native disclosure: the fields inside are still in the form, so a save writes
        // them back as they are whether or not anybody opened it.
        <details class="group mt-1">
          <summary class="tap inline-flex cursor-pointer items-center gap-1 text-xs opacity-70 hover:opacity-100">
            <Icon name="chevron-right" class="size-3.5 transition-transform group-open:rotate-90" />
            More
            {more.some((m) => m.changed) ? (
              <span class="badge badge-xs badge-primary badge-soft">changed</span>
            ) : null}
          </summary>
          <div class="mt-1">
            {prose.map((para) => (
              <p class="mt-1 max-w-prose text-xs leading-relaxed opacity-60">{withCode(para)}</p>
            ))}
            {more.map((item) => (
              <Field item={item} models={models} />
            ))}
          </div>
        </details>
      ) : null}
    </section>
  )
}

/** Backticks in the prose are label and key names, and should look like ones. */
function withCode(text: string): unknown[] {
  return text.split(/`([^`]+)`/g).map((part, i) =>
    i % 2 === 1 ? <code class="bg-base-200 rounded px-1 font-mono">{part}</code> : part,
  )
}

export function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

export const SettingsForm: FC<{
  groups: SettingGroup[]
  models?: string[]
  banner?: { level: 'info' | 'error'; text: string } | null
  readyCount?: number
  /** Rendered inside the section of the same title. */
  extras?: Record<string, unknown>
}> = ({ groups, models, banner, readyCount, extras }) => (
  <form
    id="settings-form"
    data-dirty
    hx-post="/settings"
    hx-target="#settings-form"
    hx-swap="outerHTML"
    hx-indicator="#busy"
    class="flex flex-col"
  >
    {banner ? (
      <div
        class={`alert alert-soft rounded-none border-x-0 border-t-0 py-1.5 text-xs ${banner.level === 'error' ? 'alert-error' : 'alert-success'}`}
      >
        {banner.text}
      </div>
    ) : null}
    {readyCount ? (
      <p class="border-base-300 border-b px-4 py-2 text-xs opacity-60">
        {readyCount} merged {readyCount === 1 ? 'update is' : 'updates are'} waiting for a
        deploy. Unpausing does not start them — press Deploy on each.
      </p>
    ) : null}
    {groups.map((g) => (
      <Section group={g} models={models} extra={extras?.[g.title]} />
    ))}
    <div class="savebar bg-base-100/95 border-base-300 flex items-center gap-3 border-t px-4 py-2 backdrop-blur">
      <button type="submit" class="btn btn-primary btn-sm tap">
        Save changes
      </button>
      <span class="text-xs opacity-60">Writes policy.yaml and commits it.</span>
    </div>
  </form>
)

/**
 * What the next digest would say, and the two ways to prove the path works.
 *
 * Both buttons existed and were reachable from nowhere: the preview lived at a URL no page
 * linked to. They sit under Notifications now, beside the settings they test. Their
 * buttons are `type="button"`, so pressing one never submits the settings form around it.
 */
export const DigestPreview: FC<{ title: string | null; body: string | null; count: number }> = ({
  title,
  body,
  count,
}) => (
  <div id="digest-preview" class="bg-base-200/50 flex flex-col gap-2 rounded p-3">
    <p class="text-xs font-medium tracking-wide uppercase opacity-60">Next digest</p>
    {count === 0 ? (
      <p class="text-xs opacity-60">Nothing is waiting to be sent. An empty digest is never sent.</p>
    ) : (
      <>
        <p class="text-sm font-medium">{title}</p>
        <pre class="bg-base-100 overflow-x-auto rounded p-2 font-mono text-xs whitespace-pre-wrap">
          {body}
        </pre>
      </>
    )}
    <div class="flex flex-wrap items-center gap-2">
      <button
        type="button"
        class="btn btn-ghost btn-sm tap gap-1"
        hx-post="/settings/digest/send"
        hx-target="#digest-result"
        hx-swap="innerHTML"
        hx-disabled-elt="this"
      >
        <Icon name="check" />
        Send the digest now
      </button>
      <button
        type="button"
        class="btn btn-ghost btn-sm tap gap-1"
        hx-post="/settings/email/test"
        hx-target="#digest-result"
        hx-swap="innerHTML"
        hx-disabled-elt="this"
      >
        Send a test email
      </button>
      <span id="digest-result" class="text-xs" aria-live="polite"></span>
    </div>
  </div>
)
