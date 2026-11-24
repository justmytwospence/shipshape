import { env } from '../env.ts'
import { fetchJson, registryFetch, RegistryError } from './http.ts'

/** The repository publishes too many tags to enumerate safely. Callers should fall back
 *  to release-driven probing rather than treating this as a hard failure. */
export class TagListTooLarge extends RegistryError {}

/** The repository does not exist in the registry -- typically a locally-built image
 *  (`mcpjungle-local:stdio`) that was never published anywhere. */
export class RepositoryNotFound extends RegistryError {}

/**
 * Tag listing across registries.
 *
 * Two API families, deliberately not conflated:
 *   - the OCI distribution API (`/v2/<repo>/tags/list`) -- universal, tag names only,
 *     roughly alphabetical, paginated via the `Link` header;
 *   - vendor APIs -- richer (timestamps, digests) but registry-specific.
 *
 * Docker Hub gets the vendor path because it is the only registry that hands back real
 * publish timestamps, and because its `/v2/` surface shares the billed pull budget.
 * Everything else -- ghcr, lscr, quay, gcr, gitlab, codeberg -- goes through the generic
 * OCI client, which follows the `WWW-Authenticate` challenge and so needs no
 * per-registry special-casing.
 */

export interface TagInfo {
  tag: string
  digest?: string | null
  publishedAt?: string | null
}

export async function listTags(registry: string, repository: string): Promise<TagInfo[]> {
  if (registry === 'docker.io') return listDockerHubTags(repository)
  // lscr.io is a redirector in front of ghcr.io and inherits its oldest-first ordering,
  // so paging it is both slow and prone to truncating before the current release.
  // LinuxServer publishes the identical images to Docker Hub, which pages newest-first
  // and carries timestamps -- so query there and leave the compose reference untouched.
  if (registry === 'lscr.io' && repository.startsWith('linuxserver/')) {
    return listDockerHubTags(repository)
  }
  if (registry === 'quay.io') return listQuayTags(repository)
  return listOciTags(registry, repository)
}

// ------------------------------------------------------------------ Docker Hub

interface HubTagsPage {
  next: string | null
  results: {
    name: string
    digest?: string | null
    last_updated?: string | null
    tag_status?: string
  }[]
}

async function listDockerHubTags(repository: string): Promise<TagInfo[]> {
  // Official images live under the `library` namespace; parseImageRef already
  // normalised `postgres` to `library/postgres`.
  const out: TagInfo[] = []
  let url =
    `https://hub.docker.com/v2/repositories/${repository}/tags` +
    `?page_size=100&ordering=last_updated`

  // Newest-first ordering means the first pages hold everything that matters. Cap the
  // walk: images like `library/postgres` carry 1000+ tags and there is no reason to
  // page through years of history to find a bump.
  for (let page = 0; page < 5 && url; page++) {
    let body: HubTagsPage
    try {
      body = await fetchJson<HubTagsPage>(url, { cacheKey: url })
    } catch (err) {
      if (err instanceof RegistryError && err.status === 404) {
        throw new RepositoryNotFound(`repository not found on Docker Hub: ${repository}`, 404)
      }
      throw err
    }
    for (const r of body.results ?? []) {
      if (r.tag_status && r.tag_status !== 'active') continue
      out.push({ tag: r.name, digest: r.digest ?? null, publishedAt: r.last_updated ?? null })
    }
    if (body.next && new URL(body.next).host !== 'hub.docker.com') {
      throw new RegistryError(`Docker Hub pointed its tag list at ${new URL(body.next).host}; refusing to follow`)
    }
    url = body.next ?? ''
  }
  return out
}

// ------------------------------------------------------------------ quay.io

interface QuayTagsPage {
  tags: { name: string; manifest_digest?: string; last_modified?: string; end_ts?: number }[]
  has_additional?: boolean
}

