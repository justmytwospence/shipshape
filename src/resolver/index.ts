import { getDb } from '../db.ts'
import { registryFetch } from '../registry/http.ts'
import { backoffUntil } from '../backoff.ts'
import { normaliseSourceUrl, parseSourceLabel } from './labels.ts'

export { normaliseSourceUrl, parseSourceLabel } from './labels.ts'

/**
 * Image -> upstream source repository, and the one way to ask.
 *
 * Measured across one real deployment's images: only about half carry an OCI annotation
 * pointing at the project that actually writes the release notes. Roughly a quarter point
 * at a *packaging* repo -- `traefik` -> `traefik-library-image`, every LinuxServer image ->
 * `linuxserver/docker-<app>` -- which is technically correct and useless. The rest carry
 * nothing.
 *
 * Two things about the answer used to be wrong, and both are why this module has one
 * accessor now.
 *
 * - **Labels were applied by some callers and not others.** `shipshape.source` short-
 *   circuited only when a caller remembered to pass it, and five of eight did not -- the
 *   changelog review among them -- so a labelled service was reviewed as if its upstream
 *   were unknown. `sourceFor` and `sourceForSync` apply labels themselves, per image: a
 *   label on one service links every service running that image, the requesting service's
 *   own label wins, and disagreements are reported rather than settled silently. Labels
 *   live in git and are never copied into the cache, so changing one needs no invalidation.
 *
 * - **Every answer was cached forever, failures included.** A Docker Hub budget stop, a 429
 *   or a timeout during the manifest walk became a `none` that was returned for good, and a
 *   resolver improvement never reached an image that already had a row. A failure is now
 *   recorded as a failure and retried with backoff; a found repository is kept; a clean
 *   "nothing found" is looked at again after a week; and rows written by an older resolver
 *   are re-resolved.
 *
 * Tiers, cheapest first: the curated map, the LinuxServer API, then the manifest walk, which
 * is billed against the Docker Hub pull budget.
 */

export type ResolutionTier = 'label' | 'override' | 'lsio' | 'annotation' | 'none'
export type SourceConfidence = 'high' | 'medium' | 'low'

export interface ImageKey {
  registry: string
  repository: string
}

export interface ServiceKey {
  stack: string
  service: string
}

export interface SourceLabelInfo {
  value: string
  /** The service whose label this is -- not always the one asking. */
  from: ServiceKey
  repo: string
  /** Other services on the same image whose labels name a different repository. */
  conflicts: (ServiceKey & { value: string })[]
}

export interface InvalidLabel {
  value: string
  from: ServiceKey
  reason: string
}

export interface SourceInfo {
  repo: string | null
  tier: ResolutionTier
  confidence: SourceConfidence | null
  detail: string | null
  /** What the resolver found on its own, underneath any label. Null when never looked up. */
  inferred: { repo: string | null; tier: ResolutionTier; confidence: SourceConfidence | null } | null
  /** A packaging repository: container changes only, never the application's source. */
  packagingRepo: string | null
  label: SourceLabelInfo | null
  /** The requesting service's own label, when it could not be parsed. */
  invalidLabel: InvalidLabel | null
  checkedAt: string | null
  nextCheckAt: string | null
  /** The last lookup's failure, when it failed. */
  error: string | null
  /** No lookup yet, or the last one is due to be repeated. */
  pending: boolean
}

export interface SourceOpts {
  /** The service asking. Its own label wins over a sibling's. */
  service?: ServiceKey
  /**
   * That service's label as the caller just read it from the compose file. Omit to use the
   * last scan's copy; pass null to say it has none.
   */
  ownLabel?: string | null
  /** The tag to walk for annotations. Defaults to the image's current tag. */
  tag?: string | null
  /** Look again even when the cached answer is fresh. */
  force?: boolean
}

/** Bump when tier logic changes, so rows written by the previous logic are looked at again. */
export const RESOLVER_VERSION = 1

const HOUR = 60 * 60_000
const DAY = 24 * HOUR
/** A clean "nothing found" is not forever: an image can gain an annotation. */
const NONE_TTL_MS = 7 * DAY

