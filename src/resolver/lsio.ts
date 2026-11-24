import { normaliseSourceUrl } from './labels.ts'
import { HOUR } from './types.ts'
import { userAgent } from '../version.ts'

/** LinuxServer's own API exposes `project_url` -- the real upstream, which the OCI label
 *  never gives (it points at the packaging repo). One request covers every lsio image. */
const LSIO_URL = 'https://api.linuxserver.io/api/v1/images?include_config=false&include_deprecated=false'

const LSIO_TTL_MS = 6 * HOUR

interface LsioProject {
  /** The project URL, when it is a GitHub repository. */
  repo: string | null
  /** The project URL as given, when it is not. */
  home: string | null
}

/** Only a successful fetch is remembered. A failed one used to be, which emptied this tier
 *  for the life of the process after a single outage. */
let lsioMemo: { at: number; projects: Map<string, LsioProject> } | null = null

/** Forget the cached project list (resetResolverMemo, and the tests through it). */
export function resetLsioMemo(): void {
  lsioMemo = null
}

export async function lsioProjects(): Promise<
  { ok: true; projects: Map<string, LsioProject> } | { ok: false; error: string }
> {
  if (lsioMemo && Date.now() - lsioMemo.at < LSIO_TTL_MS) return { ok: true, projects: lsioMemo.projects }
  try {
    const res = await fetch(LSIO_URL, {
      headers: { 'user-agent': userAgent() },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return { ok: false, error: `the LinuxServer API answered ${res.status}` }
    const body = (await res.json()) as {
      data?: { repositories?: Record<string, { name: string; project_url?: string }[]> }
    }
    const projects = new Map<string, LsioProject>()
    for (const list of Object.values(body.data?.repositories ?? {})) {
      for (const img of list) {
        const url = img.project_url?.trim() || null
        const repo = url ? normaliseSourceUrl(url) : null
        projects.set(img.name, { repo, home: repo ? null : url })
      }
    }
    lsioMemo = { at: Date.now(), projects }
    return { ok: true, projects }
  } catch (err) {
    return { ok: false, error: `the LinuxServer API could not be reached (${(err as Error).message})` }
  }
}
