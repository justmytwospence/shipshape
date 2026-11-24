import type { FC } from 'hono/jsx'
import { ExtLink, Relative } from './parts.tsx'
import { describeCron } from './settings.tsx'
import { ZONE } from '../../time.ts'
import type { SecurityPanel } from '../../../security/panel.ts'

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
  pushMain: boolean
  /** The branch shipshape publishes to. */
  branch?: string
  /** The remote's host, `local repository`, or `not set`. */
  remote?: string
  /** Where the policy file is, and whether it exists yet. */
  policyFile?: { rel: string; exists: boolean }
  /** How many compose files the last scan found; null before any scan. */
  composeFiles?: number | null
  scan: {
    cron: string
    lastAt: string | null
    nextAt: string | null
    durationS: number | null
    /** Per-outcome tally from the last sweep, already parsed out of its stored JSON. */
    counts: Record<string, number> | null
  }
  /** `refused` is present-but-rejected: a token can be all three of set, wrong and silent. */
  credentials: {
    name: string
    state: 'set' | 'missing' | 'not in use' | 'refused' | 'budget spent' | 'off' | 'shadow' | 'on'
    /** Why it reads the way it does, when that is not obvious from the word. */
    note?: string
  }[]
  spend: { model: string; purpose: string; calls: number; cost: number }[]
  budgetUsd: number
  spentUsd: number
  /** False with a custom endpoint, whose calls are recorded at no cost. */
  priced: boolean
  deploys: { at: string | null; stack: string; services: string; status: string; trigger: string }[]
  budgets: { key: string; value: number; window: string | null }[]
  /** Where watched images' release notes come from: how many are certain, likely, or unknown. */
  upstream?: { total: number; linked: number; likely: number; notFound: number; notLooked: number; failing: number }
  /** Security incidents matched against what runs here (src/security). */
  security?: SecurityPanel
  /** True in the sandbox dev server, where the credentials are deliberately absent. */
  sandbox?: boolean
}

const CRED_CLS: Record<string, string> = {
  set: 'badge-success',
  missing: 'badge-error',
  'not in use': 'badge-ghost',
  refused: 'badge-error',
  // Present and valid, and buying nothing. The same distinction `refused` draws for the
  // GitHub token: presence is not health, and a key that cannot be spent reads `set` all
  // month otherwise.
  'budget spent': 'badge-warning',
  off: 'badge-ghost',
  shadow: 'badge-info',
  on: 'badge-success',
}


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

/** A deploy row's status, in the stage words the rest of the interface uses. */
const DEPLOY_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Queued', cls: 'badge-ghost' },
  running: { label: 'Deploying', cls: 'badge-info' },
  deployed: { label: 'Soaking', cls: 'badge-info' },
  verified: { label: 'Verified', cls: 'badge-success' },
  degraded: { label: 'Degraded', cls: 'badge-warning' },
  failed: { label: 'Deploy failed', cls: 'badge-error' },
  error: { label: 'Deploy failed', cls: 'badge-error' },
  'rolled-back': { label: 'Rolled back', cls: 'badge-error' },
  'left-stopped': { label: 'Left stopped', cls: 'badge-ghost' },
  ready: { label: 'Ready to deploy', cls: 'badge-info' },
  superseded: { label: 'Superseded', cls: 'badge-ghost' },
}

/** What started a deploy. */
const TRIGGER: Record<string, string> = {
  queue: 'after a ship',
  operator: 'you pressed Deploy',
  redeploy: 'redeploy',
  retry: 'try again',
  rollback: 'roll back',
}

