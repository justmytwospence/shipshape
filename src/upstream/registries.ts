import { pace } from '../registry/http.ts'

/**
 * What a registry says about an image in prose.
 *
 * A project that does not annotate its image very often links its repository from the
 * image's page instead: minuspod's Docker Hub overview links ttlequals0/MinusPod, and the
 * GitLab project that packages signal-cli names AsamK/signal-cli in its description. None of
 * these reads is billed against the Docker Hub pull budget.
 *
 * A registry that has nothing to say -- no page, a private one, or no API for it at all, as
 * with ghcr.io -- answers with no text. Only an outage or a rate limit is a failure.
 */

export type Description =
  | { ok: true; text: string | null; where: string | null }
  | { ok: false; error: string }

export async function registryDescription(image: { registry: string; repository: string }): Promise<Description> {
  switch (image.registry) {
    case 'docker.io':
      return dockerHub(image.repository)
    case 'quay.io':
      return quay(image.repository)
    case 'registry.gitlab.com':
      return gitlab(image.repository)
    default:
      return { ok: true, text: null, where: null }
  }
}

async function dockerHub(repository: string): Promise<Description> {
  const r = await getJson(`https://hub.docker.com/v2/repositories/${repository}/`, 'Docker Hub')
  if (!r.ok) return r
  const b = r.body as { description?: string | null; full_description?: string | null } | null
  return { ok: true, text: joined(b?.description, b?.full_description), where: 'Docker Hub' }
}

async function quay(repository: string): Promise<Description> {
  const r = await getJson(`https://quay.io/api/v1/repository/${repository}`, 'Quay')
  if (!r.ok) return r
  const b = r.body as { description?: string | null } | null
  return { ok: true, text: joined(b?.description), where: 'Quay' }
}

/** A GitLab image lives under its project's path, sometimes with a further image name, so
 *  the project is the longest prefix GitLab recognises. */
async function gitlab(repository: string): Promise<Description> {
  const segs = repository.split('/')
  for (let i = segs.length; i >= 2; i--) {
    const path = segs.slice(0, i).join('/')
    const r = await getJson(`https://gitlab.com/api/v4/projects/${encodeURIComponent(path)}`, 'GitLab')
    if (!r.ok) return r
    if (r.body) {
      const b = r.body as { description?: string | null }
      return { ok: true, text: joined(b.description), where: 'GitLab' }
    }
  }
  return { ok: true, text: null, where: 'GitLab' }
}

const joined = (...parts: (string | null | undefined)[]): string | null =>
  parts.filter((p): p is string => !!p && !!p.trim()).join('\n\n') || null

async function getJson(
  url: string,
  who: string,
): Promise<{ ok: true; body: unknown | null } | { ok: false; error: string }> {
  let res: Response
  try {
    await pace(new URL(url).host)
    res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'shipshape/0.1' },
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    return { ok: false, error: `${who} could not be reached (${(err as Error).message})` }
  }
  // No page, or not one anybody may read: nothing to say, which is an answer.
  if (res.status === 404 || res.status === 401 || res.status === 403) return { ok: true, body: null }
  if (!res.ok) return { ok: false, error: `${who} answered ${res.status}` }
  try {
    return { ok: true, body: await res.json() }
  } catch (err) {
    return { ok: false, error: `${who} sent an unreadable response (${(err as Error).message})` }
  }
}
