import type { FC } from 'hono/jsx'
import { mergeLabel, type MergeGate } from '../../gitops/merge-gate.ts'
import type { DiffResult, DiffHunk } from '../../diff.ts'
import type { RefLinks } from '../../links.ts'

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

export const DiffView: FC<{
  result: DiffResult
  links?: RefLinks
  prUrl?: string | null
  prNumber?: number | null
  prScope?: string | null
  proposal?: ProposalSummary
  canPropose?: boolean
}> = ({ result, links, prUrl, prNumber, prScope, proposal, canPropose }) => (
  <>
    {'error' in result ? (
      <p class="diff-note">{result.error}</p>
    ) : (
      result.hunks.map((h) => (
        <div class="diff">
          <div class="diff-head">
            <span class="diff-file">{h.file}</span>
            <span class="diff-hunk">{h.header}</span>
          </div>
          {h.lines.map((l) => (
            <div class={`dl ${l.kind}`}>
              <span class="ln">{l.no ?? ''}</span>
              <span class="sign">{MARK[l.kind]}</span>
              <span class="txt">{l.text}</span>
            </div>
          ))}
        </div>
      ))
    )}

    {proposal ? (
      <div class={`proposal${proposal.error ? ' failed' : ''}`}>
        <strong>
          {proposal.error
            ? 'Config changes drafted but not applied'
            : proposal.changed.length > 0
              ? 'Config changes drafted'
              : 'No config change needed'}
        </strong>
        {proposal.error ? <p class="diff-note warn-text">{proposal.error}</p> : null}
        <p class="diff-note">{proposal.summary}</p>
        {proposal.changed.length > 0 && (
          <ul class="oplist">
            {proposal.changed.map((c) => (
              <li>{c}</li>
            ))}
          </ul>
        )}
        {/* The change itself, not just a description of it. */}
        {proposal.hunks.map((h) => (
          <div class="diff">
            <div class="diff-head">
              <span class="diff-file">{h.file}</span>
              <span class="diff-hunk">{h.header}</span>
            </div>
            {h.lines.map((l) => (
              <div class={`dl ${l.kind}`}>
                <span class="ln">{l.no ?? ''}</span>
                <span class="sign">{MARK[l.kind]}</span>
                <span class="txt">{l.text}</span>
              </div>
            ))}
          </div>
        ))}
        {proposal.notes.length > 0 && (
          <>
            <strong>Manual steps</strong>
            <ul class="oplist notes">
              {proposal.notes.map((n) => (
                <li>{n}</li>
              ))}
            </ul>
          </>
        )}
        <p class="diff-note">
          Drafted by <code>{proposal.model}</code>. Nothing has verified these; read the
          commit before merging.
        </p>
      </div>
    ) : canPropose && prNumber ? (
      <p class="diff-note">
        <button
          class="linkish"
          hx-post={`/prs/${prNumber}/propose`}
          hx-swap="outerHTML"
          hx-disabled-elt="this"
        >
          Draft config changes for this update
        </button>
      </p>
    ) : null}

    {prScope === 'modified' && prUrl ? (
      <p class="diff-note warn-text">
        This branch has been edited since shipshape wrote it &mdash; the preview above is
        no longer the whole change.{' '}
        <a class="ext" href={`${prUrl}/files`} target="_blank" rel="noopener">
          See the pull request&rsquo;s own diff &#8599;
        </a>
      </p>
    ) : null}

    {/* Everything you might want to check before merging, one click away. */}
    <p class="diff-links">
      {links?.image && (
        <a class="ext" href={links.image} target="_blank" rel="noopener">
          image &#8599;
        </a>
      )}
      {links?.tag && (
        <a class="ext" href={links.tag} target="_blank" rel="noopener">
          new tag &#8599;
        </a>
      )}
      {links?.releases && (
        <a class="ext" href={links.releases} target="_blank" rel="noopener">
          releases &#8599;
        </a>
      )}
      {links?.source && (
        <a class="ext" href={links.source} target="_blank" rel="noopener">
          project &#8599;
        </a>
      )}
      {/* How the *image* is configured, which the project's own README rarely covers. */}
      {links?.docs && (
        <a class="ext" href={links.docs} target="_blank" rel="noopener">
          image docs &#8599;
        </a>
      )}
      {prUrl && prNumber ? (
        <a class="ext" href={prUrl} target="_blank" rel="noopener">
          pull request #{prNumber} &#8599;
        </a>
      ) : null}
    </p>
  </>
)

