import type { FC } from 'hono/jsx'
import { Relative } from './parts.tsx'

/**
 * The machine's own state: what it is doing, what it is wired to, what it has spent.
 *
 * Its own page rather than a tab of Settings, because nothing here is a decision. Settings
 * is where you change what shipshape may do; this is where you find out what it did, and
 * the two answer different questions often enough that folding one into the other made the
 * second one hard to reach.
 *
 * The rule the page is built to: everything on it is for a person. A raw epoch, a JSON
 * blob and a counter whose name is its database key are all things the database happens to
 * store, and printing them verbatim is how the page came to read as a debug dump -- so the
 * scan telemetry is rendered as the sentence it always was, and the counters that are
 * already stated properly somewhere else on this page are not repeated as machine values.
 */

export interface StatusData {
  version: string
  repoDir: string
  repo: string
  mergeMethod: string
  pushMain: boolean
  blackout: string[]
  scan: {
    cron: string
    lastAt: string | null
    nextAt: string | null
    durationS: number | null
    /** Per-outcome tally from the last sweep, already parsed out of its stored JSON. */
    counts: Record<string, number> | null
  }
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

/**
 * Counters restated elsewhere on this page, in words.
 *
 * They stay in the database and still drive the sections above; what is dropped is the
 * second, worse rendering of them -- an epoch beside a date, and a JSON object printed as
 * itself. Anything the table gains later appears in Counters on its own.
 */
const RESTATED = new Set([
  'scan.last_at',
  'scan.last_duration_s',
  'scan.last_counts',
  'claude.spend_usd',
  'dockerhub.pulls',
])

/**
 * The scan's outcome keys, in the words the rest of the interface already uses.
 *
 * These keys are `persist()`'s return values -- database words -- and the Activity log
 * says this same scan in house wording through `summarise()` (src/scan.ts). Printing the
 * keys here would give one event two vocabularies and a dictionary for neither, which is
 * the thing this page exists to have stopped doing. Two keys deliberately share a label:
 * failing to read a registry and failing to write the row are both an error to the person
 * reading this, so they are summed rather than listed twice as "4 errors · 1 errors".
 *
 * An unrecognised key falls through as itself -- a new outcome should look out of place
 * here and get a word, rather than silently vanish from the count.
 */
const OUTCOME: Record<string, string | [one: string, many: string]> = {
  update: ['update', 'updates'],
  bootstrapped: ['digest baseline initialised', 'digest baselines initialised'],
  'moved-rolling': ['rolling image moved', 'rolling images moved'],
  'moved-pinned': ['pinned digest moved', 'pinned digests moved'],
  retiered: ['policy change', 'policy changes'],
  'needs-attention': 'needing attention',
  error: ['error', 'errors'],
  'persist-error': ['error', 'errors'],
  'up-to-date': 'up to date',
  unchanged: 'unchanged',
  skipped: 'not tracked',
  dismissed: 'dismissed',
  'known-failed': 'previously failed',
}

/**
 * `{ "up-to-date": 62, unchanged: 45 }` -> `62 up to date · 45 unchanged`, biggest first.
 *
 * Counted first and worded second, because the two keys that share a label have to be
 * summed before anything can decide whether that label is plural.
 */
function tally(counts: Record<string, number>): string {
  const merged = new Map<string, { one: string; many: string; n: number }>()
  for (const [key, n] of Object.entries(counts)) {
    if (n <= 0) continue
    const label = OUTCOME[key] ?? key
    const [one, many] = typeof label === 'string' ? [label, label] : label
    const seen = merged.get(one)
    if (seen) seen.n += n
    else merged.set(one, { one, many, n })
  }
  return [...merged.values()]
    .sort((a, b) => b.n - a.n)
    .map((e) => `${e.n} ${e.n === 1 ? e.one : e.many}`)
    .join(' · ')
}

/**
 * The Docker Hub row, which reads backwards unless it is spelled out.
 *
 * `dockerhub.pulls` stores `ratelimit-remaining` -- the allowance *left*, not the pulls
 * spent (see `hubRemaining` in src/registry/http.ts, and the reserve floor that refuses a
 * pull when it gets low). Under its database name beside a bare `200` it reads as pulls
 * made, which is the opposite of what it says, and the `200;w=3600` window it carries is
 * a rate-limit header rather than anything a person asked for.
 */
function hubPulls(budgets: StatusData['budgets']): string | null {
  const hub = budgets.find((b) => b.key === 'dockerhub.pulls')
  if (!hub) return null
  const limit = hub.window ? Number(hub.window.split(';')[0]) : NaN
  return Number.isFinite(limit) ? `${hub.value} of ${limit} left this hour` : `${hub.value} left`
}

const KV: FC<{ rows: [string, unknown][] }> = ({ rows }) => (
  <div class="divide-base-300 border-base-300 divide-y border-y text-xs">
    {rows.map(([k, v]) => (
      <div class="flex min-h-7 items-center gap-3">
        <span class="w-28 shrink-0 opacity-70">{k}</span>
        {/* break-words, not break-all: a checkout path has no spaces and must still be
            allowed to break mid-token, but the scan tally is words, and break-all split
            it as "1 skippe / d". Wrapping only where a word genuinely cannot fit gives
            both. */}
        <span class="min-w-0 flex-1 font-mono break-words">{v}</span>
      </div>
    ))}
  </div>
)

const H: FC<{ children?: unknown }> = ({ children }) => (
  <h2 class="mb-1.5 text-xs font-medium tracking-wide uppercase opacity-60">{children}</h2>
)

/**
 * One block of the page.
 *
 * `break-inside-avoid` is what makes the two columns below behave: the column box flows
 * the blocks and balances their height, where the grid it replaced put each block in a
 * row cell and left every short one padded out to the height of whatever sat beside it.
 */
const Block: FC<{ children?: unknown }> = ({ children }) => (
  <section class="mb-6 break-inside-avoid">{children}</section>
)

export const StatusBody: FC<{ data: StatusData }> = ({ data }) => {
  const counters = data.budgets.filter((b) => !RESTATED.has(b.key))
  const hub = hubPulls(data.budgets)
  return (
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
      <div class="p-4 lg:max-w-6xl">
        <div class="lg:columns-2 lg:gap-8">
          <Block>
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
                // The same tally that used to be a JSON object in the counters dump. It
                // belongs against the scan it describes, where it reads as a result.
                ...(data.scan.counts && tally(data.scan.counts)
                  ? ([['found', tally(data.scan.counts)]] as [string, unknown][])
                  : []),
                [
                  'next scan',
                  data.scan.nextAt ? (
                    <Relative at={data.scan.nextAt} />
                  ) : (
                    <>
                      not scheduled
                      <span class="ml-2 opacity-50">{data.scan.cron}</span>
                    </>
                  ),
                ],
                ['next digest', data.digest.nextAt ? <Relative at={data.digest.nextAt} /> : 'off'],
                ['quiet hours', data.blackout.length ? data.blackout.join(', ') : 'none'],
                // Hourly, so it belongs with the clocks rather than under a heading of
                // its own -- and stated in the direction it actually counts.
                ...(hub ? ([['hub pulls', hub]] as [string, unknown][]) : []),
              ]}
            />
          </Block>

          <Block>
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
          </Block>

          <Block>
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
            {data.spend.length === 0 ? (
              <p class="text-xs opacity-60">Nothing has been read this month.</p>
            ) : (
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
            )}
            <p class="mt-1 text-xs opacity-50">
              Reaching the budget pauses reviews and drafting. It never stops a pull request
              opening.
            </p>
          </Block>

          <Block>
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
          </Block>

          <Block>
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
          </Block>

          {counters.length > 0 ? (
            <Block>
              <H>Counters</H>
              <KV
                rows={counters.map((b) => [
                  b.key,
                  <>
                    {b.value}
                    {b.window ? <span class="ml-2 opacity-50">{b.window}</span> : null}
                  </>,
                ])}
              />
            </Block>
          ) : null}
        </div>

        {/* Full width and last: it is the only thing here that is about what happens next
            rather than what already has, and it is the one block that loads on its own. */}
        <section class="border-base-300 border-t pt-4">
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
}
