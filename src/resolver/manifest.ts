import { registryFetch } from '../registry/http.ts'
import { normaliseSourceUrl } from './labels.ts'

/** The annotation keys worth reading, in preference order. */
const SOURCE_KEYS = ['org.opencontainers.image.source', 'org.label-schema.vcs-url']


const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(',')


export interface ManifestSources {
  /** From a manifest annotation, which an image cannot inherit. */
  annotation: string | null
  /** From the config's labels, which it can. */
  label: { repo: string; labels: Record<string, string> } | null
}


/** Walk the manifest for a source without pulling the image. It hides in four distinct
 *  places and real images use every one of them. */
export async function walkManifest(registry: string, repository: string, tag: string): Promise<ManifestSources> {
  const host = registry === 'docker.io' ? 'registry-1.docker.io' : registry
  const base = `https://${host}/v2/${repository}`
  const nothing: ManifestSources = { annotation: null, label: null }

  const read = (obj: Record<string, string> | undefined): string | null => {
    if (!obj) return null
    for (const k of SOURCE_KEYS) {
      const v = obj[k]
      if (v) {
        const norm = normaliseSourceUrl(v)
        if (norm) return norm
      }
    }
    return null
  }

  const get = async (url: string, accept?: string): Promise<Response | null> => {
    const res = await registryFetch(url, { accept, billed: true })
    if (res.ok) return res
    // Absent, or not ours to read: nothing to find. Anything else is a failure to look.
    if (res.status === 404 || res.status === 401 || res.status === 403) return null
    throw new Error(`${host} answered ${res.status} while reading ${repository}:${tag}`)
  }

  const res = await get(`${base}/manifests/${tag}`, ACCEPT)
  if (!res) return nothing
  const doc = (await res.json()) as {
    annotations?: Record<string, string>
    manifests?: { digest: string; annotations?: Record<string, string>; platform?: { architecture?: string; os?: string } }[]
    config?: { digest?: string }
  }

  // 1. index-level annotations (immich)
  const atIndex = read(doc.annotations)
  if (atIndex) return { annotation: atIndex, label: null }

  let manifest = doc
  if (doc.manifests?.length) {
    // 2. descriptor-level annotations -- where every Docker Official Image puts it
    for (const d of doc.manifests) {
      const atDesc = read(d.annotations)
      if (atDesc) return { annotation: atDesc, label: null }
    }
    // Recurse into the amd64 child (this host is amd64).
    const child =
      doc.manifests.find((m) => m.platform?.architecture === 'amd64' && m.platform.os === 'linux') ??
      doc.manifests[0]!
    const cres = await get(`${base}/manifests/${child.digest}`, ACCEPT)
    if (!cres) return nothing
    manifest = (await cres.json()) as typeof doc
  }

  // 3. manifest-level annotations (authelia)
  const atManifest = read(manifest.annotations)
  if (atManifest) return { annotation: atManifest, label: null }

  // 4. config blob labels -- the majority case, and the one an image can inherit
  const cfgDigest = manifest.config?.digest
  if (!cfgDigest) return nothing
  const blob = await get(`${base}/blobs/${cfgDigest}`)
  if (!blob) return nothing
  const cfg = (await blob.json()) as { config?: { Labels?: Record<string, string> } }
  const labels = cfg.config?.Labels ?? {}
  const repo = read(labels)
  return { annotation: null, label: repo ? { repo, labels } : null }
}
