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
  <div role="tablist" class="tabs tabs-box tabs-sm w-fit">
    {SETTINGS_TABS.map((t) => (
      <a
        role="tab"
        href={t.href}
        class={`tab tap md:min-h-8 ${t.key === active ? 'tab-active' : ''}`}
        aria-selected={t.key === active ? 'true' : 'false'}
      >
        {t.label}
      </a>
    ))}
  </div>
)

const Field: FC<{ item: SettingValue; models?: string[] }> = ({ item, models }) => {
  const { def, value, changed } = item
  const id = def.path.replace(/\./g, '-')
  return (
    <fieldset class="fieldset border-base-300 border-b py-3 last:border-0">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label for={id} class="min-w-40 text-sm font-medium">
          {def.label}
        </label>
        <div class="min-w-0 flex-1">
          {def.locked ? (
            <span class="font-mono text-sm opacity-70">{value}</span>
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
                class="toggle toggle-md md:toggle-sm"
                checked={value === 'true'}
              />
            </>
          ) : def.kind === 'enum' && def.options ? (
            <select id={id} name={def.path} class="select select-sm tap w-full max-w-xs md:min-h-8">
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
                class="input input-sm tap w-full max-w-xs font-mono md:min-h-8"
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
              class={`input input-sm tap w-full max-w-xs md:min-h-8 ${def.kind === 'cron' || def.kind === 'windows' ? 'font-mono' : ''}`}
            />
          )}
        </div>
        {changed ? <span class="badge badge-xs badge-primary badge-soft">changed</span> : null}
      </div>
      {def.help || def.locked || def.about ? (
        <p class="mt-1 text-xs opacity-60">
          {/* `help` is a fragment ("x.y.Z"), `about` a sentence. Run together they read as
              one broken sentence, so they are joined rather than concatenated. */}
          {[
            def.locked ?? def.help,
            def.about,
            !def.locked && changed ? `Default: ${def.defaultLabel ?? def.defaultValue}.` : '',
          ]
            .filter(Boolean)
            .map((part) => String(part).trim())
            .map((part) => (/[.!?]$/.test(part) ? part : `${part}.`))
            .join(' ')}
        </p>
      ) : null}
    </fieldset>
  )
}

const Section: FC<{
  title: string
  prose?: string[]
  items: SettingValue[]
  models?: string[]
}> = ({ title, prose, items, models }) => (
  <section id={slug(title)} class="card card-border bg-base-100">
    <div class="card-body gap-0 p-4">
      <h2 class="text-sm font-semibold">{title}</h2>
      {/* The explanation lives here rather than behind a link. It was a separate page
          for a while, which meant answering "what does this actually do" cost a page
          load and a scroll back to the control you were looking at. */}
      {prose?.map((para) => (
        <p class="mt-1.5 text-xs leading-relaxed opacity-70">{withCode(para)}</p>
      ))}
      <div class="mt-3">
        {items.map((item) => (
          <Field item={item} models={models} />
        ))}
      </div>
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
    class="flex flex-col gap-4"
  >
    {banner ? (
      <div
        class={`alert alert-soft py-2 text-sm ${banner.level === 'error' ? 'alert-error' : 'alert-success'}`}
      >
        {banner.text}
      </div>
    ) : null}
    {readyCount ? (
      <p class="text-xs opacity-60">
        {readyCount} merged {readyCount === 1 ? 'update is' : 'updates are'} waiting for a
        deploy. Unpausing does not start them — press Deploy on each.
      </p>
    ) : null}
    {groups.map((g) => (
      <Section title={g.title} prose={g.prose} items={g.items} models={models} />
    ))}
    <div class="actionbar bg-base-100/95 border-base-300 flex items-center gap-3 border-t py-3 backdrop-blur lg:static lg:border-0 lg:bg-transparent lg:backdrop-blur-none">
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
  <div class="card card-border bg-base-100">
    <div class="card-body gap-0 p-0">
      {rows.map(([k, v]) => (
        <div class="border-base-300 flex items-center gap-3 border-b px-3 py-2 text-sm last:border-0">
          <span class="w-40 shrink-0 opacity-70">{k}</span>
          <span class="min-w-0 flex-1 font-mono text-xs break-all">{v}</span>
        </div>
      ))}
    </div>
  </div>
)

