import type { FC } from 'hono/jsx'
import { Icon } from './icon.tsx'
import { Relative } from './parts.tsx'
import type { SettingDef } from '../../../settings.ts'

/**
 * Settings, split by whether getting it wrong changes what shipshape may do.
 *
 * The page it replaces had twelve panes and thirty-one keys presented as equals, which
 * is what made "how much happens without you" hard to find: it was one switch among many
 * rather than the question the tool is about. Fourteen decisions stay here. The rest are
 * tuning, correct out of the box, folded behind Advanced.
 */

export interface SettingValue {
  def: SettingDef
  value: string
  changed: boolean
}

export const SETTINGS_TABS = [
  { key: 'general', href: '/settings', label: 'General' },
  { key: 'advanced', href: '/settings/advanced', label: 'Advanced' },
  { key: 'status', href: '/settings/status', label: 'Status' },
] as const

export const SettingsTabs: FC<{ active: string }> = ({ active }) => (
  <div role="tablist" class="tabs tabs-box tabs-xs w-fit shrink-0 flex-nowrap p-0.5">
    {SETTINGS_TABS.map((t) => (
      <a
        role="tab"
        href={t.href}
        class={`tab min-h-10 whitespace-nowrap lg:min-h-0 ${t.key === active ? 'tab-active' : ''}`}
        aria-selected={t.key === active ? 'true' : 'false'}
      >
        {t.label}
      </a>
    ))}
  </div>
)

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

export const SettingsNav: FC<{ sections: string[]; extra?: { href: string; label: string }[] }> = ({
  sections,
  extra,
}) => (
  <nav data-spy aria-label="Sections" class="flex flex-col py-2">
    {sections.map((title) => (
      <a href={`#${slug(title)}`} class={NAV_LINK}>
        {title}
      </a>
    ))}
    {extra && extra.length > 0 ? (
      <>
        <span class="px-3 pt-3 pb-1 text-xs font-medium tracking-wide uppercase opacity-50">
          Prompts
        </span>
        {extra.map((e) => (
          <a href={e.href} class={NAV_LINK}>
            {e.label}
          </a>
        ))}
      </>
    ) : null}
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
            <select id={id} name={def.path} class="select select-sm tap w-full max-w-xs">
              {def.options.map((o) => (
                <option value={o} selected={o === value}>
                  {o}
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
        {help ? <p class="mt-0.5 max-w-prose text-xs opacity-60">{help}</p> : null}
      </div>
    </fieldset>
  )
}

const Section: FC<{
  title: string
  prose?: string[]
  items: SettingValue[]
  models?: string[]
}> = ({ title, prose, items, models }) => (
  <section
    id={slug(title)}
    class="border-base-300 scroll-mt-2 border-t px-4 py-3 first:border-t-0 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)] lg:grid-rows-[auto_1fr] lg:gap-x-8"
  >
    <h2 class="text-sm font-semibold lg:col-start-1 lg:row-start-1">{title}</h2>
    {/* The explanation lives here rather than behind a link. It was a separate page for
        a while, which meant answering "what does this actually do" cost a page load and
        a scroll back to the control you were looking at. Beside the fields at lg, above
        them on a phone. */}
    <div class="lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:pt-0.5">
      {prose?.map((para) => (
        <p class="mt-1 max-w-prose text-xs leading-relaxed opacity-60 lg:mt-0 lg:mb-2">
          {withCode(para)}
        </p>
      ))}
    </div>
    <div class="mt-2 lg:col-start-1 lg:row-start-2 lg:mt-1">
      {items.map((item) => (
        <Field item={item} models={models} />
      ))}
    </div>
  </section>
)

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
  groups: { title: string; prose?: string[]; items: SettingValue[] }[]
  models?: string[]
  banner?: { level: 'info' | 'error'; text: string } | null
  advanced?: boolean
  readyCount?: number
}> = ({ groups, models, banner, advanced, readyCount }) => (
  <form
    id="settings-form"
    data-dirty
    hx-post={advanced ? '/settings/advanced' : '/settings'}
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
      <Section title={g.title} prose={g.prose} items={g.items} models={models} />
    ))}
    <div class="savebar bg-base-100/95 border-base-300 flex items-center gap-3 border-t px-4 py-2 backdrop-blur">
      <button type="submit" class="btn btn-primary btn-sm tap">
        Save changes
      </button>
      <span class="text-xs opacity-60">Writes policy.yaml and commits it.</span>
    </div>
  </form>
)

// -------------------------------------------------------------------- status

