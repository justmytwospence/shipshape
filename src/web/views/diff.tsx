import type { FC } from 'hono/jsx'
import type { DiffResult, DiffHunk, ForkChange } from '../../diff.ts'
import type { RefLinks } from '../../links.ts'

/**
 * The change itself: the hunks a pull request carries, any config changes a model
 * drafted onto it, and the row of links you might want before merging.
 *
 * Rendered inside the update pane's "The change" disclosure. Everything here is read,
 * not pressed -- the verbs live in the pane's action bar, once, so nothing down here can
 * swap the wrong region.
 */

const MARK: Record<string, string> = { ctx: ' ', del: '-', add: '+' }

export interface ProposalSummary {
  summary: string
  notes: string[]
  changed: string[]
  error: string | null
  model: string
  /** The proposal's own diff, captured when it was applied. */
  hunks: DiffHunk[]
}

const Hunk: FC<{ hunk: DiffHunk }> = ({ hunk: h }) => (
  <div class="border-base-300 my-2 overflow-hidden rounded border">
    <div class="bg-base-200 flex items-baseline gap-3 px-2 py-1 font-mono text-xs">
      <span class="font-medium">{h.file}</span>
      <span class="opacity-60">{h.header}</span>
    </div>
    <div class="diff-file">
      {h.lines.map((l) => (
        <div class={`dl ${l.kind}`}>
          <span class="ln">{l.no ?? ''}</span>
          <span class="sign">{MARK[l.kind]}</span>
          <span class="txt">{l.text}</span>
        </div>
      ))}
    </div>
  </div>
)

/** The fork repository's web address, for linking a commit, when it is on GitHub. */
function forkWeb(forkUrl: string): string | null {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(forkUrl)
  return m ? `https://github.com/${m[1]}` : null
}

const FORK_REF_WORDS: Record<string, string> = {
  open: 'open',
  'merged-unreleased': 'merged, not released',
  released: 'released',
  'closed-unfixed': 'closed without a fix',
  unknown: 'could not be looked up',
}

const CommitLine: FC<{ c: { sha: string; short: string; subject: string; author: string }; web: string | null; note?: string }> = ({
  c,
  web,
  note,
}) => (
  <li class="flex flex-wrap items-baseline gap-x-2">
    {web ? (
      <a href={`${web}/commit/${c.sha}`} target="_blank" rel="noopener" class="link link-hover font-mono">
        {c.short}
      </a>
    ) : (
      <span class="font-mono">{c.short}</span>
    )}
    <span>{c.subject}</span>
    <span class="opacity-60">{c.author}</span>
    {note ? <span class="opacity-60">— {note}</span> : null}
  </li>
)

/**
 * What a fork's change carries beyond its hunks (FORKS.md): the replay pushed to the fork,
 * the fixes kept, the ones dropped as already upstream, and what the fork still waits on.
 * A retire has no replay and says what the fork is replaced with.
 */