export const StatusBody: FC<{ data: StatusData }> = ({ data }) => (
  <div class="flex flex-col gap-5">
    {data.sandbox ? (
      <div class="alert alert-info alert-soft py-2 text-sm">
        {/* Otherwise every credential reads "missing" and the page looks like a broken
            deployment rather than a sandbox that was built not to be able to act. */}
        <span>
          <strong class="font-medium">This is a sandbox.</strong> The credentials below were
          removed on purpose, the scheduler never started, and the docker socket points
          nowhere — so nothing you press here can reach GitHub, the model, or a container.
        </span>
      </div>
    ) : null}
    <section>
      <h2 class="mb-2 text-xs font-medium tracking-wide uppercase opacity-60">Clocks</h2>
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
      <h2 class="mb-2 text-xs font-medium tracking-wide uppercase opacity-60">Credentials</h2>
      <p class="mb-2 text-xs opacity-60">
        Presence only — values are never read into the UI.
        {data.sandbox ? ' In the sandbox they are all absent by design.' : ''}
      </p>
      <div class="card card-border bg-base-100">
        <div class="card-body gap-0 p-0">
          {data.credentials.map((cred) => (
            <div class="border-base-300 flex items-center gap-3 border-b px-3 py-2 text-sm last:border-0">
              <span class="min-w-0 flex-1 font-mono text-xs">{cred.name}</span>
              <span class={`badge badge-xs badge-soft ${CRED_CLS[cred.state]}`}>{cred.state}</span>
            </div>
          ))}
        </div>
      </div>
    </section>

    <section>
      <h2 class="mb-2 text-xs font-medium tracking-wide uppercase opacity-60">
        Changelog review, this month
      </h2>
      <div class="card card-border bg-base-100">
        <div class="card-body gap-2 p-4">
          <div class="flex items-baseline justify-between text-sm">
            <span>
              ${data.spentUsd.toFixed(2)} of ${data.budgetUsd.toFixed(2)}
            </span>
            <span class="text-xs opacity-60">
              {data.budgetUsd > 0 ? Math.round((data.spentUsd / data.budgetUsd) * 100) : 0}%
            </span>
          </div>
          <progress
            class="progress progress-primary w-full"
            value={String(data.spentUsd)}
            max={String(Math.max(data.budgetUsd, data.spentUsd))}
          />
          {data.spend.map((s) => (
            <div class="flex items-baseline justify-between text-xs opacity-70">
              <span class="font-mono">{s.model}</span>
              <span>
                {s.purpose} · {s.calls} calls · ${s.cost.toFixed(2)}
              </span>
            </div>
          ))}
          <p class="text-xs opacity-50">
            Reaching the budget pauses reviews and drafting. It never stops a pull request
            opening.
          </p>
        </div>
      </div>
    </section>

    <section>
      <h2 class="mb-2 text-xs font-medium tracking-wide uppercase opacity-60">Recent deploys</h2>
      {data.deploys.length === 0 ? (
        <p class="text-sm opacity-60">
          Nothing has been deployed by shipshape yet. A merge queues one; while it is
          paused, the button starts it.
        </p>
      ) : (
        <div class="card card-border bg-base-100">
          <div class="card-body gap-0 p-0">
            {data.deploys.map((d) => (
              <div class="border-base-300 flex items-center gap-3 border-b px-3 py-2 text-sm last:border-0">
                <span class="min-w-0 flex-1">
                  <span class="font-medium">{d.stack}</span>
                  <span class="ml-2 font-mono text-xs opacity-60">{d.services}</span>
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
        </div>
      )}
    </section>

    <section>
      <h2 class="mb-2 text-xs font-medium tracking-wide uppercase opacity-60">This deployment</h2>
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
      <h2 class="mb-2 text-xs font-medium tracking-wide uppercase opacity-60">Counters</h2>
      <KV rows={data.budgets.map((b) => [b.key, `${b.value}${b.window ? ` (${b.window})` : ''}`])} />
    </section>

    <section>
      <h2 class="mb-2 text-xs font-medium tracking-wide uppercase opacity-60">
        What would merge on its own
      </h2>
      <div
        class="card card-border bg-base-100"
        hx-get="/merge/preview"
        hx-trigger="load"
        hx-swap="innerHTML"
      >
        <div class="card-body p-4 text-sm opacity-60">checking…</div>
      </div>
    </section>
  </div>
)

export const RawPolicy: FC<{ text: string }> = ({ text }) => (
  <pre class="bg-base-100 border-base-300 overflow-x-auto rounded border p-4 font-mono text-xs">
    {text}
  </pre>
)

export const PromptEditor: FC<{
  name: string
  title: string
  help: string
  text: string
  customised: boolean
}> = ({ name, title, help, text, customised }) => (
  <div id={`prompt-${name}`} class="card card-border bg-base-100">
    <div class="card-body gap-2 p-4">
      <div class="flex items-center gap-2">
        <h2 class="text-sm font-semibold">{title}</h2>
        <span class={`badge badge-xs badge-soft ${customised ? 'badge-primary' : 'badge-neutral'}`}>
          {customised ? 'edited' : 'default'}
        </span>
      </div>
      <p class="text-xs opacity-60">{help}</p>
      <form
        hx-post={`/settings/prompt/${name}`}
        hx-target={`#prompt-${name}`}
        hx-swap="outerHTML"
        hx-indicator="#busy"
        class="flex flex-col gap-2"
      >
        <textarea name="text" rows={14} class="textarea w-full font-mono text-xs">
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
    </div>
  </div>
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
