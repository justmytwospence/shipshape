import { getDb } from '../db/index.ts'
import { backoffUntil } from '../backoff.ts'
import { isPackagingRepo } from './guards.ts'
import { pickLabel, type LabelRow, pickChangelog, sameService } from './labels.ts'
import {
  type ImageKey,
  type SourceOpts,
  type SourceInfo,
  type ResolutionEvidence,
  RESOLVER_VERSION,
  type SourceConfidence,
  type ResolutionTier,
  type Lookup,
  HOUR,
  DAY,
  MEDIUM_TTL_MS,
  NONE_TTL_MS,
} from './types.ts'
import { OVERRIDES } from './overrides.ts'

export interface ResolutionRow {
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

export function readRow(image: ImageKey): ResolutionRow | null {
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

export function isStale(row: ResolutionRow, now: number, allowBilled: boolean, image?: ImageKey): boolean {
  if (row.resolver_version < RESOLVER_VERSION) return true
  // Written before packaging repositories were told apart: the stored string says enough.
  if (isPackagingRepo(row.source_url)) return true
  // From a curated entry since removed: another tier answers it now, and should say which.
  if (image && row.tier === 'override' && !OVERRIDES[`${image.registry}/${image.repository}`]) return true
  if (row.next_check_at !== null && Date.parse(row.next_check_at) <= now) return true
  return allowBilled && evidenceOf(row).billedPending === true
}

export function currentTagFor(image: ImageKey): string | null {
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

export function compose(labels: LabelRow[], row: ResolutionRow | null, opts: SourceOpts, now = Date.now()): SourceInfo {
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

export function writeResolution(image: ImageKey, l: Lookup, prior: ResolutionRow | null, now = new Date()): void {
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