export interface StatusData {
  version: string
  repoDir: string
  repo: string
  mergeMethod: string
  pushMain: boolean
  blackout: string[]
  scan: { cron: string; lastAt: string | null; nextAt: string | null; durationS: number | null }
  digest: { cron: string; nextAt: string | null }
  credentials: { name: string; state: 'set' | 'missing' | 'not in use' }[]
  spend: { model: string; purpose: string; calls: number; cost: number }[]
  budgetUsd: number
  spentUsd: number
  deploys: { at: string | null; stack: string; services: string; status: string; trigger: string }[]
  budgets: { key: string; value: number; window: string | null }[]
  /** True in the sandbox dev server, where the credentials are deliberately absent. */
  sandbox?: boolean
}

const CRED_CLS: Record<string, string> = {
  set: 'badge-success',
  missing: 'badge-error',
  'not in use': 'badge-ghost',
}

const DEPLOY_CLS: Record<string, string> = {
  verified: 'badge-success',
  deployed: 'badge-info',
  degraded: 'badge-warning',
  failed: 'badge-error',
  'rolled-back': 'badge-error',
  error: 'badge-error',
  ready: 'badge-info',
  pending: 'badge-ghost',
  running: 'badge-info',
  superseded: 'badge-ghost',
}

const KV: FC<{ rows: [string, unknown][] }> = ({ rows }) => (
  <div class="divide-base-300 border-base-300 divide-y border-y text-xs">
    {rows.map(([k, v]) => (
      <div class="flex min-h-7 items-center gap-3">
        <span class="w-28 shrink-0 opacity-70">{k}</span>
        <span class="min-w-0 flex-1 font-mono break-all">{v}</span>
      </div>
    ))}
  </div>
)

const H: FC<{ children?: unknown }> = ({ children }) => (
  <h2 class="mb-1.5 text-xs font-medium tracking-wide uppercase opacity-60">{children}</h2>
)

