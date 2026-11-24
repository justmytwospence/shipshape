import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { configured, env, loadPolicy, paths } from '../config.ts'
import { getDb } from '../db.ts'
import { logEvent, type EventKind } from '../events.ts'
import { scanRepo } from '../compose/scan.ts'
import { parseImageRef } from '../images/ref.ts'
import { recordTelemetry } from '../scan/report.ts'
import { syncInventory } from '../scan/inventory.ts'

/**
 * The demo's history: a fortnight of a small compose repository (examples/demo), written
 * into an empty database relative to now, so every page has something on it.
 *
 * The inventory goes through the scanner and the log through logEvent; the rest is direct
 * SQL into the tables the pages read, because verdicts, screens, deploys and change records
 * are written inline by network-driven passes and have no standalone writer. Upstreams come
 * from `shipshape.source` labels only, never the resolution cache.
 *
 * It refuses a database that already has history, so it can never seed over real data.
 */

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

const DOZZLE_OLD = sha256('dozzle-old')
const DOZZLE_NEW = sha256('dozzle-new')
const PY_OLD = sha256('shipshape-demo-old')
const PY_NEW = sha256('shipshape-demo-new')

interface DemoUpdate {
  id: number
  stack: string
  service: string
  image: string
  from: string
  to: string
  magnitude: string
  tier: string
  state: string
  detail?: string
  detected: number
  updated: number
  approved?: number
  snoozedUntil?: number
  decisionSince?: number
  /** The upstream repository, for release links. */
  source?: string
}

