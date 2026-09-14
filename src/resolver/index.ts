import { getDb } from '../db.ts'
import { registryFetch } from '../registry/http.ts'
import { backoffUntil } from '../backoff.ts'
import { getRepo, rawFile } from '../upstream/github.ts'
import { registryDescription } from '../upstream/registries.ts'
import {
  buildFileUpstream,
  githubMentions,
  imageParts,
  isPackagingRepo,
  looksInherited,
  nameRelation,
  ownerRelation,
  rankMentions,
  relation,
  type RankedMention,
} from './guards.ts'
import { normaliseSourceUrl, parseChangelogLabel, parseSourceLabel, type ChangelogTarget } from './labels.ts'

export { normaliseSourceUrl, parseChangelogLabel, parseSourceLabel, type ChangelogTarget } from './labels.ts'

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
 * The tiers, in order, stopping at the first answer that is certain:
 *
 * | Tier          | Signal                                                   | Confidence |
 * |---------------|----------------------------------------------------------|------------|
 * | `override`    | the curated map below                                    | high |
 * | `lsio`        | LinuxServer's API, when its project URL is on GitHub     | high |
 * | `lsio-build`  | the repository LinuxServer's build file reads releases from | high |
 * | `annotation`  | an OCI source annotation on the manifest                 | high |
 * | `ghcr-path`   | `ghcr.io/owner/name` is `owner/name`                     | high |
 * | `description` | a link in the registry's description of the image        | high when name and owner match, else medium |
 * | `annotation`  | a source label in the image config, unless inherited     | high when name or owner match, else medium |
 * | `lookup`      | a GitHub repository with the image's owner and name      | medium |
 *
 * Two tiers naming the same repository make it certain. Every inferred repository is checked
 * against GitHub first -- it must exist, and a fork counts only under the image's own owner.
 * On Docker Hub the manifest walk costs pulls, so there the free tiers go before it, and the
 * sweep during a scan skips it: such an image is looked at again, walk included, when
 * something needs its notes.
 *
 * Only a certain answer counts as linked where trust is extended (`policy/model-tier.ts`).
 * A likely one is still good enough to read release notes from.
 */

export type ResolutionTier =
  | 'label'
  | 'override'
  | 'lsio'
  | 'lsio-build'
  | 'annotation'
  | 'ghcr-path'
  | 'description'
  | 'lookup'
  | 'none'
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

export interface ChangelogLabelInfo {
  value: string
  /** The service whose label this is -- not always the one asking. */
  from: ServiceKey
  target: ChangelogTarget
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
  /** `shipshape.changelog`: where the release notes are when GitHub releases do not have them. */
  changelog: ChangelogLabelInfo | null
  /** The requesting service's own `shipshape.changelog`, when it could not be parsed. */
  invalidChangelog: InvalidLabel | null
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
  /** That service's `shipshape.changelog`, likewise: omit for the last scan's copy. */
  ownChangelog?: string | null
  /** The tag to walk for annotations. Defaults to the image's current tag. */
  tag?: string | null
  /** Look again even when the cached answer is fresh. */
  force?: boolean
  /**
   * May a lookup spend Docker Hub pulls on the manifest walk? Defaults to yes: the callers
   * that ask are about to read release notes for a real update. The scan's sweep says no.
   */
  allowBilled?: boolean
}

/** What one lookup considered, for the report and for anyone asking why. */
export interface ResolutionEvidence {
  candidates: { tier: ResolutionTier; repo: string; confidence: SourceConfidence | null; why: string }[]
  /** Tiers not run, and why. */
  skipped: string[]
  /** The billed walk was skipped and could still change the answer. */
  billedPending: boolean
}

export interface Lookup {
  repo: string | null
  tier: ResolutionTier
  confidence: SourceConfidence | null
  detail: string | null
  packagingRepo: string | null
  /** Why the lookup could not finish, when it could not. Never set on a certain answer. */
  failure: string | null
  evidence: ResolutionEvidence
}

/** Bump when tier logic changes, so rows written by the previous logic are looked at again. */
export const RESOLVER_VERSION = 2