export const StatusBody: FC<{ data: StatusData }> = ({ data }) => (
  <div>
    {data.sandbox ? (
      <div class="alert alert-info alert-soft rounded-none border-x-0 border-t-0 py-1.5 text-xs">
        {/* Otherwise every credential reads "missing" and the page looks like a broken
            deployment rather than a sandbox that was built not to be able to act. */}
        <span>
          <strong class="font-medium">This is a sandbox.</strong> The credentials below were
          removed on purpose, the scheduler never started, and the docker socket points
          nowhere — so nothing you press here can reach GitHub, the model, or a container.
        </span>
      </div>
    ) : null}
    <div class="grid gap-x-8 gap-y-5 p-4 lg:max-w-6xl lg:grid-cols-2">
      <section>
        <H>Clocks</H>
        <KV
          rows={[
            [
              'last scan',
              data.scan.lastAt ? (
                <>
                  <Relative at={data.scan.lastAt} />
                  {data.scan.durationS ? ` · took ${data.scan.durationS}s` : ''}
                </>
              ) : (
                'never'
              ),
            ],
            [
              'next scan',
              data.scan.nextAt ? <Relative at={data.scan.nextAt} /> : `${data.scan.cron} (not scheduled)`,
            ],
            ['next digest', data.digest.nextAt ? <Relative at={data.digest.nextAt} /> : 'off'],
            ['quiet hours', data.blackout.length ? data.blackout.join(', ') : 'none'],
          ]}
        />
      </section>

      <section>
        <H>Credentials</H>
        <div class="divide-base-300 border-base-300 divide-y border-y text-xs">
          {data.credentials.map((cred) => (
            <div class="flex min-h-7 items-center gap-3">
              <span class="min-w-0 flex-1 font-mono">{cred.name}</span>
              <span class={`badge badge-xs badge-soft ${CRED_CLS[cred.state]}`}>{cred.state}</span>
            </div>
          ))}
        </div>
        <p class="mt-1 text-xs opacity-50">
          Presence only — values are never read into the UI.
          {data.sandbox ? ' In the sandbox they are all absent by design.' : ''}
        </p>
      </section>

      <section>
        <H>Changelog review, this month</H>
        <div class="flex items-baseline justify-between text-sm">
          <span>
            ${data.spentUsd.toFixed(2)} of ${data.budgetUsd.toFixed(2)}
          </span>
          <span class="text-xs opacity-60">
            {data.budgetUsd > 0 ? Math.round((data.spentUsd / data.budgetUsd) * 100) : 0}%
          </span>
        </div>
        <progress
          class="progress progress-primary my-1 w-full"
          value={String(data.spentUsd)}
          max={String(Math.max(data.budgetUsd, data.spentUsd))}
        />
        <div class="divide-base-300 border-base-300 divide-y border-y text-xs">
          {data.spend.map((sp) => (
            <div class="flex min-h-7 items-center justify-between gap-3">
              <span class="min-w-0 truncate font-mono">{sp.model}</span>
              <span class="shrink-0 opacity-70">
                {sp.purpose} · {sp.calls} calls · ${sp.cost.toFixed(2)}
              </span>
            </div>
          ))}
        </div>
        <p class="mt-1 text-xs opacity-50">
          Reaching the budget pauses reviews and drafting. It never stops a pull request
          opening.
        </p>
      </section>

      <section>
        <H>Recent deploys</H>
        {data.deploys.length === 0 ? (
          <p class="text-xs opacity-60">
            Nothing has been deployed by shipshape yet. A merge queues one; while it is
            paused, the button starts it.
          </p>
        ) : (
          <div class="divide-base-300 border-base-300 divide-y border-y text-xs">
            {data.deploys.map((d) => (
              <div class="flex min-h-7 items-center gap-3">
                <span class="min-w-0 flex-1 truncate">
                  <span class="font-medium">{d.stack}</span>
                  <span class="ml-2 font-mono opacity-60">{d.services}</span>
                </span>
                {d.trigger !== 'queue' ? (
                  <span class="badge badge-xs badge-ghost">{d.trigger}</span>
                ) : null}
                <span class={`badge badge-xs badge-soft ${DEPLOY_CLS[d.status] ?? 'badge-neutral'}`}>
                  {d.status}
                </span>
                <Relative at={d.at} />
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <H>This deployment</H>
        <KV
          rows={[
            ['version', data.version],
            ['checkout', data.repoDir],
            ['repository', data.repo],
            ['merge method', data.mergeMethod],
            ['publishes main', String(data.pushMain)],
          ]}
        />
      </section>

      <section>
        <H>Counters</H>
        <KV rows={data.budgets.map((b) => [b.key, `${b.value}${b.window ? ` (${b.window})` : ''}`])} />
      </section>

      <section class="lg:col-span-2">
        <H>What would merge on its own</H>
        <div
          class="border-base-300 border-y"
          hx-get="/merge/preview"
          hx-trigger="load"
          hx-swap="innerHTML"
        >
          <div class="py-2 text-xs opacity-60">checking…</div>
        </div>
      </section>
    </div>
  </div>
)

export const RawPolicy: FC<{ text: string }> = ({ text }) => (
  <pre class="p-4 font-mono text-xs break-words whitespace-pre-wrap">{text}</pre>
)

export const PromptEditor: FC<{
  name: string
  title: string
  help: string
  text: string
  customised: boolean
}> = ({ name, title, help, text, customised }) => (
  <section id={`prompt-${name}`} class="border-base-300 scroll-mt-2 border-t px-4 py-3">
    <div class="flex items-center gap-2">
      <h2 class="text-sm font-semibold">{title}</h2>
      <span class={`badge badge-xs badge-soft ${customised ? 'badge-primary' : 'badge-ghost'}`}>
        {customised ? 'edited' : 'default'}
      </span>
    </div>
    <p class="mt-1 max-w-prose text-xs opacity-60">{help}</p>
    <form
      hx-post={`/settings/prompt/${name}`}
      hx-target={`#prompt-${name}`}
      hx-swap="outerHTML"
      hx-indicator="#busy"
      class="mt-2 flex flex-col gap-2"
    >
      <textarea name="text" rows={12} class="textarea textarea-sm w-full font-mono text-xs">
        {text}
      </textarea>
      <div class="flex items-center gap-2">
        <button type="submit" class="btn btn-primary btn-sm tap">
          Save prompt
        </button>
        {customised ? (
          <button
            type="button"
            class="btn btn-ghost btn-sm tap"
            hx-post={`/settings/prompt/${name}/reset`}
            hx-target={`#prompt-${name}`}
            hx-swap="outerHTML"
          >
            Reset to default
          </button>
        ) : null}
        <span class="text-xs opacity-50">Takes effect on the next call.</span>
      </div>
    </form>
  </section>
)

export const DigestPreview: FC<{ title: string | null; body: string | null; count: number }> = ({
  title,
  body,
  count,
}) => (
  <div class="flex flex-col gap-2">
    {count === 0 ? (
      <p class="text-sm opacity-60">Nothing is waiting to be sent. An empty digest is never sent.</p>
    ) : (
      <>
        <p class="text-sm font-medium">{title}</p>
        <pre class="bg-base-200 overflow-x-auto rounded p-3 font-mono text-xs whitespace-pre-wrap">
          {body}
        </pre>
      </>
    )}
    <div class="flex items-center gap-2">
      <button
        type="button"
        class="btn btn-ghost btn-sm tap gap-1"
        hx-post="/settings/digest/send"
        hx-target="#digest-preview"
        hx-swap="innerHTML"
        hx-disabled-elt="this"
      >
        <Icon name="check" />
        Send it now
      </button>
      <button
        type="button"
        class="btn btn-ghost btn-sm tap gap-1"
        hx-post="/settings/email/test"
        hx-target="#digest-preview"
        hx-swap="innerHTML"
        hx-disabled-elt="this"
      >
        Send a test email
      </button>
    </div>
  </div>
)