/**
 * Docker Official Images and a few vendors annotate their *packaging* repo. Mapping
 * those by hand is unavoidable -- there is no metadata anywhere that connects
 * `docker-library/postgres` to `postgres/postgres`.
 */
const OVERRIDES: Record<string, string> = {
  'docker.io/library/postgres': 'postgres/postgres',
  'docker.io/library/redis': 'redis/redis',
  'docker.io/library/mariadb': 'MariaDB/server',
  'docker.io/library/nginx': 'nginx/nginx',
  'docker.io/library/traefik': 'traefik/traefik',
  'docker.io/library/nextcloud': 'nextcloud/server',
  'docker.io/library/influxdb': 'influxdata/influxdb',
  'docker.io/library/monica': 'monicahq/monica',
  'docker.io/library/mongo': 'mongodb/mongo',
  'docker.io/library/node': 'nodejs/node',
  'docker.io/traefik/traefik': 'traefik/traefik',
  // Image name and repo name disagree.
  'docker.io/miniflux/miniflux': 'miniflux/v2',
  'docker.io/n8nio/n8n': 'n8n-io/n8n',
  'docker.io/linkace/linkace': 'Kovah/LinkAce',
  'docker.io/crazymax/fail2ban': 'crazy-max/docker-fail2ban',
  'docker.io/nicolargo/glances': 'nicolargo/glances',
  'docker.io/grafana/grafana': 'grafana/grafana',
  'docker.io/apache/tika': 'apache/tika',
  'docker.io/actualbudget/actual-server': 'actualbudget/actual',
  'docker.io/getwud/wud': 'getwud/wud',
  'docker.io/binwiederhier/ntfy': 'binwiederhier/ntfy',
  'docker.io/henrygd/beszel': 'henrygd/beszel',
  'docker.io/henrygd/beszel-agent': 'henrygd/beszel',
  'docker.io/organizr/organizr': 'causefx/Organizr',
  'docker.io/huginn/huginn-single-process': 'huginn/huginn',
  'docker.io/pihole/pihole': 'pi-hole/docker-pi-hole',
  'docker.io/netdata/netdata': 'netdata/netdata',
  'docker.io/crowdsecurity/crowdsec': 'crowdsecurity/crowdsec',
  'docker.io/getmeili/meilisearch': 'meilisearch/meilisearch',
  'docker.io/gotenberg/gotenberg': 'gotenberg/gotenberg',
  'docker.io/qmcgaw/gluetun': 'qdm12/gluetun',
  'docker.io/prom/prometheus': 'prometheus/prometheus',
  'docker.io/telegraf': 'influxdata/telegraf',
  'docker.io/library/telegraf': 'influxdata/telegraf',
  'docker.io/valkey/valkey': 'valkey-io/valkey',
}

/** The annotation keys worth reading, in preference order. */
const SOURCE_KEYS = ['org.opencontainers.image.source', 'org.label-schema.vcs-url']

const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(',')

// ------------------------------------------------------------------ the accessor

/** The answer from what is already known: cache plus labels, never the network. */
export function sourceForSync(image: ImageKey, opts: SourceOpts = {}): SourceInfo {
  return compose(readLabels(image), readRow(image), opts)
}

/** The same answer, looking the image up first when nothing is cached or the row is due. */
export async function sourceFor(image: ImageKey, opts: SourceOpts = {}): Promise<SourceInfo> {
  const labels = readLabels(image)
  let row = readRow(image)
  // A label answers the question by itself. Looking the image up anyway would spend Docker
  // Hub pulls on an answer nothing reads -- so only a forced look goes ahead regardless.
  const { label } = pickLabel(labels, opts)
  if (opts.force || (!label && (!row || isStale(row, Date.now())))) {
    row = await resolveImage(image, opts.tag ?? currentTagFor(image), row)
  }
  return compose(labels, row, opts)
}

/** Tests only: forget memoised upstream answers between cases. */
export function resetResolverMemo(): void {
  lsioMemo = null
}

