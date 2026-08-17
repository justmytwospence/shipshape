import { getDb } from '../db.ts'
import { loadPolicy } from '../config.ts'
import { scanRepo, type ScannedService } from '../compose/scan.ts'
import { env } from '../config.ts'
import { patternFor } from '../detect.ts'
import { tierFor } from '../policy.ts'
import { updatesForService } from './queries.ts'
import type { ConfigLine, ServiceDetailData, ServiceRowData } from '../web/views/ui/services.tsx'

/**
 * What shipshape knows about one service, and where each part of it came from.
 *
 * The provenance is the useful half. "manual" on its own invites the question the old
 * page could not answer -- is that a label on this service, the default for a major, or
 * a rule nothing can change -- and answering it meant opening the compose file and
 * policy.yaml side by side.
 */

export function serviceRows(): ServiceRowData[] {
  return (
    getDb()
      .prepare(
        `SELECT stack, service, repository, current_tag, watched, unwatchable,
                last_status, last_detail, constrained_from, last_seen_at
           FROM images ORDER BY stack, service`,
      )
      .all() as {
      stack: string
      service: string
      repository: string | null
      current_tag: string | null
      watched: number
      unwatchable: string | null
      last_status: string | null
      last_detail: string | null
      constrained_from: string | null
      last_seen_at: string | null
    }[]
  ).map((r) => ({
    stack: r.stack,
    service: r.service,
    image: r.repository,
    tag: r.current_tag,
    watched: r.watched === 1,
    unwatchable: r.unwatchable,
    lastStatus: r.last_status,
    lastDetail: r.last_detail,
    constrainedFrom: r.constrained_from,
    lastSeenAt: r.last_seen_at,
  }))
}

export function filterServices(
  rows: ServiceRowData[],
  opts: { filter?: string; q?: string } = {},
): ServiceRowData[] {
  const q = opts.q?.trim().toLowerCase()
  return rows.filter((r) => {
    switch (opts.filter) {
      case 'watched':
        if (!r.watched) return false
        break
      case 'unlabelled':
        if (r.watched || r.unwatchable) return false
        break
      case 'unwatchable':
        if (!r.unwatchable) return false
        break
      case 'attention':
        // A pinned service whose newer release is suppressed by its own tag filter
        // belongs here too: it is the other way a service quietly stops updating, and
        // the old filter looked only at errors, so it was unreachable.
        if (!r.lastStatus && !r.constrainedFrom) return false
        break
      default:
        break
    }
    if (!q) return true
    return (
      r.stack.toLowerCase().includes(q) ||
      r.service.toLowerCase().includes(q) ||
      (r.image ?? '').toLowerCase().includes(q)
    )
  })
}

export function serviceDetail(stack: string, service: string): ServiceDetailData | null {
  const rows = serviceRows()
  const svc = rows.find((r) => r.stack === stack && r.service === service)
  if (!svc) return null

  const { policy } = loadPolicy()
  const db = getDb()
  const image = db
    .prepare(
      `SELECT compose_file, pattern, tag_include, policy_label, source_label, claude_label,
              deploy_label, registry, repository
         FROM images WHERE stack = ? AND service = ?`,
    )
    .get(stack, service) as
    | {
        compose_file: string
        pattern: string | null
        tag_include: string | null
        policy_label: string | null
        source_label: string | null
        claude_label: string | null
        deploy_label: string | null
        registry: string
        repository: string
      }
    | undefined

  // The live labels, because a compose edit takes effect on the next scan and the
  // database row is only as fresh as that scan.
  let live: ScannedService | undefined
  try {
    live = scanRepo(env.repoDir, policy.exclude_stacks).find(
      (s) => s.stack === stack && s.service === service,
    )
  } catch {
    live = undefined
  }

  const policyLabel = live?.policyLabel ?? image?.policy_label ?? null
  const prLabel = live?.prLabel ?? null
  const config: ConfigLine[] = []

  const rung = (magnitude: 'patch' | 'minor' | 'major' | 'digest') =>
    tierFor({ magnitude, policyLabel, prLabel, defaults: policy.defaults })

  config.push({
    key: 'policy',
    value: policyLabel ?? '(none)',
    source: policyLabel ? 'label' : 'none',
    note: prLabel ? `shipshape.pr: ${prLabel} also set` : undefined,
  })
  for (const m of ['patch', 'minor', 'major', 'digest'] as const) {
    config.push({
      key: m,
      value: rung(m),
      // A major is not a default anyone chose: it is a floor nothing overrides.
      source: m === 'major' ? 'locked' : policyLabel ? 'label' : 'default',
    })
  }
  config.push({ key: 'watch', value: svc.watched ? 'on' : 'off', source: 'label' })
  config.push({
    key: 'pattern',
    value: (live ? patternFor(live) : (image?.pattern ?? null)) ?? '(none)',
    source: image?.pattern ? 'label' : 'inferred',
  })
  if (image?.tag_include) {
    config.push({ key: 'tag filter', value: image.tag_include, source: 'label' })
  }
  const resolution = image
    ? (db
        .prepare(`SELECT source_url, tier FROM resolutions WHERE registry = ? AND repository = ?`)
        .get(image.registry, image.repository) as { source_url: string; tier: string } | undefined)
    : undefined
  config.push({
    key: 'upstream',
    value: image?.source_label ?? resolution?.source_url ?? '(unresolved)',
    source: image?.source_label ? 'label' : resolution ? 'inferred' : 'none',
  })
  if (image?.deploy_label) {
    config.push({ key: 'deploy', value: image.deploy_label, source: 'label' })
  }
  if (image?.claude_label) {
    config.push({ key: 'review', value: image.claude_label, source: 'label' })
  }

  return {
    svc,
    composeFile: image?.compose_file ?? null,
    config,
    history: updatesForService(stack, service),
    // Editing writes into the compose file, which only exists where one was found.
    canEdit: !!image?.compose_file,
  }
}
