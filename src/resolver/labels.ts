/**
 * What counts as a GitHub repository, from an operator or from an image.
 *
 * `shipshape.source` accepted only full GitHub URLs, and anything else -- a bare
 * `owner/repo`, a GitLab link, a typo -- fell through to the resolver without a word, so a
 * label that looked right could be doing nothing. Now a label either parses or says why
 * not.
 *
 * Image annotations get the same grammar minus the bare form: an OCI source value is meant
 * to be a URL, and `foo/bar` inside an image is not evidence of a GitHub repository. The
 * host must be github.com itself -- the old pattern also matched `api.github.com/repos/O/R`
 * and produced `repos/O`.
 */

import { checkUrl } from '../upstream/hosts.ts'
import { getDb } from '../db/index.ts'
import type { ImageKey, SourceOpts, ChangelogLabelInfo, InvalidLabel, ServiceKey, SourceLabelInfo } from './types.ts'

export type ParsedSource = { ok: true; repo: string } | { ok: false; reason: string }

export type ChangelogTarget = { kind: 'url'; url: string } | { kind: 'path'; path: string }
export type ParsedChangelog = ({ ok: true } & ChangelogTarget) | { ok: false; reason: string }

/**
 * An operator's `shipshape.changelog` value: where this image's release notes are when the
 * upstream repository's GitHub releases do not have them. An https link on a public host --
 * a vendor's release-notes page, a file on another forge -- or a path to a file or directory
 * in the upstream repository.
 */