const UPDATES: DemoUpdate[] = [
  { id: 1, stack: 'vaultwarden', service: 'vaultwarden', image: 'vaultwarden/server:1.32.4', from: '1.32.4', to: '1.32.5', magnitude: 'patch', tier: 'ask', state: 'detected', detected: 30, updated: 30, decisionSince: 30, source: 'dani-garcia/vaultwarden' },
  { id: 2, stack: 'immich', service: 'immich-server', image: 'ghcr.io/immich-app/immich-server:v1.120.2', from: 'v1.120.2', to: 'v1.121.0', magnitude: 'minor', tier: 'normal', state: 'detected', detected: 20, updated: 20, decisionSince: 19, source: 'immich-app/immich' },
  { id: 3, stack: 'immich', service: 'immich-machine-learning', image: 'ghcr.io/immich-app/immich-machine-learning:v1.120.2', from: 'v1.120.2', to: 'v1.121.0', magnitude: 'minor', tier: 'normal', state: 'detected', detected: 20, updated: 20, decisionSince: 19, source: 'immich-app/immich' },
  { id: 4, stack: 'nextcloud', service: 'db', image: 'postgres:16.4-alpine', from: '16.4-alpine', to: '17.2-alpine', magnitude: 'major', tier: 'stateful', state: 'detected', detected: 50, updated: 50, decisionSince: 49, source: 'postgres/postgres' },
  { id: 5, stack: 'traefik', service: 'traefik', image: 'traefik:v3.2.1', from: 'v3.2.1', to: 'v3.2.2', magnitude: 'patch', tier: 'lifeline', state: 'detected', detected: 72, updated: 70, snoozedUntil: -120, decisionSince: 71, source: 'traefik/traefik' },
  { id: 6, stack: 'paperless', service: 'webserver', image: 'ghcr.io/paperless-ngx/paperless-ngx:2.13.5', from: '2.13.5', to: '2.14.0', magnitude: 'minor', tier: 'normal', state: 'detected', detected: 40, updated: 40, source: 'paperless-ngx/paperless-ngx' },
  { id: 7, stack: 'jellyfin', service: 'jellyfin', image: 'jellyfin/jellyfin:10.9.11', from: '10.9.11', to: '10.10.3', magnitude: 'minor', tier: 'normal', state: 'verified', detected: 216, updated: 26, source: 'jellyfin/jellyfin' },
  { id: 8, stack: 'monitoring', service: 'uptime-kuma', image: 'louislam/uptime-kuma:1.23.15', from: '1.23.15', to: '1.23.16', magnitude: 'patch', tier: 'normal', state: 'failed', detail: 'rolled back: the health check failed within the verify window', detected: 240, updated: 5, source: 'louislam/uptime-kuma' },
  { id: 9, stack: 'paperless', service: 'broker', image: 'redis:7.4.1-alpine', from: '7.4.1-alpine', to: '7.4.2-alpine', magnitude: 'patch', tier: 'normal', state: 'deployed', detected: 192, updated: 0.4, source: 'redis/redis' },
  { id: 10, stack: 'monitoring', service: 'dozzle', image: 'amir20/dozzle:latest', from: `latest@sha256:${DOZZLE_OLD}`, to: `latest@sha256:${DOZZLE_NEW}`, magnitude: 'digest', tier: 'normal', state: 'detected', detail: 'rolling', detected: 3, updated: 3 },
  { id: 11, stack: 'tools', service: 'backup-agent', image: `python:3.12-slim@sha256:${PY_OLD}`, from: `3.12-slim@sha256:${PY_OLD}`, to: `3.12-slim@sha256:${PY_NEW}`, magnitude: 'digest', tier: 'frozen', state: 'frozen', detected: 60, updated: 60 },
  { id: 12, stack: 'nextcloud', service: 'app', image: 'nextcloud:30.0.2-apache', from: '30.0.2-apache', to: '30.0.4-apache', magnitude: 'patch', tier: 'normal', state: 'left-stopped', detected: 120, updated: 96, source: 'nextcloud/server' },
  { id: 13, stack: 'vaultwarden', service: 'vaultwarden', image: 'vaultwarden/server:1.32.3', from: '1.32.3', to: '1.32.4', magnitude: 'patch', tier: 'ask', state: 'verified', detected: 480, updated: 432, approved: 440, source: 'dani-garcia/vaultwarden' },
  { id: 14, stack: 'immich', service: 'immich-server', image: 'ghcr.io/immich-app/immich-server:v1.119.1', from: 'v1.119.1', to: 'v1.120.2', magnitude: 'minor', tier: 'normal', state: 'verified', detected: 288, updated: 264, source: 'immich-app/immich' },
  { id: 15, stack: 'immich', service: 'redis', image: 'docker.io/valkey/valkey:8.0.1-alpine', from: '8.0.1-alpine', to: '8.0.2-alpine', magnitude: 'patch', tier: 'normal', state: 'skipped', detected: 150, updated: 144 },
]

interface DemoVerdict {
  recommendation: 'approve' | 'caution' | 'block'
  confidence: 'high' | 'medium' | 'low'
  summary: string
  breaking?: string[]
  migration?: string[]
  features?: string[]
  source?: 'reader' | 'screen'
  irreversible?: boolean
}