const HOUR = 60 * 60_000
const DAY = 24 * HOUR
/** A clean "nothing found" is not forever: an image can gain an annotation. */
const NONE_TTL_MS = 7 * DAY
/** A likely answer is looked at again now and then, in case something more certain appears. */
const MEDIUM_TTL_MS = 30 * DAY

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
  const allowBilled = opts.allowBilled ?? true
  // A label answers the question by itself. Looking the image up anyway would spend Docker
  // Hub pulls on an answer nothing reads -- so only a forced look goes ahead regardless.
  const { label } = pickLabel(labels, opts)
  if (opts.force || (!label && (!row || isStale(row, Date.now(), allowBilled)))) {
    row = await resolveImage(image, opts.tag ?? currentTagFor(image), row, { allowBilled })
  }
  return compose(labels, row, opts)
}

/**
 * Look up the watched images whose answer is missing or due, a bounded number at a time.
 *
 * Without this an image was looked up only when an update needed its release notes, so
 * most of them never were, and the Services page called them unresolved indefinitely. The
 * scan runs it unbilled: a Docker Hub image that needs the manifest walk gets it later, when
 * an update, a review or "Look again" asks.
 */
export async function resolveWatched(
  o: { allowBilled?: boolean; limit?: number; budgetMs?: number } = {},
): Promise<{ looked: number; linked: number; failed: number; due: number }> {
  const allowBilled = o.allowBilled ?? false
  const limit = o.limit ?? 60
  const budgetMs = o.budgetMs ?? 90_000
  const started = Date.now()

  const due = watchedImages()
    .filter((i) => !pickLabel(readLabels(i), {}).label)
    .map((i) => ({ image: i, row: readRow(i) }))
    .filter((i) => !i.row || isStale(i.row, started, allowBilled))
    // Never looked up first, then whichever has waited longest.
    .sort((a, b) => (a.row?.checked_at ?? '').localeCompare(b.row?.checked_at ?? ''))

  const out = { looked: 0, linked: 0, failed: 0, due: due.length }
  for (const { image, row } of due) {
    if (out.looked >= limit || Date.now() - started >= budgetMs) break
    out.looked++
    try {
      const after = await resolveImage(image, currentTagFor(image), row, { allowBilled })
      if (after?.source_url && after.confidence === 'high') out.linked++
      if (after?.error) out.failed++
    } catch {
      // Writing the answer failed, which is a bug rather than an upstream's doing. One image.
      out.failed++
    }
  }
  return out
}

/** How many watched images have a certain upstream, a likely one, or none -- for Status. */
export function sourceCounts(): {
  total: number
  linked: number
  likely: number
  notFound: number
  notLooked: number
  failing: number
} {
  const out = { total: 0, linked: 0, likely: 0, notFound: 0, notLooked: 0, failing: 0 }
  for (const image of watchedImages()) {
    const s = sourceForSync(image)
    out.total++
    if (s.repo && s.confidence === 'high') out.linked++
    else if (s.repo) out.likely++
    else if (!s.inferred) out.notLooked++
    else out.notFound++
    if (s.error) out.failing++
  }
  return out
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

function watchedImages(): ImageKey[] {
  return getDb()
    .prepare(
      `SELECT DISTINCT registry, repository FROM images
       WHERE watched = 1 AND repository IS NOT NULL AND repository != ''
       ORDER BY registry, repository`,
    )
    .all() as ImageKey[]
}

// ------------------------------------------------------------------ labels

interface LabelRow {
  stack: string
  service: string
  source_label: string | null
  changelog_label: string | null
}

function readLabels(image: ImageKey): LabelRow[] {
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
function pickChangelog(
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
        changelog: { value: r.changelog_label.trim(), from: { stack: r.stack, service: r.service }, target: targetOf(p) },
        invalidChangelog,
      }
    }
  }
  return { changelog: null, invalidChangelog }
}

const targetOf = (p: ChangelogTarget): ChangelogTarget =>
  p.kind === 'url' ? { kind: 'url', url: p.url } : { kind: 'path', path: p.path }

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
  evidence: string | null
}

function readRow(image: ImageKey): ResolutionRow | null {
  const row = getDb()
    .prepare(
      `SELECT source_url, tier, confidence, detail, resolved_at, checked_at, next_check_at,
              attempts, error, resolver_version, packaging_repo, evidence
       FROM resolutions WHERE registry = ? AND repository = ?`,
    )
    .get(image.registry, image.repository) as ResolutionRow | undefined
  return row ?? null
}

function evidenceOf(row: ResolutionRow): Partial<ResolutionEvidence> {
  try {
    return row.evidence ? (JSON.parse(row.evidence) as ResolutionEvidence) : {}
  } catch {
    return {}
  }
}