export interface DetailRow {
  stack: string
  service: string
  from_tag: string
  to_tag: string
  magnitude: string
  tier: string
  state: string
  recommendation: string | null
  confidence: string | null
  pr_number: number | null
  pr_scope: string | null
}

const MAG: Record<string, string> = { major: 'err', minor: 'warn', patch: 'muted', digest: 'muted' }
const VERDICT_CLS: Record<string, string> = { approve: 'ok', caution: 'warn', block: 'err' }

/** Digest refs are unreadable at full length; keep the tag and 12 hex. */
const short = (r: string) => {
  const at = r.indexOf('@sha256:')
  return at === -1 ? r : `${r.slice(0, at)}@${r.slice(at + 8, at + 20)}`
}

/**
 * What the drawer shows.
 *
 * The diff used to live inside the table row, so the row itself said which service and
 * which versions you were looking at. In a panel that context has to travel with it --
 * without this header the drawer is a diff with no subject.
 */
export const DetailPanel: FC<{
  row: DetailRow
  repo: string
  diff: string
  /** Absent when there is nothing to merge -- no open pull request, or no token. */
  gate?: MergeGate | null
}> = ({ row, repo, diff, gate }) => (
  <>
    <div class="detail-head">
      <div class="detail-service">
        <span class="svc-stack">{row.stack}</span>
        <span class="svc-name">{row.service}</span>
      </div>
      <div class="mono detail-versions">
        {short(row.from_tag)} <span class="sub">&rarr;</span> {short(row.to_tag)}
      </div>
      <div class="detail-pills">
        <span class={`pill ${MAG[row.magnitude] ?? 'muted'}`}>{row.magnitude}</span>
        <span class="pill muted">{row.tier}</span>
        {row.recommendation && VERDICT_CLS[row.recommendation] ? (
          <span class={`pill ${VERDICT_CLS[row.recommendation]}`}>
            {row.recommendation}
            {row.confidence ? ` · ${row.confidence}` : ''}
          </span>
        ) : null}
        {row.pr_number ? (
          <a
            class="ext"
            href={`https://github.com/${repo}/pull/${row.pr_number}`}
            target="_blank"
            rel="noopener"
          >
            #{row.pr_number} &#8599;
          </a>
        ) : null}
      </div>
    </div>
    {/* Already-rendered HTML from the shared builder; raw because it is ours. */}
    <div dangerouslySetInnerHTML={{ __html: diff }} />
    {gate && row.pr_number ? <MergeBar number={row.pr_number} gate={gate} /> : null}
  </>
)

/**
 * The merge button, at the bottom of the drawer.
 *
 * Deliberately the last thing in a scrolling panel rather than a control in the sticky
 * header. Reaching it means having opened one specific update and scrolled past the
 * hunks, past any drafted changes, and past the row of links whose own comment reads
 * "everything you might want to check before merging". That distance is the confirmation
 * step; a dialog repeating generic text would be a weaker one, and would be the only
 * such dialog in the application.
 *
 * A tag-only bump is a one-line diff, so the button is on screen without scrolling. A
 * pull request carrying drafted or edited changes pushes it below the fold -- which is
 * the right way round.
 */
export const MergeBar: FC<{ number: number; gate: MergeGate }> = ({ number, gate }) => (
  <div class="mergebar" id={`mergebar-${number}`}>
    {gate.blocked ? (
      <p class="diff-note warn-text">{gate.blocked}</p>
    ) : (
      <>
        {gate.warnings.map((w) => (
          <p class="diff-note warn-text">{w}</p>
        ))}
        <button
          class="btn btn-primary"
          hx-post={`/prs/${number}/merge${gate.needsForce ? '?force=1' : ''}`}
          hx-target={`#mergebar-${number}`}
          hx-swap="outerHTML"
          hx-disabled-elt="this"
        >
          {mergeLabel(number, gate)}
        </button>
        <span class="sub">
          {gate.needsForce
            ? 'the check above will not stop this'
            : 'merging squashes it into main; the deploy follows whatever Deploys is set to'}
        </span>
      </>
    )}
  </div>
)