/** ghcr images very often live in the repo whose path they mirror. Used only as a probe
 *  hint when nothing else resolved -- never written to the cache as a real resolution. */
export function guessFromImagePath(registry: string, repository: string): string | null {
  if (registry !== 'ghcr.io') return null
  const parts = repository.split('/')
  if (parts.length < 2) return null
  return `${parts[0]}/${parts[1]}`
}

// ------------------------------------------------------------------ labels

interface LabelRow {
  stack: string
  service: string
  source_label: string | null
}

function readLabels(image: ImageKey): LabelRow[] {
  return getDb()
    .prepare(
      `SELECT stack, service, source_label FROM images
       WHERE registry = ? AND repository = ? AND source_label IS NOT NULL AND source_label != ''
       ORDER BY stack, service`,
    )
    .all(image.registry, image.repository) as LabelRow[]
}

const sameService = (a: ServiceKey | undefined, b: ServiceKey): boolean =>
  !!a && a.stack === b.stack && a.service === b.service

const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

function pickLabel(
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
    if (p.ok) siblings.push({ from: { stack: r.stack, service: r.service }, value: r.source_label.trim(), repo: p.repo })
  }

  const chosen = own ?? siblings[0] ?? null
  if (!chosen) return { label: null, invalidLabel }
  const others = own ? siblings : siblings.slice(1)
  return {
    label: {
      ...chosen,
      conflicts: others
        .filter((o) => !sameRepo(o.repo, chosen.repo))
        .map((o) => ({ ...o.from, value: o.value })),
    },
    invalidLabel,
  }
}

// ------------------------------------------------------------------ the cache

interface ResolutionRow {
  source_url: string | null
  tier: string
  confidence: string | null
  detail: string | null
  resolved_at: string
  checked_at: string | null
  next_check_at: string | null
  attempts: number
  error: string | null
  resolver_version: number
  packaging_repo: string | null
}

function readRow(image: ImageKey): ResolutionRow | null {
  const row = getDb()
    .prepare(
      `SELECT source_url, tier, confidence, detail, resolved_at, checked_at, next_check_at,
              attempts, error, resolver_version, packaging_repo
       FROM resolutions WHERE registry = ? AND repository = ?`,
    )
    .get(image.registry, image.repository) as ResolutionRow | undefined
  return row ?? null
}

function isStale(row: ResolutionRow, now: number): boolean {
  if (row.resolver_version < RESOLVER_VERSION) return true
  return row.next_check_at !== null && Date.parse(row.next_check_at) <= now
}

function currentTagFor(image: ImageKey): string | null {
  const row = getDb()
    .prepare(
      `SELECT current_tag FROM images
       WHERE registry = ? AND repository = ? AND current_tag IS NOT NULL AND current_tag != ''
       ORDER BY stack, service LIMIT 1`,
    )
    .get(image.registry, image.repository) as { current_tag: string } | undefined
  return row?.current_tag ?? null
}

const asConfidence = (c: string | null): SourceConfidence | null =>
  c === 'high' || c === 'medium' || c === 'low' ? c : null

function compose(
  labels: LabelRow[],
  row: ResolutionRow | null,
  opts: SourceOpts,
  now = Date.now(),
): SourceInfo {
  const { label, invalidLabel } = pickLabel(labels, opts)
  const shared = {
    inferred: row
      ? { repo: row.source_url, tier: row.tier as ResolutionTier, confidence: asConfidence(row.confidence) }
      : null,
    packagingRepo: row?.packaging_repo ?? null,
    label,
    invalidLabel,
    checkedAt: row?.checked_at ?? null,
    nextCheckAt: row?.next_check_at ?? null,
    error: row?.error ?? null,
    pending: !row || isStale(row, now),
  }
  if (label) {
    return {
      ...shared,
      repo: label.repo,
      tier: 'label',
      confidence: 'high',
      detail: sameService(opts.service, label.from)
        ? 'set by shipshape.source'
        : `set by shipshape.source on ${label.from.stack}/${label.from.service}, which runs the same image`,
    }
  }
  return {
    ...shared,
    repo: row?.source_url ?? null,
    tier: row?.source_url ? (row.tier as ResolutionTier) : 'none',
    confidence: row?.source_url ? asConfidence(row.confidence) : null,
    detail: row?.detail ?? null,
  }
}