function isStale(row: ResolutionRow, now: number, allowBilled: boolean): boolean {
  if (row.resolver_version < RESOLVER_VERSION) return true
  // Written before packaging repositories were told apart: the stored string says enough.
  if (isPackagingRepo(row.source_url)) return true
  if (row.next_check_at !== null && Date.parse(row.next_check_at) <= now) return true
  return allowBilled && evidenceOf(row).billedPending === true
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
  const { changelog, invalidChangelog } = pickChangelog(labels, opts)
  // A packaging repository is never the answer, even in a row written before that was known.
  const packaged = isPackagingRepo(row?.source_url)
  const found = row?.source_url && !packaged ? row.source_url : null
  const shared = {
    inferred: row
      ? {
          repo: found,
          tier: (found ? row.tier : 'none') as ResolutionTier,
          confidence: found ? asConfidence(row.confidence) : null,
        }
      : null,
    packagingRepo: row?.packaging_repo ?? (packaged ? row!.source_url : null),
    label,
    invalidLabel,
    changelog,
    invalidChangelog,
    checkedAt: row?.checked_at ?? null,
    nextCheckAt: row?.next_check_at ?? null,
    error: row?.error ?? null,
    pending: !row || isStale(row, now, false),
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
    repo: found,
    tier: found ? (row!.tier as ResolutionTier) : 'none',
    confidence: found ? asConfidence(row!.confidence) : null,
    detail: row && (found || !packaged) ? row.detail : null,
  }
}

async function resolveImage(
  image: ImageKey,
  tag: string | null,
  prior: ResolutionRow | null,
  o: { allowBilled: boolean },
): Promise<ResolutionRow | null> {
  const found = await lookUpImage(image, tag, o)
  writeResolution(image, found, prior)
  return readRow(image)
}

function writeResolution(image: ImageKey, l: Lookup, prior: ResolutionRow | null, now = new Date()): void {
  const nowIso = now.toISOString()
  const evidence = JSON.stringify(l.evidence)
  const priorRepo = prior?.source_url && !isPackagingRepo(prior.source_url) ? prior.source_url : null
  const certain = l.confidence === 'high'

  // A repository found before stays found when this look could not do better: it failed, or
  // it skipped the billed walk that found the old answer. What happened is recorded beside it.
  if (priorRepo && !certain && (l.failure || (l.evidence.billedPending && prior!.tier === 'annotation'))) {
    const attempts = l.failure ? prior!.attempts + 1 : 0
    getDb()
      .prepare(
        `UPDATE resolutions SET error = ?, attempts = ?, next_check_at = ?, checked_at = ?,
                resolver_version = ?, evidence = ?, packaging_repo = COALESCE(?, packaging_repo)
         WHERE registry = ? AND repository = ?`,
      )
      .run(
        l.failure?.slice(0, 300) ?? null,
        attempts,
        l.failure ? backoffUntil(attempts, { baseMs: HOUR, capMs: DAY }, now.getTime()) : null,
        nowIso,
        RESOLVER_VERSION,
        evidence,
        l.packagingRepo,
        image.registry,
        image.repository,
      )
    return
  }

  const attempts = l.failure ? (prior?.attempts ?? 0) + 1 : 0
  upsert(image, {
    source_url: l.repo,
    tier: l.tier,
    confidence: l.confidence,
    detail: l.detail,
    resolved_at: l.failure && !l.repo ? (prior?.resolved_at ?? nowIso) : nowIso,
    checked_at: nowIso,
    next_check_at: l.failure
      ? backoffUntil(attempts, { baseMs: HOUR, capMs: DAY }, now.getTime())
      : certain
        ? null
        : new Date(now.getTime() + (l.repo ? MEDIUM_TTL_MS : NONE_TTL_MS)).toISOString(),
    attempts,
    error: l.failure?.slice(0, 300) ?? null,
    evidence,
    packaging_repo: l.packagingRepo,
  })
}