const ForkBlock: FC<{ fork: ForkChange }> = ({ fork }) => {
  const web = forkWeb(fork.forkUrl)
  return (
    <div class="border-base-300 my-2 border-l-2 pl-3">
      <p class="font-medium">{fork.kind === 'retire' ? 'Retiring the fork' : 'Carried fixes'}</p>
      <p class="text-xs opacity-70">
        {fork.kind === 'retire' ? (
          <>
            Nothing is left to carry: the plain upstream image comes back as{' '}
            <code class="font-mono">{fork.upstreamRef}</code>, and the build block and the fork labels go. The
            comment block is yours to tidy.
          </>
        ) : (
          <>
            Our fixes were replayed onto the new release and pushed to the fork as{' '}
            {web && fork.sha ? (
              <a href={`${web}/commit/${fork.sha}`} target="_blank" rel="noopener" class="link link-hover font-mono">
                {fork.tag}
              </a>
            ) : (
              <code class="font-mono">{fork.tag}</code>
            )}
            ; the build pins that commit.
          </>
        )}
      </p>
      {fork.carried.length > 0 ? (
        <>
          <p class="mt-1 text-xs font-medium tracking-wide uppercase opacity-60">Kept</p>
          <ul class="text-xs">
            {fork.carried.map((c) => (
              <CommitLine c={c} web={web} />
            ))}
          </ul>
        </>
      ) : null}
      {fork.dropped.length > 0 ? (
        <>
          <p class="mt-1 text-xs font-medium tracking-wide uppercase opacity-60">Dropped, already upstream</p>
          <ul class="text-xs">
            {fork.dropped.map((c) => (
              <CommitLine c={c} web={web} note={c.reason} />
            ))}
          </ul>
        </>
      ) : null}
      {fork.waitsOn.length > 0 ? (
        <>
          <p class="mt-1 text-xs font-medium tracking-wide uppercase opacity-60">Waiting on</p>
          <ul class="text-xs">
            {fork.waitsOn.map((w) => (
              <li>
                <span class="font-mono">{w.ref}</span>{' '}
                <span class="opacity-60">
                  {FORK_REF_WORDS[w.state] ?? w.state}
                  {w.state === 'released' && w.releasedIn ? ` in ${w.releasedIn}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  )
}

const Ext: FC<{ href: string; children?: unknown }> = ({ href, children }) => (
  <a href={href} target="_blank" rel="noopener" class="btn btn-ghost btn-xs tap font-normal">
    {children} ↗
  </a>
)

export const DiffView: FC<{
  result: DiffResult
  links?: RefLinks
  prUrl?: string | null
  prNumber?: number | null
  prScope?: string | null
  proposal?: ProposalSummary
  canPropose?: boolean
  /** Whose service this is, so a missing upstream can be linked from here. */
  service?: { stack: string; service: string }
}> = ({ result, links, prUrl, prNumber, prScope, proposal, service }) => (
  <div class="text-sm">
    {'error' in result ? (
      <p class="text-xs opacity-60">{result.error}</p>
    ) : (
      result.hunks.map((h) => <Hunk hunk={h} />)
    )}
    {!('error' in result) && result.fork ? <ForkBlock fork={result.fork} /> : null}

    {proposal ? (
      <div class={`border-l-2 pl-3 ${proposal.error ? 'border-warning' : 'border-base-300'} my-2`}>
        <p class="font-medium">
          {proposal.error
            ? 'Config changes drafted but not applied'
            : proposal.changed.length > 0
              ? 'Config changes drafted'
              : 'No config change needed'}
        </p>
        {proposal.error ? <p class="text-warning text-xs">{proposal.error}</p> : null}
        <p class="text-xs opacity-70">{proposal.summary}</p>
        {proposal.changed.length > 0 && (
          <ul class="mt-1 list-disc pl-4 text-xs">
            {proposal.changed.map((c) => (
              <li>{c}</li>
            ))}
          </ul>
        )}
        {/* The change itself, not just a description of it. */}
        {proposal.hunks.map((h) => (
          <Hunk hunk={h} />
        ))}
        {proposal.notes.length > 0 && (
          <>
            <p class="mt-1 text-xs font-medium tracking-wide uppercase opacity-60">Manual steps</p>
            <ul class="list-disc pl-4 text-xs">
              {proposal.notes.map((n) => (
                <li>{n}</li>
              ))}
            </ul>
          </>
        )}
        <p class="mt-1 text-xs opacity-50">
          Drafted by <code class="font-mono">{proposal.model}</code>. Nothing has verified
          these; read the commit before merging.
        </p>
      </div>
    ) : null}

    {prScope === 'modified' && prUrl ? (
      <p class="text-warning my-2 text-xs">
        This branch has been edited since shipshape wrote it — the preview above is no
        longer the whole change. <Ext href={`${prUrl}/files`}>See the pull request’s own diff</Ext>
      </p>
    ) : null}

    {/* Everything you might want to check before merging, one click away. */}
    <p class="-mx-2 flex flex-wrap gap-x-1 gap-y-1 py-1">
      {links?.image && <Ext href={links.image}>image</Ext>}
      {links?.tag && <Ext href={links.tag}>new tag</Ext>}
      {links?.releases && <Ext href={links.releases}>releases</Ext>}
      {links?.source && <Ext href={links.source}>project</Ext>}
      {/* How the *image* is configured, which the project's own README rarely covers. */}
      {links?.docs && <Ext href={links.docs}>image docs</Ext>}
      {prUrl && prNumber ? <Ext href={prUrl}>pull request #{prNumber}</Ext> : null}
      {/* No project means no release notes; the service's page is where that is fixed. */}
      {links && !links.source && service ? (
        <a href={`/services/${service.stack}/${service.service}`} class="btn btn-ghost btn-xs tap font-normal">
          link the upstream
        </a>
      ) : null}
    </p>
  </div>
)
