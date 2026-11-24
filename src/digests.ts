import type { ScannedService } from './compose/scan.ts'
import { getDb } from './db/index.ts'
import { headDigest } from './registry/index.ts'
import { registryFetch } from './registry/http.ts'

/**
 * Digest watching, for the images where a tag comparison means nothing.
 *
 * Two populations, with different notions of "baseline":
 *   - ROLLING tags (`latest`, `stable`, `apache`): nothing in git ever changes, so the
 *     baseline is DB state and movement is only ever a signal to redeploy.
 *   - DIGEST-PINNED refs (`valkey:9@sha256:...`): the compose file itself carries the
 *     digest, so git IS the baseline and movement is a PR-able change.
 */

export type DigestCheck =
  /** First sight. Baseline recorded, deliberately no event -- the first scan bootstraps
   *  ~21 of these at once and 21 notifications would be noise, not information. */
  | { status: 'bootstrapped'; digest: string }
  | { status: 'unchanged' }
  | { status: 'moved-rolling'; from: string; to: string }
  | { status: 'moved-pinned'; from: string; to: string }
  /** The pin names an architecture-specific child of the tag's current index. Not
   *  movement -- without this check every scan would report phantom movement forever. */
  | { status: 'pinned-to-child'; index: string }
  | { status: 'head-failed'; detail: string }

const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(',')

export async function checkDigest(svc: ScannedService): Promise<DigestCheck> {
  const ref = svc.ref
  if (!ref) return { status: 'head-failed', detail: 'no image reference' }

  const tag = ref.tag ?? 'latest'
  let head: string | null
  try {
    head = await headDigest(ref.registry, ref.repository, tag)
  } catch (err) {
    return { status: 'head-failed', detail: (err as Error).message }
  }
  if (!head) return { status: 'head-failed', detail: 'registry returned no content digest' }

  return ref.digest
    ? checkPinned(ref.registry, ref.repository, ref.digest, head)
    : checkRolling(ref.registry, ref.repository, tag, head)
}

/** Git holds the baseline: compare the digest written in the compose file against what
 *  the tag resolves to now. */
async function checkPinned(registry: string, repository: string, pinned: string, head: string): Promise<DigestCheck> {
  if (pinned === head) return { status: 'unchanged' }

  // HEAD of a multi-arch tag returns the INDEX digest. Most pins in this repo are also
  // index digests, so the comparison is like-for-like -- but an operator who pinned from
  // `docker inspect` on a pulled image may have recorded an arch-specific child instead.
  // Look inside the current index before calling this movement.
  try {
    const host = registry === 'docker.io' ? 'registry-1.docker.io' : registry
    // Content-addressed, therefore immutable: cache it forever.
    const res = await registryFetch(`https://${host}/v2/${repository}/manifests/${head}`, {
      accept: ACCEPT,
      billed: true,
      cacheKey: `index:${registry}/${repository}@${head}`,
    })
    if (res.ok) {
      const doc = (await res.json()) as { manifests?: { digest: string }[] }
      if (doc.manifests?.some((m) => m.digest === pinned)) {
        return { status: 'pinned-to-child', index: head }
      }
    }
  } catch {
    // If the index cannot be read, fall through and report movement. A false positive
    // here costs a PR that a human will read; a false negative hides a real change.
  }

  return { status: 'moved-pinned', from: pinned, to: head }
}

/** No git baseline exists, so the DB holds one. It advances the moment movement is
 *  acknowledged, which is what makes the event fire exactly once per move. */
function checkRolling(registry: string, repository: string, tag: string, head: string): DigestCheck {
  const db = getDb()
  const now = new Date().toISOString()
  const row = db
    .prepare(`SELECT digest FROM digest_baselines WHERE registry = ? AND repository = ? AND tag = ?`)
    .get(registry, repository, tag) as { digest: string } | undefined

  if (!row) {
    db.prepare(
      `INSERT INTO digest_baselines (registry, repository, tag, digest, observed_at, checked_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(registry, repository, tag, head, now, now)
    return { status: 'bootstrapped', digest: head }
  }

  if (row.digest === head) {
    db.prepare(
      `UPDATE digest_baselines SET checked_at = ?
       WHERE registry = ? AND repository = ? AND tag = ?`,
    ).run(now, registry, repository, tag)
    return { status: 'unchanged' }
  }

  db.prepare(
    `UPDATE digest_baselines SET digest = ?, observed_at = ?, checked_at = ?
     WHERE registry = ? AND repository = ? AND tag = ?`,
  ).run(head, now, now, registry, repository, tag)
  return { status: 'moved-rolling', from: row.digest, to: head }
}

/** Short form for logs and UI: sha256:abcdef123456 -> abcdef123456. */
export function shortDigest(d: string): string {
  return d.startsWith('sha256:') ? d.slice(7, 19) : d.slice(0, 12)
}