function upsert(
  image: ImageKey,
  r: {
    source_url: string | null
    tier: ResolutionTier
    confidence: SourceConfidence | null
    detail: string | null
    resolved_at: string
    checked_at: string
    next_check_at: string | null
    attempts: number
    error: string | null
    evidence: string
    packaging_repo: string | null
  },
): void {
  getDb()
    .prepare(
      `INSERT INTO resolutions (registry, repository, source_url, tier, confidence, detail,
                                resolved_at, checked_at, next_check_at, attempts, error,
                                resolver_version, evidence, packaging_repo)
       VALUES (@registry, @repository, @source_url, @tier, @confidence, @detail,
               @resolved_at, @checked_at, @next_check_at, @attempts, @error,
               @resolver_version, @evidence, @packaging_repo)
       ON CONFLICT(registry, repository) DO UPDATE SET
         source_url = excluded.source_url, tier = excluded.tier,
         confidence = excluded.confidence, detail = excluded.detail,
         resolved_at = excluded.resolved_at, checked_at = excluded.checked_at,
         next_check_at = excluded.next_check_at, attempts = excluded.attempts,
         error = excluded.error, resolver_version = excluded.resolver_version,
         evidence = excluded.evidence, packaging_repo = excluded.packaging_repo`,
    )
    .run({ ...r, registry: image.registry, repository: image.repository, resolver_version: RESOLVER_VERSION })
}

// ------------------------------------------------------------------ looking it up

interface Candidate {
  tier: ResolutionTier
  repo: string
  confidence: 'high' | 'medium'
  detail: string
  /** An annotation or LinuxServer names the repository the image is built from, fork or not. */
  allowFork?: boolean
}

/** One lookup's working state: what each tier proposed, and what became of it. */
class Run {
  readonly evidence: ResolutionEvidence = { candidates: [], skipped: [], billedPending: false }
  readonly failures: string[] = []
  readonly found: Candidate[] = []
  packagingRepo: string | null = null
  noneDetail: string | null = null
  skippedBilled = false

  constructor(readonly image: ImageKey) {}

  note(c: { tier: ResolutionTier; repo: string }, confidence: SourceConfidence | null, why: string): void {
    this.evidence.candidates.push({ tier: c.tier, repo: c.repo, confidence, why })
  }

  packaging(tier: ResolutionTier, repo: string): void {
    this.packagingRepo ??= repo
    this.note({ tier, repo }, null, 'a packaging repository: container changes, not the application')
  }

  /** The repository as GitHub names it now, or null when it is not one to believe. */
  async verify(c: Candidate): Promise<string | null> {
    if (isPackagingRepo(c.repo)) {
      this.packaging(c.tier, c.repo)
      return null
    }
    const r = await getRepo(c.repo)
    if (!r.ok) {
      this.failures.push(r.detail)
      this.note(c, null, `could not be checked: ${r.detail}`)
      return null
    }
    if (!r.data) {
      this.note(c, null, 'GitHub has no such repository')
      return null
    }
    const repo = r.data.fullName
    if (isPackagingRepo(repo)) {
      this.packaging(c.tier, repo)
      return null
    }
    if (r.data.fork && !c.allowFork && !ownerRelation(this.image.repository, repo)) {
      this.note({ ...c, repo }, null, `a fork of ${r.data.parent ?? 'another repository'}`)
      return null
    }
    return repo
  }

  /** Record a checked candidate. True when it settles the answer. */
  accept(c: Candidate, why = c.detail): boolean {
    this.found.push(c)
    this.note(c, c.confidence, why)
    return c.confidence === 'high'
  }

  async offer(c: Candidate): Promise<boolean> {
    const repo = await this.verify(c)
    return repo ? this.accept({ ...c, repo }) : false
  }

  result(): Lookup {
    let pick = this.found.find((f) => f.confidence === 'high')
    if (!pick) {
      // Two tiers arriving at the same repository independently corroborate each other.
      for (const f of this.found) {
        const other = this.found.find((g) => g.tier !== f.tier && sameRepo(g.repo, f.repo))
        if (other) {
          pick = { ...f, confidence: 'high', detail: `${f.detail}; also ${other.detail}` }
          break
        }
      }
    }
    pick ??= this.found[0]
    const certain = pick?.confidence === 'high'
    if (!certain && this.skippedBilled) this.evidence.billedPending = true
    return {
      repo: pick?.repo ?? null,
      tier: pick?.tier ?? 'none',
      confidence: pick?.confidence ?? null,
      detail: pick?.detail ?? this.noneDetail,
      packagingRepo: this.packagingRepo,
      failure: certain || this.failures.length === 0 ? null : [...new Set(this.failures)].join('; '),
      evidence: this.evidence,
    }
  }
}

/**
 * Look an image up, without writing anything. `resolve-report --dry-run` calls this directly.
 */