const VERDICTS: Record<number, DemoVerdict> = {
  1: {
    recommendation: 'approve',
    confidence: 'high',
    summary: 'Fixes a crash when importing an export that carries attachments, and updates the bundled web vault.',
    features: ['Organization members can be exported as CSV from the admin page.'],
  },
  2: {
    recommendation: 'block',
    confidence: 'high',
    summary: 'The server now requires the VectorChord build of Postgres and drops endpoints that older mobile apps call.',
    breaking: [
      'The database must run the VectorChord image before the server will start.',
      'The /api/server-info routes are gone; mobile apps older than 1.121 cannot sign in.',
    ],
    migration: [
      'Switch the database service to the VectorChord image and start it before the server.',
      'Update the mobile apps to 1.121 or newer.',
    ],
    features: ['Faces can be merged from the people page.'],
  },
  3: {
    recommendation: 'caution',
    confidence: 'medium',
    summary: 'Model files move to a new cache path, so the first start downloads them again.',
    migration: ['Mount the model cache at /cache rather than /usr/src/app/.cache.'],
  },
  4: {
    recommendation: 'caution',
    confidence: 'high',
    irreversible: true,
    summary: 'PostgreSQL 17. A 16 data directory does not start under 17 without a dump and restore.',
    breaking: ['A PostgreSQL 16 data directory does not start under 17.'],
    migration: ['Dump with pg_dumpall, start an empty 17 cluster, and restore the dump.'],
  },
  5: { recommendation: 'approve', confidence: 'high', summary: 'Fixes a regression in the HTTP/3 listener.' },
  6: {
    recommendation: 'approve',
    confidence: 'high',
    source: 'screen',
    summary: 'Routine: fixes in the document consumer and a newer OCR engine.',
  },
  7: {
    recommendation: 'approve',
    confidence: 'high',
    summary: 'A larger release: a new playback engine, trickplay previews and media segments. No configuration changes are needed.',
    features: ['Trickplay previews while seeking.', 'Media segments for skipping intros.'],
  },
  8: { recommendation: 'approve', confidence: 'medium', summary: 'Fixes notification retries and updates the bundled Chromium.' },
  9: { recommendation: 'approve', confidence: 'high', summary: 'Security and bug fixes.' },
  12: { recommendation: 'approve', confidence: 'high', summary: 'Bug fixes.' },
  13: { recommendation: 'approve', confidence: 'high', summary: 'Bug fixes.' },
  14: { recommendation: 'approve', confidence: 'high', summary: 'Bug fixes.' },
}

