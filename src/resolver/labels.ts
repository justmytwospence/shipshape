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

export type ParsedSource = { ok: true; repo: string } | { ok: false; reason: string }

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