async function listQuayTags(repository: string): Promise<TagInfo[]> {
  const out: TagInfo[] = []
  // Quay's ordering is not date-descending either, so page generously.
  for (let page = 1; page <= 40; page++) {
    const url =
      `https://quay.io/api/v1/repository/${repository}/tag/` +
      `?limit=100&onlyActiveTags=true&page=${page}`
    let body: QuayTagsPage
    try {
      body = await fetchJson<QuayTagsPage>(url, { cacheKey: url })
    } catch {
      // Quay's vendor API is flaky enough that Renovate swallows its errors outright;
      // fall back to the universal path rather than losing the image.
      return listOciTags('quay.io', repository)
    }
    for (const t of body.tags ?? []) {
      out.push({ tag: t.name, digest: t.manifest_digest ?? null, publishedAt: t.last_modified ?? null })
    }
    if (!body.has_additional) break
  }
  return out
}

// ------------------------------------------------------------------ generic OCI

interface OciTagList {
  name: string
  tags: string[] | null
}

/**
 * Pages of 100. ghcr/gcr/gitlab return tags OLDEST first, so the newest release sits on
 * the LAST page -- truncating the walk does not merely lose history, it loses the very
 * tag being looked for and reports "up to date". A truncated list is therefore never
 * returned: the walk either completes or raises TagListTooLarge, and the caller falls
 * back to release-driven probing (see probe.ts).
 *
 * Measured across one real deployment: the median ghcr repo is 3 pages. The outliers are
 * hopeless rather than merely slow -- immich-machine-learning is past 148,000 tags and
 * still paginating after 3 minutes, openhands ~70,000 -- because they tag every commit
 * and PR. So the cap is set low enough to bail out quickly and hand over to the probe,
 * rather than high enough to grind through them.
 */
const OCI_MAX_PAGES = 60

async function listOciTags(registry: string, repository: string): Promise<TagInfo[]> {
  const tags: string[] = []
  let url = `https://${registry}/v2/${repository}/tags/list?n=100`
  let page = 0

  for (; page < OCI_MAX_PAGES && url; page++) {
    const res = await registryFetch(url, {
      accept: 'application/json',
      auth: authFor(registry),
      cacheKey: url,
    })
    if (!res.ok) {
      if (res.status === 404) throw new RepositoryNotFound(`repository not found: ${repository}`, 404)
      throw new RegistryError(`${res.status} listing tags for ${repository}`, res.status)
    }
    const body = (await res.json()) as OciTagList
    for (const t of body.tags ?? []) tags.push(t)

    const link = res.headers.get('link')
    const next = link ? /<([^>]+)>\s*;\s*rel="?next"?/.exec(link)?.[1] : null
    if (next) {
      const nextUrl = new URL(next, url)
      if (nextUrl.host !== new URL(url).host) {
        throw new RegistryError(`${registry} pointed its tag list at ${nextUrl.host}; refusing to follow`)
      }
      url = nextUrl.toString()
    } else {
      url = ''
    }
  }

  if (url) {
    // Still more pages when the cap ran out. Refusing is the only safe answer: the
    // newest tags live at the end of an oldest-first list, so a partial result here
    // would confidently report that a stale image is current.
    throw new TagListTooLarge(
      `tag list for ${registry}/${repository} exceeds ${OCI_MAX_PAGES} pages`,
    )
  }

  return tags.map((tag) => ({ tag }))
}

function authFor(registry: string): { username: string; password: string } | null {
  if (registry === 'docker.io' && env.dockerHubLogin) {
    return { username: env.dockerHubLogin, password: env.dockerHubPassword }
  }
  return null
}

/**
 * Current digest for a tag, used to detect movement on rolling tags (`latest`, `stable`)
 * and on digest-pinned images where there is no version to compare.
 *
 * HEAD, not GET: Docker Hub bills manifest GETs as pulls but explicitly does not bill
 * HEAD. The digest comes back in `Docker-Content-Digest` either way.
 */
export async function headDigest(registry: string, repository: string, tag: string): Promise<string | null> {
  const host = registry === 'docker.io' ? 'registry-1.docker.io' : registry
  const res = await registryFetch(`https://${host}/v2/${repository}/manifests/${tag}`, {
    method: 'HEAD',
    accept: [
      'application/vnd.oci.image.index.v1+json',
      'application/vnd.docker.distribution.manifest.list.v2+json',
      'application/vnd.oci.image.manifest.v1+json',
      'application/vnd.docker.distribution.manifest.v2+json',
    ].join(','),
    auth: authFor(registry),
  })
  if (!res.ok) return null
  return res.headers.get('docker-content-digest')
}