// ------------------------------------------------------------------ looking it up

async function resolveImage(
  image: ImageKey,
  tag: string | null,
  prior: ResolutionRow | null,
): Promise<ResolutionRow | null> {
  const key = `${image.registry}/${image.repository}`
  let found: { repo: string; tier: ResolutionTier } | null = null
  let failure: string | null = null

  const override = OVERRIDES[key]
  if (override) {
    found = { repo: override, tier: 'override' }
  } else if (image.repository.startsWith('linuxserver/')) {
    const lsio = await lsioProjectUrls()
    if (!lsio.ok) {
      // A failure, not a fall-through: the manifest walk below would find the packaging
      // repo, and caching that as the answer is exactly the mistake this tier exists to avoid.
      failure = lsio.error
    } else {
      const hit = lsio.urls.get(image.repository.slice('linuxserver/'.length))
      if (hit) found = { repo: hit, tier: 'lsio' }
    }
  }

  if (!found && !failure && tag) {
    try {
      const ann = await fromAnnotations(image.registry, image.repository, tag)
      if (ann) found = { repo: ann, tier: 'annotation' }
    } catch (err) {
      // Every exception here is a failure to look -- a budget stop, a 429, a timeout, a
      // dropped connection -- never evidence that there is nothing to find.
      failure = (err as Error).message
    }
  }

  writeResolution(image, found, failure, prior)
  return readRow(image)
}

function writeResolution(
  image: ImageKey,
  found: { repo: string; tier: ResolutionTier } | null,
  failure: string | null,
  prior: ResolutionRow | null,
  now = new Date(),
): void {
  const db = getDb()
  const nowIso = now.toISOString()

  if (failure) {
    const attempts = (prior?.attempts ?? 0) + 1
    const next = backoffUntil(attempts, { baseMs: HOUR, capMs: DAY }, now.getTime())
    if (prior?.source_url) {
      // A repository found before stays found. The failure is recorded beside it.
      db.prepare(
        `UPDATE resolutions SET error = ?, attempts = ?, next_check_at = ?, checked_at = ?
         WHERE registry = ? AND repository = ?`,
      ).run(failure.slice(0, 300), attempts, next, nowIso, image.registry, image.repository)
      return
    }
    upsert(image, {
      source_url: null,
      tier: 'none',
      confidence: null,
      resolved_at: prior?.resolved_at ?? nowIso,
      checked_at: nowIso,
      next_check_at: next,
      attempts,
      error: failure.slice(0, 300),
    })
    return
  }

  upsert(image, {
    source_url: found?.repo ?? null,
    tier: found?.tier ?? 'none',
    confidence: found ? 'high' : null,
    resolved_at: nowIso,
    checked_at: nowIso,
    next_check_at: found ? null : new Date(now.getTime() + NONE_TTL_MS).toISOString(),
    attempts: 0,
    error: null,
  })
}

function upsert(
  image: ImageKey,
  r: {
    source_url: string | null
    tier: ResolutionTier
    confidence: SourceConfidence | null
    resolved_at: string
    checked_at: string
    next_check_at: string | null
    attempts: number
    error: string | null
  },
): void {
  getDb()
    .prepare(
      `INSERT INTO resolutions (registry, repository, source_url, tier, confidence, detail,
                                resolved_at, checked_at, next_check_at, attempts, error,
                                resolver_version)
       VALUES (@registry, @repository, @source_url, @tier, @confidence, NULL,
               @resolved_at, @checked_at, @next_check_at, @attempts, @error, @resolver_version)
       ON CONFLICT(registry, repository) DO UPDATE SET
         source_url = excluded.source_url, tier = excluded.tier,
         confidence = excluded.confidence, detail = excluded.detail,
         resolved_at = excluded.resolved_at, checked_at = excluded.checked_at,
         next_check_at = excluded.next_check_at, attempts = excluded.attempts,
         error = excluded.error, resolver_version = excluded.resolver_version`,
    )
    .run({ ...r, registry: image.registry, repository: image.repository, resolver_version: RESOLVER_VERSION })
}