export async function lookUpImage(
  image: ImageKey,
  tag: string | null,
  o: { allowBilled?: boolean; ignoreOverrides?: boolean } = {},
): Promise<Lookup> {
  const run = new Run(image)
  try {
    await tiers(run, image, tag, { allowBilled: o.allowBilled ?? true, ignoreOverrides: !!o.ignoreOverrides })
  } catch (err) {
    // Each tier handles the failures it expects. Anything else is still a failure to look,
    // never evidence that there is nothing to find.
    run.failures.push((err as Error).message)
  }
  return run.result()
}

/** Code-hosting registries: their images' projects live there, not on GitHub. */
const FORGES = new Set(['codeberg.org', 'registry.gitlab.com', 'ghcr.io'])

async function tiers(
  run: Run,
  image: ImageKey,
  tag: string | null,
  o: { allowBilled: boolean; ignoreOverrides: boolean },
): Promise<void> {
  const override = o.ignoreOverrides ? undefined : OVERRIDES[`${image.registry}/${image.repository}`]
  if (override) {
    run.accept({ tier: 'override', repo: override, confidence: 'high', detail: "shipshape's curated map" })
    return
  }

  if (image.repository.startsWith('linuxserver/')) return linuxServer(run, image)

  // The manifest walk is the most authoritative thing there is, and free -- except on Docker
  // Hub, where it costs pulls, so there the free tiers go first.
  const hub = image.registry === 'docker.io'
  let walk: Walked | null = null
  if (!hub) {
    walk = await walkTier(run, image, tag, o.allowBilled)
    if (walk.settled) return
  }

  if (image.registry === 'ghcr.io') {
    const [owner, name] = image.repository.split('/')
    if (owner && name) {
      const settled = await run.offer({
        tier: 'ghcr-path',
        repo: `${owner}/${name}`,
        confidence: 'high',
        detail: 'published under the same path on ghcr.io',
      })
      if (settled) return
    }
  }

  if (await descriptionTier(run, image)) return

  if (hub) {
    walk = await walkTier(run, image, tag, o.allowBilled)
    if (walk.settled) return
  }
  if (walk?.label && (await configLabelTier(run, image, tag, walk.label))) return

  // A GitHub repository with the image's own owner and name is likely the source, and only
  // likely: plenty of Docker Hub namespaces belong to someone else on GitHub.
  const { namespace, names } = imageParts(image.repository)
  const guess = namespace && names[0] ? parseSourceLabel(`${namespace}/${names[0]}`) : null
  if (!FORGES.has(image.registry) && guess?.ok) {
    await run.offer({
      tier: 'lookup',
      repo: guess.repo,
      confidence: 'medium',
      detail: "a GitHub repository with the image's owner and name",
    })
  }
}

/**
 * LinuxServer images: their API, then their build file. Nothing else is asked -- every other
 * tier would find `linuxserver/docker-<app>`, which is the packaging, not the application.
 */
async function linuxServer(run: Run, image: ImageKey): Promise<void> {
  const name = image.repository.slice('linuxserver/'.length)
  const packaging = `linuxserver/docker-${name}`
  run.packagingRepo = packaging

  const api = await lsioProjects()
  if (!api.ok) {
    // A failure, not a fall-through: caching the packaging repo as the answer is exactly the
    // mistake these tiers exist to avoid.
    run.failures.push(api.error)
    return
  }
  const entry = api.projects.get(name)
  if (entry?.repo) {
    const settled = await run.offer({
      tier: 'lsio',
      repo: entry.repo,
      confidence: 'high',
      detail: "LinuxServer's API names it as the project",
      allowFork: true,
    })
    if (settled) return
  }

  const build = await rawFile(packaging, 'Jenkinsfile')
  if (!build.ok && build.kind !== 'not-found') {
    run.failures.push(build.detail)
    return
  }
  const named = build.ok ? buildFileUpstream(build.text) : null
  if (named) {
    // A build file reads its version from somewhere, and not always the application:
    // qbittorrent's reads userdocs/qbittorrent-nox-static, which distributes static binaries.
    // A repository named for the image is its source; any other is only likely.
    const settled = await run.offer({
      tier: 'lsio-build',
      repo: named,
      confidence: relation(name, named.split('/')[1] ?? '') === 'same' ? 'high' : 'medium',
      detail: `${packaging} builds from its releases`,
      allowFork: true,
    })
    if (settled) return
  }
  run.noneDetail = entry?.home
    ? `LinuxServer names ${entry.home} as its home, and its build file names no GitHub repository`
    : "LinuxServer's API and build file name no GitHub repository"
}