/** Fill an empty database with the demo's history, relative to `now`. Returns what it wrote. */
export function seedDemo(now = Date.now()): { updates: number; events: number } {
  const setup = configured()
  if (!setup.ok) throw new Error('seed-demo: REPO_DIR and GITHUB_REPO must point at the demo repository first.')
  const db = getDb()
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n
  if (count(`SELECT COUNT(*) AS n FROM updates`) > 0 || count(`SELECT COUNT(*) AS n FROM events WHERE kind != 'system'`) > 0) {
    throw new Error(`seed-demo: ${paths.db} already has history; the demo seeds only an empty database.`)
  }

  /** `h` hours before now; a negative `h` is the future. */
  const at = (h: number) => new Date(now - h * 3_600_000).toISOString()
  const month = new Date(now).toISOString().slice(0, 7)
  const byId = new Map(UPDATES.map((u) => [u.id, u]))
  const release = (u: DemoUpdate) =>
    u.source ? `https://github.com/${u.source}/releases/tag/${u.to}` : null

  // 1. The inventory, through the scanner.
  const { policy } = loadPolicy()
  syncInventory(scanRepo(env.repoDir, policy.exclude_stacks))
  db.prepare(`UPDATE images SET last_seen_at = ?`).run(at(1))

  db.transaction(() => {
    // 2. Updates, in id order.
    const insertUpdate = db.prepare(
      `INSERT INTO updates (id, stack, service, image, from_tag, to_tag, magnitude, tier, state, detail,
                            detected_at, updated_at, approved_at, snoozed_until, decision_since)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const u of UPDATES) {
      insertUpdate.run(
        u.id, u.stack, u.service, u.image, u.from, u.to, u.magnitude, u.tier, u.state, u.detail ?? null,
        at(u.detected), at(u.updated),
        u.approved !== undefined ? at(u.approved) : null,
        u.snoozedUntil !== undefined ? at(u.snoozedUntil) : null,
        u.decisionSince !== undefined ? at(u.decisionSince) : null,
      )
    }

    // 3. Release dates, which the cooldown reads. Update 6 is five days short of it.
    const insertTag = db.prepare(
      `INSERT OR IGNORE INTO tags_seen (registry, repository, tag, published_at, first_seen_at) VALUES (?, ?, ?, ?, ?)`,
    )
    for (const u of UPDATES) {
      if (u.magnitude === 'digest' || u.id === 10 || u.id === 11) continue
      const ref = parseImageRef(u.image)
      const published = u.id === 6 ? at(48) : at(u.detected + 240)
      insertTag.run(ref.registry, ref.repository, u.to, published, published)
    }

    // 4. Reviews.
    const insertVerdict = db.prepare(
      `INSERT INTO verdicts (image, from_tag, to_tag, summary, breaking_changes, migration_steps, recommendation,
                             confidence, sources, model, cost_usd, created_at, attempts, evidence, new_features,
                             source, provisional, irreversible)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0, ?)`,
    )
    for (const [id, v] of Object.entries(VERDICTS)) {
      const u = byId.get(Number(id))!
      const link = release(u)
      insertVerdict.run(
        u.image, u.from, u.to, v.summary,
        JSON.stringify(v.breaking ?? []), JSON.stringify(v.migration ?? []),
        v.recommendation, v.confidence, JSON.stringify(link ? [link] : []),
        v.source === 'screen' ? null : 'claude-sonnet-5-5', v.source === 'screen' ? 0.0005 : 0.0375,
        at(u.detected - 1), '{"releases":1}', JSON.stringify(v.features ?? []),
        v.source ?? 'reader', v.irreversible ? 1 : 0,
      )
    }

    // 5. The screen's answers, for the hero decision and one routine update.
    const insertScreen = db.prepare(
      `INSERT INTO screens (image, from_tag, to_tag, model, decision, reason, answers, lines, actionable, notable,
                            cost_usd, attempts, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 0.0005, 1, ?)`,
    )
    const u2 = byId.get(2)!
    const r2 = release(u2)
    insertScreen.run(
      u2.image, u2.from, u2.to, 'finding', 'the notes name a manual step and a removed endpoint',
      JSON.stringify({
        config_removed_or_renamed: { type: 'noul', noul: 0.86 },
        manual_step_required: { type: 'noul', noul: 0.93 },
        affects_this_deployment: { type: 'noul', noul: 0.71 },
      }),
      JSON.stringify([
        { version: 'v1.121.0', text: 'Breaking: the server no longer starts against the old vector extension; switch the database image first.', url: r2 },
        { version: 'v1.121.0', text: 'Removed /api/server-info; mobile apps older than 1.121 cannot sign in.', url: r2 },
        { version: 'v1.121.0', text: 'Faces can now be merged from the people page.', url: r2 },
      ]),
      JSON.stringify([0, 1]), JSON.stringify([2]), at(u2.detected - 0.5),
    )
    const u6 = byId.get(6)!
    insertScreen.run(
      u6.image, u6.from, u6.to, 'routine', 'no setting, step or migration is mentioned', JSON.stringify({}),
      JSON.stringify([{ version: '2.14.0', text: 'Newer OCR engine with better table detection.', url: release(u6) }]),
      JSON.stringify([]), JSON.stringify([0]), at(u6.detected - 0.5),
    )

    // 6. What shipped, and the deploy that followed each.
    const insertChange = db.prepare(
      `INSERT INTO prs (number, branch, head_sha_pushed, state, group_key, created_at, merged_at, scope, merge_commit_sha)
       VALUES (0, ?, ?, 'merged', ?, ?, ?, 'tag-only', ?)`,
    )
    const linkChange = db.prepare(`INSERT INTO pr_updates (pr_id, update_id) VALUES (?, ?)`)
    const insertDeploy = db.prepare(
      `INSERT INTO deploys (pr_number, pr_id, stack, services, strategy, ok, healthy, detail, created_at, status,
                            attempts, started_at, finished_at, recheck_at, trigger)
       VALUES (NULL, ?, ?, ?, 'up', ?, ?, ?, ?, ?, 1, ?, ?, ?, 'queue')`,
    )
    const linkDeploy = db.prepare(`INSERT INTO deploy_updates (deploy_id, update_id) VALUES (?, ?)`)
    const DEPLOYS: Record<number, { status: string; finished: number; detail?: string; recheck?: number }> = {
      7: { status: 'verified', finished: byId.get(7)!.updated },
      8: { status: 'rolled-back', finished: 5, detail: 'the health check failed within the verify window; 1.23.15 was put back' },
      9: { status: 'deployed', finished: 0.3, recheck: -0.35 },
      12: { status: 'left-stopped', finished: 96 },
      13: { status: 'verified', finished: byId.get(13)!.updated },
      14: { status: 'verified', finished: byId.get(14)!.updated },
    }
    for (const [id, d] of Object.entries(DEPLOYS)) {
      const u = byId.get(Number(id))!
      const sha = createHash('sha1').update(`demo-${u.id}`).digest('hex')
      const merged = at(u.updated + (u.id === 9 ? 0.1 : 1))
      const prId = Number(
        insertChange.run(`shipshape/${u.stack}-${u.to}`, sha, u.stack, merged, merged, sha).lastInsertRowid,
      )
      linkChange.run(prId, u.id)
      const good = d.status === 'verified' || d.status === 'deployed' ? 1 : 0
      const deployId = Number(
        insertDeploy.run(
          prId, u.stack, u.service, good, good, d.detail ?? null, merged, d.status, merged, at(d.finished),
          d.recheck !== undefined ? at(d.recheck) : null,
        ).lastInsertRowid,
      )
      linkDeploy.run(deployId, u.id)
    }

    // 7. One security incident, a service it touches, and the update that fixes it.
    const slug = 'cve-2024-45492-libexpat'
    db.prepare(
      `INSERT INTO security_incidents (slug, category, title, severity, patch_status, status, tags, cve_ids, url,
                                       updated_at, raw, fetched_at, versions_hash, relevant, targets)
       VALUES (?, 'patch', ?, 'high', 'patched', 'live', '[]', ?, ?, ?, '{}', ?, 'demo', 1, ?)`,
    ).run(
      slug, 'libexpat: integer overflow in nextScaffoldPart (CVE-2024-45492)', '["CVE-2024-45492"]',
      'https://nvd.nist.gov/vuln/detail/CVE-2024-45492', at(72), at(1),
      '[{"ecosystem":"deb","names":["libexpat1"],"affected":[{"lt":"2.6.3"}],"fixed":["2.6.3"]}]',
    )
    db.prepare(
      `INSERT INTO exposures (slug, stack, service, type, package, installed, fixed, first_seen_at, last_seen_at)
       VALUES (?, 'paperless', 'webserver', 'deb', 'libexpat1', '2.5.0-1', '2.6.3', ?, ?)`,
    ).run(slug, at(70), at(1))
    db.prepare(`INSERT INTO security_fixes (update_id, slug, evidence, verified_at) VALUES (6, ?, ?, ?)`).run(
      slug, '[{"type":"deb","name":"libexpat1","from":"2.5.0-1","to":["2.6.3-1"]}]', at(30),
    )
    const running = db
      .prepare(`SELECT stack, service, image_ref FROM images WHERE watched = 1 AND NOT (stack = 'tools' AND service = 'backup-agent')`)
      .all() as { stack: string; service: string; image_ref: string }[]
    const insertRunning = db.prepare(
      `INSERT INTO security_running (stack, service, image_id, image_ref, seen_at) VALUES (?, ?, ?, ?, ?)`,
    )
    const insertSbom = db.prepare(
      `INSERT OR IGNORE INTO sbom_images (image_id, ref, scanned_at, packages, attempts) VALUES (?, ?, ?, 120, 1)`,
    )
    for (const r of running) {
      const imageId = `sha256:${sha256(`${r.stack}/${r.service}`)}`
      insertRunning.run(r.stack, r.service, imageId, r.image_ref, at(1))
      // One image still to read.
      if (!(r.stack === 'monitoring' && r.service === 'dozzle')) insertSbom.run(imageId, r.image_ref, at(2))
    }

    // 8. The spend ledger.
    const insertCall = db.prepare(
      `INSERT INTO llm_calls (model, purpose, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
                              searches, cost_usd, created_at, provider, outcome, cost_estimated)
       VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, ?, 'ok', 0)`,
    )
    for (let k = 1; k <= 22; k++) {
      if (k <= 8) insertCall.run('claude-sonnet-5-5', 'verdict', 9000, 700, 0.0375, at(k), 'anthropic')
      else insertCall.run('screen', 'screen', 1200, 40, 0.0005, at(k), 'openrouter')
    }
    db.prepare(`INSERT OR REPLACE INTO budgets (key, value, window, updated_at) VALUES ('claude.spend_usd', 0.307, ?, ?)`).run(
      month, at(1),
    )
  })()

  // 9. The scan clock.
  recordTelemetry({ 'up-to-date': 7, update: 4, 'moved-rolling': 1, unchanged: 1 }, 41)
  db.prepare(`UPDATE budgets SET window = ?, updated_at = ? WHERE key = 'scan.last_at'`).run(at(6), at(6))
  const putBudget = db.prepare(`INSERT OR REPLACE INTO budgets (key, value, window, updated_at) VALUES (?, ?, ?, ?)`)
  putBudget.run('scan.compose_files', 8, null, at(6))
  putBudget.run('dockerhub.pulls', 180, '200;w=21600', at(6))

  // 10. The log, oldest first, each line backdated after it is written.
  const backdate = db.prepare(`UPDATE events SET at = ?, last_at = NULL WHERE id = (SELECT MAX(id) FROM events)`)
  const LOG: [number, 'info' | 'warn' | 'error', EventKind, string | null, string | null, string, string | null][] = [
    [432, 'info', 'ship', 'vaultwarden', 'vaultwarden', 'shipped vaultwarden 1.32.3 -> 1.32.4', null],
    [264, 'info', 'deploy', 'immich', 'immich-server', 'deploy verified', 'immich-server v1.120.2'],
    [96, 'info', 'deploy', 'nextcloud', 'app', 'left stopped: nextcloud was not running', 'the compose file now carries 30.0.4-apache'],
    [27, 'info', 'ship', 'jellyfin', 'jellyfin', 'shipped jellyfin 10.9.11 -> 10.10.3', null],
    [26, 'info', 'deploy', 'jellyfin', 'jellyfin', 'deploy verified', 'jellyfin 10.10.3'],
    [20, 'info', 'analysis', 'immich', 'immich-server', 'reviewed: Breaking changes, high confidence', null],
    [19, 'info', 'analysis', 'nextcloud', 'db', 'reviewed: Read first, high confidence', null],
    [6, 'info', 'ship', 'monitoring', 'uptime-kuma', 'shipped uptime-kuma 1.23.15 -> 1.23.16', null],
    [6, 'info', 'scan', null, null, 'scan complete (cron)', '4 update(s), 1 rolling image(s) moved in 41s'],
    [5.5, 'error', 'deploy', 'monitoring', 'uptime-kuma', 'deploy failed: rolled back', 'the health check failed within the verify window; 1.23.15 was put back'],
    [3, 'warn', 'scan', 'monitoring', 'homepage', 'image is set by a variable, so it cannot be watched', null],
    [1, 'info', 'sync', null, null, 'checkout fast-forwarded', '2 commits'],
    [0.5, 'info', 'ship', 'paperless', 'broker', 'shipped redis 7.4.1-alpine -> 7.4.2-alpine', null],
    [0.4, 'info', 'deploy', 'paperless', 'broker', 'deployed; soaking', 'verified in 20 minutes'],
  ]
  for (const [h, level, kind, stack, service, message, detail] of LOG) {
    logEvent({ level, kind, stack: stack ?? undefined, service: service ?? undefined, message, detail: detail ?? undefined })
    backdate.run(at(h))
  }

  return { updates: UPDATES.length, events: LOG.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const r = seedDemo()
    console.log(`seeded ${r.updates} updates and ${r.events} log lines into ${paths.db}`)
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }
}