// ------------------------------------------------------------------ tiers

/** LinuxServer's own API exposes `project_url` -- the real upstream, which the OCI label
 *  never gives (it points at the packaging repo). One request resolves every lsio image. */
const LSIO_URL = 'https://api.linuxserver.io/api/v1/images?include_config=false&include_deprecated=false'
const LSIO_TTL_MS = 6 * HOUR

/** Only a successful fetch is remembered. A failed one used to be, which emptied this tier
 *  for the life of the process after a single outage. */
let lsioMemo: { at: number; urls: Map<string, string> } | null = null

async function lsioProjectUrls(): Promise<
  { ok: true; urls: Map<string, string> } | { ok: false; error: string }
> {
  if (lsioMemo && Date.now() - lsioMemo.at < LSIO_TTL_MS) return { ok: true, urls: lsioMemo.urls }
  try {
    const res = await fetch(LSIO_URL, {
      headers: { 'user-agent': 'shipshape/0.1' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return { ok: false, error: `the LinuxServer API answered ${res.status}` }
    const body = (await res.json()) as {
      data?: { repositories?: Record<string, { name: string; project_url?: string }[]> }
    }
    const urls = new Map<string, string>()
    for (const list of Object.values(body.data?.repositories ?? {})) {
      for (const img of list) {
        const repo = normaliseSourceUrl(img.project_url ?? '')
        if (repo) urls.set(img.name, repo)
      }
    }
    lsioMemo = { at: Date.now(), urls }
    return { ok: true, urls }
  } catch (err) {
    return { ok: false, error: `the LinuxServer API could not be reached (${(err as Error).message})` }
  }
}

/** Walk the manifest for annotations without pulling the image. They hide in four
 *  distinct places and real images use every one of them. */
async function fromAnnotations(
  registry: string,
  repository: string,
  tag: string,
): Promise<string | null> {
  const host = registry === 'docker.io' ? 'registry-1.docker.io' : registry
  const base = `https://${host}/v2/${repository}`

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

  const res = await registryFetch(`${base}/manifests/${tag}`, { accept: ACCEPT, billed: true })
  if (!res.ok) return null
  const doc = (await res.json()) as {
    annotations?: Record<string, string>
    manifests?: { digest: string; annotations?: Record<string, string>; platform?: { architecture?: string; os?: string } }[]
    config?: { digest?: string }
  }

  // 1. index-level annotations (immich)
  const atIndex = read(doc.annotations)
  if (atIndex) return atIndex

  let manifest = doc
  if (doc.manifests?.length) {
    // 2. descriptor-level annotations -- where every Docker Official Image puts it
    for (const d of doc.manifests) {
      const atDesc = read(d.annotations)
      if (atDesc) return atDesc
    }
    // Recurse into the amd64 child (this host is amd64).
    const child =
      doc.manifests.find((m) => m.platform?.architecture === 'amd64' && m.platform.os === 'linux') ??
      doc.manifests[0]!
    const cres = await registryFetch(`${base}/manifests/${child.digest}`, {
      accept: ACCEPT,
      billed: true,
    })
    if (!cres.ok) return null
    manifest = (await cres.json()) as typeof doc
  }

  // 3. manifest-level annotations (authelia)
  const atManifest = read(manifest.annotations)
  if (atManifest) return atManifest

  // 4. config blob labels -- the majority case
  const cfgDigest = manifest.config?.digest
  if (!cfgDigest) return null
  const blob = await registryFetch(`${base}/blobs/${cfgDigest}`, { billed: true })
  if (!blob.ok) return null
  const cfg = (await blob.json()) as { config?: { Labels?: Record<string, string> } }
  return read(cfg.config?.Labels)
}
