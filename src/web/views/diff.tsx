import type { FC } from 'hono/jsx'
import type { DiffResult, DiffHunk } from '../../diff.ts'
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
}> = ({ result, links, prUrl, prNumber, prScope, proposal }) => (
  <div class="text-sm">
    {'error' in result ? (
      <p class="text-xs opacity-60">{result.error}</p>
    ) : (
      result.hunks.map((h) => <Hunk hunk={h} />)
    )}

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
    </p>
  </div>
)
