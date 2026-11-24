import type { ImageRef } from './images/ref.ts'

/**
 * Outbound links for an image reference.
 *
 * Every registry answers "where does this image live" differently, and several answer
 * "where does this exact tag live" with nothing usable at all. Rather than guess a
 * per-tag URL that 404s, each registry gets the closest thing it actually serves --
 * usually a tag-filtered list -- and anything unknown returns null so the UI simply
 * renders text.
 */

export interface RefLinks {
  /** The image's page on its registry. */
  image: string | null
  /** As close to this specific tag as the registry will take us. */
  tag: string | null
  /** The upstream project, once resolved. */
  source: string | null
  /** Upstream releases, filtered near this tag. */
  releases: string | null
  /**
   * Documentation of the *image* -- the environment variables, volumes and ports you
   * actually configure -- as opposed to the project's own docs, which `source` covers.
   *
   * Only emitted where a publisher has a known, stable, derivable URL for it: LinuxServer
   * (a page per image) and Docker Official Images (the Hub overview, which for those is a
   * genuine hand-written document rather than a tag list). Nothing else is guessed; for
   * most images the source repo README is the documentation and `source` already points
   * at it.
   */
  docs: string | null
}

/** What to call a registry in a link. Unknown hosts are named by their hostname. */
export function registryName(registry: string): string {
  switch (registry) {
    case 'docker.io':
      return 'Docker Hub'
    case 'ghcr.io':
      return 'GitHub Packages'
    case 'lscr.io':
      return 'LinuxServer Fleet'
    case 'quay.io':
      return 'Quay'
    case 'registry.gitlab.com':
      return 'GitLab'
    case 'codeberg.org':
      return 'Codeberg'
    default:
      return registry
  }
}

export function refLinks(
  ref: ImageRef,
  tag: string | null,
  sourceRepo: string | null,
): RefLinks {
  // Tag pages are keyed by name; a digest suffix belongs to no tag page anywhere.
  const clean = tag ? (tag.split('@')[0] || null) : null

  const out: RefLinks = {
    image: null,
    tag: null,
    source: sourceRepo ? `https://github.com/${sourceRepo}` : null,
    releases:
      sourceRepo && clean
        ? `https://github.com/${sourceRepo}/releases?q=${encodeURIComponent(clean)}`
        : sourceRepo
          ? `https://github.com/${sourceRepo}/releases`
          : null,
    docs: null,
  }

  const repo = ref.repository
  const name = repo.split('/').pop() ?? repo

  // LinuxServer images reach this from two registries (lscr.io and the Docker Hub
  // mirror), and the docs page is keyed by image name in both cases.
  if (repo.startsWith('linuxserver/')) {
    out.docs = `https://docs.linuxserver.io/images/docker-${name}/`
  }

  switch (ref.registry) {
    case 'docker.io': {
      if (repo.startsWith('library/')) {
        // Official images live under the underscore path, not /r/library/. That page is
        // also the image's documentation -- maintained prose about how to configure it,
        // not a generated tag list -- so it serves as both.
        out.image = `https://hub.docker.com/_/${name}`
        out.docs = out.image
        out.tag = clean ? `${out.image}/tags?name=${encodeURIComponent(clean)}` : null
      } else {
        out.image = `https://hub.docker.com/r/${repo}`
        out.tag = clean ? `${out.image}/tags?name=${encodeURIComponent(clean)}` : null
      }
      break
    }

    case 'lscr.io': {
      // lscr is a redirector; its own host serves no browsable page. Fleet is the
      // canonical index, and the Docker Hub mirror is the only place with a tag list.
      out.image = `https://fleet.linuxserver.io/image?name=${repo}`
      out.tag = clean
        ? `https://hub.docker.com/r/${repo}/tags?name=${encodeURIComponent(clean)}`
        : null
      break
    }

    case 'ghcr.io': {
      const owner = repo.split('/')[0]!
      // Packages are almost always linked to their source repository, which gives a
      // much better page than the org-level package index.
      out.image = sourceRepo
        ? `https://github.com/${sourceRepo}/pkgs/container/${encodeURIComponent(nameForGhcr(repo))}`
        : `https://github.com/orgs/${owner}/packages/container/package/${encodeURIComponent(nameForGhcr(repo))}`
      // ghcr has no per-tag page worth linking; releases carry the real information.
      out.tag = out.releases
      break
    }

    case 'quay.io': {
      out.image = `https://quay.io/repository/${repo}?tab=tags`
      out.tag = clean
        ? `${out.image}&filter_tag_name=like:${encodeURIComponent(clean)}`
        : null
      break
    }

    case 'registry.gitlab.com': {
      out.image = `https://gitlab.com/${repo}/container_registry`
      break
    }

    case 'codeberg.org': {
      const owner = repo.split('/')[0]!
      out.image = `https://codeberg.org/${owner}/-/packages/container/${encodeURIComponent(name)}`
      // Codeberg's package versions are not addressable by tag name -- the obvious
      // `/<tag>` suffix 404s (verified) -- and the image page lists every version
      // anyway, so there is nothing better to point at.
      out.tag = null
      break
    }

    default:
      // An unrecognised registry gets no guessed URL; the source link may still apply.
      break
  }

  return out
}

/**
 * ghcr package names keep their path after the owner, joined by `/`, and GitHub expects
 * that whole remainder as one path-encoded segment -- `scanopy/scanopy/server` is the
 * package `scanopy/server` owned by `scanopy`.
 */
function nameForGhcr(repository: string): string {
  const parts = repository.split('/')
  return parts.slice(1).join('/')
}

/** An outbound link a page may render: http(s), no credentials, at most 2048 characters. Anything else is null. */
export function safeHref(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!s || s.length > 2048) return null
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (u.username || u.password) return null
  return u.toString()
}

/** shipshape's own documentation, linked from the UI, notifications and commit bodies. */
export const DOCS_URL = 'https://justmytwospence.github.io/shipshape/'
export const FORKS_GUIDE_URL = `${DOCS_URL}guides/forks/`