export function parseChangelogLabel(raw: string | null | undefined): ParsedChangelog {
  const value = (raw ?? '').trim()
  if (!value) return { ok: false, reason: 'it is empty' }
  if (value.length > 500) return { ok: false, reason: 'it is longer than 500 characters' }
  if (value.includes('$')) return { ok: false, reason: 'it contains "$", which compose would interpolate' }
  if (/\s/.test(value)) return { ok: false, reason: 'it contains whitespace' }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    const checked = checkUrl(value)
    return checked.ok ? { ok: true, kind: 'url', url: value } : { ok: false, reason: checked.reason }
  }
  const path = value.replace(/^\.\//, '').replace(/\/+$/, '')
  if (
    value.startsWith('/') ||
    !/^[A-Za-z0-9._\-/]{1,200}$/.test(path) ||
    path.split('/').some((s) => s === '' || s === '..')
  ) {
    return { ok: false, reason: 'write an https:// link, or a path inside the repository such as CHANGELOG.md' }
  }
  return { ok: true, kind: 'path', path }
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO = /^[A-Za-z0-9._-]{1,100}$/

/** An operator's `shipshape.source` value. Accepts `owner/repo` as well as URLs. */
export function parseSourceLabel(raw: string | null | undefined): ParsedSource {
  return parse(raw, { allowBare: true })
}

/** An image's OCI source annotation, down to `owner/repo`, or null. */
export function normaliseSourceUrl(raw: string): string | null {
  const r = parse(raw, { allowBare: false })
  return r.ok ? r.repo : null
}

function parse(raw: string | null | undefined, o: { allowBare: boolean }): ParsedSource {
  const value = (raw ?? '').trim()
  if (!value) return { ok: false, reason: 'it is empty' }
  if (value.includes('$')) return { ok: false, reason: 'it contains "$", which compose would interpolate' }

  const s = value.replace(/^git\+/i, '')
  const scp = /^git@github\.com:([^/\s]+)\/([^/\s]+)$/i.exec(s)
  // Anchored at the start, so api.github.com, gist.github.com and lookalike hosts never match.
  const url = /^(?:(?:https?|ssh|git):\/\/(?:git@)?)?(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+)/i.exec(s)
  const bare = /^([^/\s:@.]+)\/([^/\s:@?#]+)$/.exec(s)

  let owner: string
  let repo: string
  if (scp) [owner, repo] = [scp[1]!, scp[2]!]
  else if (url) [owner, repo] = [url[1]!, url[2]!]
  else if (o.allowBare && bare) [owner, repo] = [bare[1]!, bare[2]!]
  else return { ok: false, reason: 'it is not a GitHub repository -- write owner/repo or a github.com URL' }

  repo = repo.replace(/\.git$/i, '')
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') {
    return { ok: false, reason: `"${owner}/${repo}" is not a valid GitHub repository name` }
  }
  return { ok: true, repo: `${owner}/${repo}` }
}

export interface LabelRow {
  stack: string
  service: string
  source_label: string | null
  changelog_label: string | null
}

export function readLabels(image: ImageKey): LabelRow[] {
  return getDb()
    .prepare(
      `SELECT stack, service, source_label, changelog_label FROM images
       WHERE registry = ? AND repository = ?
         AND ((source_label IS NOT NULL AND source_label != '')
           OR (changelog_label IS NOT NULL AND changelog_label != ''))
       ORDER BY stack, service`,
    )
    .all(image.registry, image.repository) as LabelRow[]
}

/**
 * The notes link that applies: the service's own, else the first valid one on another service
 * running the image. Unlike a repository, two links are not a disagreement worth reporting --
 * a vendor page and a changelog file can both be right.
 */
export function pickChangelog(
  rows: LabelRow[],
  opts: SourceOpts,
): { changelog: ChangelogLabelInfo | null; invalidChangelog: InvalidLabel | null } {
  const me = opts.service
  const ownRaw = me
    ? opts.ownChangelog !== undefined
      ? opts.ownChangelog
      : (rows.find((r) => sameService(me, r))?.changelog_label ?? null)
    : null
  let invalidChangelog: InvalidLabel | null = null
  if (me && ownRaw?.trim()) {
    const p = parseChangelogLabel(ownRaw)
    if (p.ok) return { changelog: { value: ownRaw.trim(), from: me, target: targetOf(p) }, invalidChangelog: null }
    invalidChangelog = { from: me, value: ownRaw.trim(), reason: p.reason }
  }
  for (const r of rows) {
    if (sameService(me, r) || !r.changelog_label?.trim()) continue
    const p = parseChangelogLabel(r.changelog_label)
    if (p.ok) {
      return {
        changelog: {
          value: r.changelog_label.trim(),
          from: { stack: r.stack, service: r.service },
          target: targetOf(p),
        },
        invalidChangelog,
      }
    }
  }
  return { changelog: null, invalidChangelog }
}

const targetOf = (p: ChangelogTarget): ChangelogTarget =>
  p.kind === 'url' ? { kind: 'url', url: p.url } : { kind: 'path', path: p.path }

export const sameService = (a: ServiceKey | undefined, b: ServiceKey): boolean =>
  !!a && a.stack === b.stack && a.service === b.service

export const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

export function pickLabel(
  rows: LabelRow[],
  opts: SourceOpts,
): { label: SourceLabelInfo | null; invalidLabel: InvalidLabel | null } {
  const me = opts.service
  const ownRaw = me
    ? opts.ownLabel !== undefined
      ? opts.ownLabel
      : (rows.find((r) => sameService(me, r))?.source_label ?? null)
    : null

  let own: { from: ServiceKey; value: string; repo: string } | null = null
  let invalidLabel: InvalidLabel | null = null
  if (me && ownRaw && ownRaw.trim()) {
    const p = parseSourceLabel(ownRaw)
    if (p.ok) own = { from: me, value: ownRaw.trim(), repo: p.repo }
    else invalidLabel = { from: me, value: ownRaw.trim(), reason: p.reason }
  }

  // Siblings in (stack, service) order, so a disagreement always settles the same way.
  const siblings: { from: ServiceKey; value: string; repo: string }[] = []
  for (const r of rows) {
    if (sameService(me, r) || !r.source_label?.trim()) continue
    const p = parseSourceLabel(r.source_label)
    if (p.ok)
      siblings.push({ from: { stack: r.stack, service: r.service }, value: r.source_label.trim(), repo: p.repo })
  }

  const chosen = own ?? siblings[0] ?? null
  if (!chosen) return { label: null, invalidLabel }
  const others = own ? siblings : siblings.slice(1)
  return {
    label: {
      ...chosen,
      conflicts: others.filter((o) => !sameRepo(o.repo, chosen.repo)).map((o) => ({ ...o.from, value: o.value })),
    },
    invalidLabel,
  }
}
