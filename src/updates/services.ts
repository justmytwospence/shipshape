import { getDb } from '../db.ts'
import { loadPolicy } from '../config.ts'
import { scanRepo, type ScannedService } from '../compose/scan.ts'
import { env } from '../config.ts'
import { patternFor } from '../detect.ts'
import { tierFor } from '../policy.ts'
import { updatesForService } from './queries.ts'
import { sourceForSync, type SourceInfo } from '../resolver/index.ts'
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
        `SELECT stack, service, registry, repository, current_tag, watched, unwatchable,
                last_status, last_detail, constrained_from, last_seen_at, policy_label
           FROM images ORDER BY stack, service`,
      )
      .all() as {
      stack: string
      service: string
      registry: string
      repository: string | null
      current_tag: string | null
      watched: number
      unwatchable: string | null
      last_status: string | null
      last_detail: string | null
      constrained_from: string | null
      last_seen_at: string | null
      policy_label: string | null
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
    policy: r.policy_label,
    upstream: upstreamState(r),
  }))
}

function upstreamState(r: { stack: string; service: string; registry: string; repository: string | null }): ServiceRowData['upstream'] {
  if (!r.repository) return 'none'
  const s = sourceForSync({ registry: r.registry, repository: r.repository }, { service: { stack: r.stack, service: r.service } })
  return s.repo ? (s.confidence === 'high' ? 'linked' : 'likely') : 'none'
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
      case 'unlinked':
        // Watched services whose release notes have no certain source: nothing found, or
        // only a likely match.
        if (!r.watched || r.upstream === 'linked') return false
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
      `SELECT compose_file, pattern, tag_include, policy_label, claude_label,
              deploy_label, registry, repository
         FROM images WHERE stack = ? AND service = ?`,
    )
    .get(stack, service) as
    | {
        compose_file: string
        pattern: string | null
        tag_include: string | null
        policy_label: string | null
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
  // Through the accessor, with the live label: the pane has just scanned the compose file,
  // and a label edited a moment ago is the one that should show.
  const source = image
    ? sourceForSync(
        { registry: image.registry, repository: image.repository },
        {
          service: { stack, service },
          ownLabel: live ? live.sourceLabel : undefined,
          ownChangelog: live ? live.changelogLabel : undefined,
        },
      )
    : null
  config.push({
    key: 'upstream',
    value: source?.repo ?? '(unresolved)',
    source: source?.tier === 'label' ? 'label' : source?.repo ? 'inferred' : 'none',
    note: source ? upstreamNote(source, { stack, service }) : undefined,
  })
  config.push({
    key: 'notes',
    value: source?.changelog?.value ?? (source?.repo ? '(GitHub releases and changelog files)' : '(none)'),
    source: source?.changelog ? 'label' : source?.repo ? 'inferred' : 'none',
    note: source ? notesNote(source, { stack, service }) : undefined,
  })
  // The container's own changes, which the application's notes never mention.
  if (source?.packagingRepo) {
    config.push({ key: 'packaging', value: source.packagingRepo, source: 'inferred', note: 'container changes only' })
  }
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
    link: {
      source: live ? live.sourceLabel : null,
      changelog: live ? live.changelogLabel : null,
      inferred: source?.inferred?.repo ?? null,
    },
  }
}

/** The line under `notes`: which label applies, and why one was ignored. */
export function notesNote(s: SourceInfo, me: { stack: string; service: string }): string | undefined {
  const parts: string[] = []
  if (s.invalidChangelog) {
    parts.push(`shipshape.changelog "${s.invalidChangelog.value}" ignored: ${s.invalidChangelog.reason}`)
  }
  if (s.changelog && (s.changelog.from.stack !== me.stack || s.changelog.from.service !== me.service)) {
    parts.push(`label on ${s.changelog.from.stack}/${s.changelog.from.service}, which runs the same image`)
  }
  if (s.changelog) parts.push('read alongside any GitHub releases')
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/** For rows written before the resolver recorded its own detail. */
const TIER_WORDS: Partial<Record<string, string>> = {
  override: "shipshape's curated map",
  lsio: "LinuxServer's API names it as the project",
  'lsio-build': "LinuxServer's build file",
  annotation: "the image's OCI source label",
  'ghcr-path': 'published under the same path on ghcr.io',
  description: "linked from the image's description",
  lookup: "a GitHub repository with the image's owner and name",
}

/**
 * The line under `upstream`: where the answer came from, and anything about it worth
 * acting on. Several can apply at once, so they are joined.
 */
export function upstreamNote(s: SourceInfo, me: { stack: string; service: string }): string | undefined {
  const parts: string[] = []
  if (s.invalidLabel) {
    parts.push(`shipshape.source "${s.invalidLabel.value}" ignored: ${s.invalidLabel.reason}`)
  }
  if (s.label && (s.label.from.stack !== me.stack || s.label.from.service !== me.service)) {
    parts.push(`label on ${s.label.from.stack}/${s.label.from.service}, which runs the same image`)
  }
  if (s.label && s.label.conflicts.length > 0) {
    parts.push(
      `labels disagree: ${s.label.conflicts.map((c) => `${c.stack}/${c.service} says ${c.value}`).join(', ')}`,
    )
  }
  if (!s.label && s.repo) {
    const via = s.detail ?? TIER_WORDS[s.tier]
    if (via) parts.push(via)
    if (s.confidence !== 'high') parts.push('a likely match, not a certain one -- set shipshape.source to confirm it')
  }
  if (!s.repo && s.packagingRepo) parts.push(`${s.packagingRepo} packages it, and has only container changes`)
  if (!s.label && !s.repo && s.detail) parts.push(s.detail)
  if (s.error) {
    const when = s.nextCheckAt ? `; trying again ${s.nextCheckAt.slice(0, 16).replace('T', ' ')} UTC` : ''
    parts.push(`couldn't look: ${s.error}${when}`)
  } else if (!s.label && !s.inferred) {
    parts.push('not looked up yet')
  }
  return parts.length > 0 ? parts.join(' · ') : undefined
}