interface Walked {
  settled: boolean
  label: { repo: string; labels: Record<string, string> } | null
}

async function walkTier(run: Run, image: ImageKey, tag: string | null, allowBilled: boolean): Promise<Walked> {
  const nothing: Walked = { settled: false, label: null }
  if (!tag) {
    run.evidence.skipped.push('the manifest walk: no tag to read')
    return nothing
  }
  if (image.registry === 'docker.io' && !allowBilled) {
    run.evidence.skipped.push('the manifest walk, which Docker Hub counts as pulls')
    run.skippedBilled = true
    return nothing
  }
  let sources: ManifestSources
  try {
    sources = await walkManifest(image.registry, image.repository, tag)
  } catch (err) {
    // A budget stop, a 429, a timeout, a dropped connection: a failure to look.
    run.failures.push((err as Error).message)
    return nothing
  }
  if (sources.annotation) {
    const settled = await run.offer({
      tier: 'annotation',
      repo: sources.annotation,
      confidence: 'high',
      detail: "the image's OCI source annotation",
      allowFork: true,
    })
    if (settled) return { settled, label: null }
  }
  return { settled: false, label: sources.label }
}

async function descriptionTier(run: Run, image: ImageKey): Promise<boolean> {
  const d = await registryDescription(image)
  if (!d.ok) {
    run.failures.push(d.error)
    return false
  }
  if (!d.text) return false
  const { ranked, packaging } = rankMentions(image.repository, githubMentions(d.text))
  for (const p of packaging) run.packaging('description', p)

  for (const group of byScore(ranked)) {
    const checked: { c: Candidate; why: string }[] = []
    for (const m of group.slice(0, 3)) {
      const c: Candidate = {
        tier: 'description',
        repo: m.repo,
        confidence: m.confidence,
        detail: `linked from its description on ${d.where}`,
      }
      const repo = await run.verify(c)
      if (repo && !checked.some((v) => sameRepo(v.c.repo, repo))) checked.push({ c: { ...c, repo }, why: m.why })
    }
    if (checked.length === 1) return run.accept(checked[0]!.c, checked[0]!.why)
    if (checked.length > 1) {
      // Equally good links are ambiguity, not an answer, and a weaker link is no tiebreaker.
      for (const v of checked) {
        const others = checked.filter((x) => x !== v).map((x) => x.c.repo)
        run.note(v.c, null, `linked alongside ${others.join(', ')}, with nothing to say which is the source`)
      }
      return false
    }
  }
  return false
}

function byScore(ranked: RankedMention[]): RankedMention[][] {
  const groups: RankedMention[][] = []
  for (const m of ranked) {
    const last = groups[groups.length - 1]
    if (last && last[0]!.score === m.score) last.push(m)
    else groups.push([m])
  }
  return groups
}

async function configLabelTier(
  run: Run,
  image: ImageKey,
  tag: string | null,
  label: { repo: string; labels: Record<string, string> },
): Promise<boolean> {
  const c: Candidate = {
    tier: 'annotation',
    repo: label.repo,
    confidence: 'medium',
    detail: "the image's source label",
    allowFork: true,
  }
  const inherited = looksInherited(label.labels, image.repository, tag, label.repo)
  if (inherited) {
    run.note(c, null, `probably inherited from a base image: ${inherited}`)
    return false
  }
  const repo = await run.verify(c)
  if (!repo) return false
  const related = !!nameRelation(image.repository, repo) || !!ownerRelation(image.repository, repo)
  return run.accept({ ...c, repo, confidence: related ? 'high' : 'medium' })
}

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

async function lsioProjects(): Promise<
  { ok: true; projects: Map<string, LsioProject> } | { ok: false; error: string }
> {
  if (lsioMemo && Date.now() - lsioMemo.at < LSIO_TTL_MS) return { ok: true, projects: lsioMemo.projects }
  try {
    const res = await fetch(LSIO_URL, {
      headers: { 'user-agent': 'shipshape/0.1' },
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

interface ManifestSources {
  /** From a manifest annotation, which an image cannot inherit. */
  annotation: string | null
  /** From the config's labels, which it can. */
  label: { repo: string; labels: Record<string, string> } | null
}

/** Walk the manifest for a source without pulling the image. It hides in four distinct
 *  places and real images use every one of them. */
async function walkManifest(registry: string, repository: string, tag: string): Promise<ManifestSources> {
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
