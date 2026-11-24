import { env, loadPolicy } from '../config.ts'
import { getDb } from '../db.ts'
import { logEvent } from '../events.ts'
import { scanRepo, unreadableComposeFiles, type ScannedService } from '../compose/scan.ts'

/** Mirror the compose files into `images`, and forget services that no longer exist. */
export function syncInventory(services: ScannedService[]): void {
  const db = getDb()
  const now = new Date().toISOString()
  const upsert = db.prepare(
    `INSERT INTO images (stack, service, compose_file, image_ref, registry, repository,
                         current_tag, current_digest, watched, pattern, tag_include,
                         legacy_labels, class_label, snapshot_label, backup_job_label,
                         source_label, changelog_label, review_label, deploy_label,
                         probe_port, network_mode, unwatchable,
                         fork_upstream, fork_waits_on, base_dockerfile, last_seen_at)
     VALUES (@stack, @service, @compose_file, @image_ref, @registry, @repository,
             @current_tag, @current_digest, @watched, @pattern, @tag_include,
             @legacy_labels, @class_label, @snapshot_label, @backup_job_label,
             @source_label, @changelog_label, @review_label, @deploy_label,
             @probe_port, @network_mode, @unwatchable,
             @fork_upstream, @fork_waits_on, @base_dockerfile, @last_seen_at)
     ON CONFLICT(stack, service) DO UPDATE SET
       compose_file = excluded.compose_file, image_ref = excluded.image_ref,
       registry = excluded.registry, repository = excluded.repository,
       current_tag = excluded.current_tag, current_digest = excluded.current_digest,
       watched = excluded.watched, pattern = excluded.pattern,
       tag_include = excluded.tag_include, legacy_labels = excluded.legacy_labels,
       class_label = excluded.class_label, snapshot_label = excluded.snapshot_label,
       backup_job_label = excluded.backup_job_label,
       source_label = excluded.source_label, changelog_label = excluded.changelog_label,
       review_label = excluded.review_label,
       deploy_label = excluded.deploy_label, probe_port = excluded.probe_port,
       network_mode = excluded.network_mode,
       unwatchable = excluded.unwatchable,
       fork_upstream = excluded.fork_upstream, fork_waits_on = excluded.fork_waits_on,
       base_dockerfile = excluded.base_dockerfile,
       last_seen_at = excluded.last_seen_at`,
  )

  db.transaction(() => {
    for (const s of services) {
      upsert.run({
        stack: s.stack,
        service: s.service,
        compose_file: s.composeFile,
        image_ref: s.imageRaw ?? '',
        registry: s.ref?.registry ?? '',
        repository: s.ref?.repository ?? '',
        current_tag: s.ref?.tag ?? null,
        current_digest: s.ref?.digest ?? null,
        watched: s.watched ? 1 : 0,
        pattern: s.pattern,
        tag_include: s.tagInclude,
        legacy_labels: s.legacyLabels.length ? s.legacyLabels.join(', ') : null,
        class_label: s.classLabel,
        snapshot_label: s.snapshotLabel,
        backup_job_label: s.backupJobLabel,
        source_label: s.sourceLabel,
        changelog_label: s.changelogLabel ?? null,
        review_label: s.reviewLabel,
        deploy_label: s.deployLabel,
        probe_port: s.probePort,
        network_mode: s.networkMode,
        unwatchable: s.unwatchable,
        fork_upstream: s.fork?.upstream ?? null,
        fork_waits_on: s.fork ? JSON.stringify(s.fork.waitsOn) : null,
        base_dockerfile: s.base?.dockerfile ?? null,
        last_seen_at: now,
      })
    }
    // A file that did not parse keeps its services as last read.
    const keep = db.prepare(`UPDATE images SET last_seen_at = ? WHERE compose_file = ?`)
    for (const rel of unreadableComposeFiles().keys()) keep.run(now, rel)
    db.prepare(`DELETE FROM images WHERE last_seen_at < ?`).run(now)
  })()
  for (const [rel, reason] of unreadableComposeFiles()) {
    logEvent({ level: 'warn', kind: 'scan', message: `compose file could not be read: ${rel}`, detail: reason })
  }
}


/**
 * Refresh one service's label columns from its compose file, without a full scan.
 *
 * A label edited from the UI is committed to the compose file, and every reader that goes
 * through the database saw the old value until the next scan -- the Services pane among
 * them, which is exactly where the edit was made. Only the label columns: running
 * `syncInventory` from here would also delete every row this pass did not just see.
 */
export function refreshServiceLabels(stack: string, service: string): boolean {
  const { policy } = loadPolicy()
  const svc = scanRepo(env.repoDir, policy.exclude_stacks).find(
    (s) => s.stack === stack && s.service === service,
  )
  if (!svc) return false
  getDb()
    .prepare(
      `UPDATE images SET watched = ?, legacy_labels = ?, class_label = ?, snapshot_label = ?,
                         backup_job_label = ?, source_label = ?, changelog_label = ?,
                         review_label = ?, deploy_label = ?
       WHERE stack = ? AND service = ?`,
    )
    .run(
      svc.watched ? 1 : 0,
      svc.legacyLabels.length ? svc.legacyLabels.join(', ') : null,
      svc.classLabel,
      svc.snapshotLabel,
      svc.backupJobLabel,
      svc.sourceLabel,
      svc.changelogLabel ?? null,
      svc.reviewLabel,
      svc.deployLabel,
      stack,
      service,
    )
  return true
}