const H: FC<{ children?: unknown }> = ({ children }) => (
  <h2 class="mb-1.5 text-xs font-medium tracking-wide uppercase opacity-70">{children}</h2>
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

/** How many watched images have a certain source for their release notes, and a way to the rest. */
const UpstreamCounts: FC<{ u: NonNullable<StatusData['upstream']> }> = ({ u }) => {
  const rest = [
    u.likely ? `${u.likely} likely` : '',
    u.notFound ? `${u.notFound} not found` : '',
    u.notLooked ? `${u.notLooked} not looked up yet` : '',
    u.failing ? `${u.failing} could not be looked up` : '',
  ].filter(Boolean)
  return (
    <>
      {`${u.linked} of ${u.total} linked`}
      {rest.length > 0 ? ` · ${rest.join(' · ')}` : ''}
      {u.total > u.linked ? (
        <a href="/services?filter=unlinked" class="link ml-2 font-sans">
          Show them
        </a>
      ) : null}
    </>
  )
}

/**
 * Security incidents, as matched against the running images' own inventories.
 *
 * Facts only: which services carry a version an incident names, and which update was
 * read -- from its own image -- to remove it. Whether that update may merge on its own is
 * the merge gate's question, answered on the update.
 */
const SecurityBlock: FC<{ s: SecurityPanel }> = ({ s }) => (
  <Block>
    <H>Security incidents</H>
    <KV
      rows={[
        ['mode', `${s.mode}${s.mode === 'on' ? (s.autoMerge ? ' · verified fixes ship on their own' : ' · fixes wait for you') : ' · shown, not acted on'}`],
        ['incidents', `${s.incidents} followed · ${s.withTargets} could match an image`],
        [
          'inventories',
          `${s.running - s.uninventoried} of ${s.running} running services${s.uninventoried > 0 ? ` · ${s.uninventoried} ${s.uninventoried === 1 ? 'image' : 'images'} still to read` : ''}`,
        ],
        ['next look', s.nextAt ? <Relative at={s.nextAt} /> : 'not scheduled'],
      ]}
    />
    {s.exposures.length === 0 ? (
      <p class="mt-1 text-xs opacity-70">Nothing running carries a version a followed incident names.</p>
    ) : (
      <div class="divide-base-300 border-base-300 mt-2 divide-y border-y text-xs">
        {s.exposures.map((e) => (
          <div class="py-1.5">
            <div class="flex items-center gap-2">
              <span class={`badge badge-xs badge-soft ${e.severity === 'critical' ? 'badge-error' : 'badge-warning'}`}>
                {e.severity ?? 'unrated'}
              </span>
              {e.exploited ? <span class="badge badge-xs badge-soft badge-error">exploited</span> : null}
              {e.url ? (
                <ExtLink href={e.url} class="link tap flex min-w-0 flex-1 items-center">
                  <span class="truncate">{e.title}</span>
                </ExtLink>
              ) : (
                <span class="min-w-0 flex-1 truncate">{e.title}</span>
              )}
            </div>
            {e.services.map((sv) => (
              <div class="mt-0.5 flex flex-wrap items-center gap-x-2 pl-2 opacity-80">
                <a href={`/services/${sv.stack}/${sv.service}`} class="link tap inline-flex items-center font-mono">
                  {sv.stack === sv.service ? sv.service : `${sv.stack}/${sv.service}`}
                </a>
                <span class="font-mono">{sv.packages.map((p) => `${p.name} ${p.installed}`).join(', ')}</span>
                {sv.fix ? (
                  <a href={`/updates/${sv.fix.updateId}`} class="link tap inline-flex items-center">
                    fixed by {sv.fix.toTag}
                  </a>
                ) : (
                  <span class="opacity-70">no fix yet</span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    )}
  </Block>
)

export const StatusBody: FC<{ data: StatusData }> = ({ data }) => {
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
            nowhere — so nothing you press here can reach your git host, the model, or a container.
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
                ...(data.upstream && data.upstream.total > 0
                  ? ([['upstream', <UpstreamCounts u={data.upstream} />]] as [string, unknown][])
                  : []),
                [
                  'next scan',
                  data.scan.nextAt ? (
                    <Relative at={data.scan.nextAt} />
                  ) : (
                    <>
                      not scheduled
                      <span class="ml-2 opacity-70">{describeCron(data.scan.cron, ZONE) ?? data.scan.cron}</span>
                    </>
                  ),
                ],
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
                <div class="flex min-h-7 flex-wrap items-center gap-x-3 py-1">
                  <span class="min-w-0 flex-1 font-mono">{cred.name}</span>
                  <span class={`badge badge-xs badge-soft ${CRED_CLS[cred.state]}`}>{cred.state}</span>
                  {cred.note ? <span class="w-full text-xs opacity-70">{cred.note}</span> : null}
                </div>
              ))}
            </div>
            <p class="mt-1 text-xs opacity-70">
              Presence only — values are never read into the UI.
              {data.sandbox ? ' In the sandbox they are all absent by design.' : ''}
            </p>
          </Block>

          <Block>
            <H>Changelog review, this month</H>
            {data.priced ? (
              <>
                <div class="flex items-baseline justify-between text-sm">
                  <span>
                    ${data.spentUsd.toFixed(2)} of ${data.budgetUsd.toFixed(2)}
                  </span>
                  <span class="text-xs opacity-70">
                    {data.budgetUsd > 0 ? Math.round((data.spentUsd / data.budgetUsd) * 100) : 0}%
                  </span>
                </div>
                <progress
                  class="progress progress-primary my-1 w-full"
                  value={String(data.spentUsd)}
                  max={String(Math.max(data.budgetUsd, data.spentUsd))}
                />
              </>
            ) : (
              <div class="text-sm">
                <span>unpriced (custom endpoint)</span>
              </div>
            )}
            {data.spend.length === 0 ? (
              <p class="text-xs opacity-70">Nothing has been read this month.</p>
            ) : (
              <div class="divide-base-300 border-base-300 divide-y border-y text-xs">
                {data.spend.map((sp) => (
                  <div class="flex min-h-7 items-center justify-between gap-3">
                    <span class="min-w-0 truncate font-mono">{sp.model}</span>
                    <span class="shrink-0 opacity-70">
                      {sp.purpose} · {sp.calls} calls
                      {data.priced || sp.cost > 0 ? ` · $${sp.cost < 0.1 ? sp.cost.toFixed(4) : sp.cost.toFixed(2)}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <p class="mt-1 text-xs opacity-70">
              {data.priced
                ? 'Reaching the budget pauses the reader and drafting; the screen keeps going under its own $1 ceiling. Updates keep shipping on the evidence that is left.'
                : 'A custom endpoint is not priced, so the budget never pauses it. The screen, if on, is still counted under its own $1 ceiling.'}
            </p>
          </Block>

          {data.security && data.security.mode !== 'off' ? <SecurityBlock s={data.security} /> : null}

          <Block>
            <H>This deployment</H>
            <KV
              rows={[
                ['version', data.version],
                ['checkout', data.repoDir || 'not set'],
                ['repository', data.repo || 'not set'],
                ['remote', data.remote ?? 'not set'],
                ['ships as', `merge commits on ${data.branch ?? 'main'}`],
                [`publishes ${data.branch ?? 'main'}`, data.pushMain ? 'yes' : 'no'],
                ...(data.policyFile
                  ? [['policy file', data.policyFile.exists ? data.policyFile.rel : `none yet — defaults apply; Settings creates ${data.policyFile.rel}`] as [string, string]]
                  : []),
                ...(data.composeFiles !== undefined
                  ? [['compose files', data.composeFiles == null ? 'not scanned yet' : data.composeFiles === 0 ? 'none found — check REPO_DIR' : String(data.composeFiles)] as [string, string]]
                  : []),
              ]}
            />
          </Block>

          <Block>
            <H>Recent deploys</H>
            {data.deploys.length === 0 ? (
              <p class="text-xs opacity-70">No deploys yet.</p>
            ) : (
              <div class="divide-base-300 border-base-300 divide-y border-y text-xs">
                {data.deploys.map((d) => {
                  const st = DEPLOY_STATUS[d.status] ?? { label: d.status, cls: 'badge-ghost' }
                  return (
                    <div class="flex min-h-7 flex-wrap items-center gap-x-2 py-1">
                      <Relative at={d.at} />
                      <span class="font-mono">{d.stack}</span>
                      <span class="min-w-0 flex-1 truncate opacity-70">{d.services}</span>
                      <span class={`badge badge-xs badge-soft ${st.cls}`}>{st.label}</span>
                      <span class="opacity-70">{TRIGGER[d.trigger] ?? d.trigger}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </Block>

        </div>

      </div>
    </div>
  )
}
