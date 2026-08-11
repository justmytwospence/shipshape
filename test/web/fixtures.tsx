import { loadPolicy, type Policy } from '../../src/config.ts'
import { Layout } from '../../src/web/views/layout.tsx'
import { Dashboard, PendingSections, ScanStatus, type PendingRow } from '../../src/web/views/dashboard.tsx'
import { ImagesPage, ImagesTable, ImageRow } from '../../src/web/views/images.tsx'
import { ActivityPage, ActivityTable } from '../../src/web/views/activity.tsx'
import { SettingsPage, SettingsForm, PromptEditorFragment, DigestPreview, RawPolicy } from '../../src/web/views/settings.tsx'
import { SystemPage } from '../../src/web/views/system.tsx'
import { DiffView, DetailPanel } from '../../src/web/views/diff.tsx'
import type { ScannedService } from '../../src/compose/scan.ts'

/**
 * Rendering every view without a database, a token, or a network.
 *
 * hono/jsx components are plain functions returning a stringifiable object, so the whole
 * UI can be asserted on structurally. That is the point of this file: the app's
 * behaviour is carried by htmx attributes and by markup shape -- a `<tr>` that stops
 * being a `<tr>`, a `<details>` that becomes a div -- and none of that is visible to
 * the type checker or to any test that only exercises the server.
 */

/** Defaults, via the same path the app uses when policy.yaml is absent. */
export const POLICY: Policy = loadPolicy().policy

export const SERVICE: ScannedService = {
  stack: 'demo',
  service: 'svc',
  composeFile: 'demo/docker-compose.yaml',
  imageRaw: 'nginx:1.0.0',
  ref: { registry: 'docker.io', repository: 'library/nginx', tag: '1.0.0', digest: null, raw: 'nginx:1.0.0' },
  labels: {},
  profiles: [],
  hasBuild: false,
  watched: true,
  unwatchable: null,
  pattern: 'semver',
  tagInclude: null,
  policyLabel: null,
  sourceLabel: null,
  claudeLabel: null,
  deployLabel: null,
  probePort: null,
  archivePre: null,
  networkMode: null,
  prLabel: null,
  proposeLabel: null,
  groupLabel: null,
  wud: { watch: null, tagInclude: null, gated: false, link: null },
}

export const PENDING: PendingRow[] = [
  {
    id: 1, stack: 'demo', service: 'svc', image: 'nginx:1.0.0',
    from_tag: '1.0.0', to_tag: '1.1.0', magnitude: 'minor', tier: 'manual',
    state: 'pr_open', detail: null, pr_number: 7,
    recommendation: 'approve', confidence: 'high', pr_scope: 'tag-only',
  },
  {
    id: 2, stack: 'db', service: 'postgres', image: 'postgres:16',
    from_tag: '16', to_tag: '17', magnitude: 'major', tier: 'held',
    state: 'held', detail: null, pr_number: null,
    recommendation: null, confidence: null, pr_scope: null,
  },
  {
    id: 3, stack: 'roll', service: 'latest-svc', image: 'x:latest',
    from_tag: 'latest@aaa', to_tag: 'latest@bbb', magnitude: 'digest', tier: 'manual',
    state: 'detected', detail: 'rolling', pr_number: null,
    recommendation: null, confidence: null, pr_scope: null,
  },
]

const SCAN_IDLE = { lastAt: '2026-08-04T03:00:00.000Z', durationS: 12, counts: { update: 1 }, running: false }
const SCAN_RUNNING = { lastAt: null, durationS: null, counts: null, running: true }

/**
 * Every view, rendered. Keyed so a failure names the page.
 *
 * `running` renders the scanning variant of anything that has one -- that is the state
 * the `#scan-running` id contract lives in, and it is invisible at rest.
 */
export function renderAll(opts: { running?: boolean } = {}): Record<string, string> {
  const scan = opts.running ? SCAN_RUNNING : SCAN_IDLE
  const statusMap = new Map()
  return {
    layout: String(Layout({ title: 'T', path: '/', children: 'body' })),
    'layout-setup': String(
      Layout({ title: 'T', path: '/', missing: [{ name: 'REPO_DIR', why: 'because' }], children: 'x' }),
    ),
    dashboard: String(
      Dashboard({
        policy: POLICY, services: [SERVICE], pending: PENDING,
        recent: [{ at: '2026-08-04T03:00:00Z', kind: 'scan', message: 'scan complete' }],
        blackout: false, scan, repo: 'o/r',
      }),
    ),
    pending: String(PendingSections({ pending: PENDING, repo: 'o/r' })),
    // The bucket that carries a row action, which the default one does not.
    'pending-held': String(PendingSections({ pending: PENDING, repo: 'o/r', bucket: 'held' })),
    'detail-panel': String(
      DetailPanel({
        row: {
          stack: 'demo', service: 'svc', from_tag: '1.0.0', to_tag: '1.1.0',
          magnitude: 'minor', tier: 'manual', state: 'pr_open',
          recommendation: 'approve', confidence: 'high', pr_number: 7, pr_scope: 'tag-only',
        },
        repo: 'o/r',
        diff: '<div class="diff">stub</div>',
      }),
    ),
    'scan-status': String(ScanStatus({ scan })),
    images: String(ImagesPage({ services: [SERVICE], filter: 'all', q: '', grouped: false, statusMap })),
    'images-grouped': String(ImagesPage({ services: [SERVICE], filter: 'all', q: '', grouped: true, statusMap })),
    'images-table': String(ImagesTable({ services: [SERVICE], statusMap })),
    'image-row': String(ImageRow({ svc: SERVICE })),
    activity: String(
      ActivityPage({
        rows: [{ at: '2026-08-04T03:00:00Z', kind: 'pr', level: 'info', message: 'opened #7', stack: 'demo', service: 'svc', detail: null }],
        filter: { kind: 'all', level: 'all' }, repo: 'o/r',
      }),
    ),
    'activity-table': String(ActivityTable({ rows: [], repo: 'o/r' })),
    settings: String(
      SettingsPage({ policy: POLICY, models: ['claude-x'], prompts: PROMPTS, repo: 'o/r' }),
    ),
    'settings-form': String(SettingsForm({ policy: POLICY, models: [] })),
    'prompt-fragment': String(PromptEditorFragment({ state: PROMPTS[0]! })),
    'digest-preview': String(
      DigestPreview({
        rows: [{ at: '2026-08-04T03:00:00Z' }],
        message: { title: 't', body: 'b' },
        policy: POLICY,
        channels: { alert: ['ntfy'], routine: ['email'] },
        emailConfigured: true,
      }),
    ),
    'digest-empty': String(
      DigestPreview({
        rows: [], message: null, policy: POLICY,
        channels: { alert: [], routine: [] }, emailConfigured: false,
      }),
    ),
    'raw-policy': String(RawPolicy({ text: 'merge_method: squash' })),
    system: String(
      SystemPage({
        policy: POLICY, budgets: [], version: '0.1.0', blackout: false, scan,
        spend: [{ model: 'm', purpose: 'verdict', calls: 2, cost: 0.5, tokens_in: 1000, tokens_out: 100, cached: 500 }],
        deploys: [
          { stack: 'demo', services: 'svc', strategy: 'up', ok: 0, healthy: 0, detail: 'boom', created_at: '2026-08-04T03:00:00Z' },
          // Started but not healthy -- the outcome that looks fine and is not.
          { stack: 'demo', services: 'svc2', strategy: 'rm-first', ok: 1, healthy: 0, detail: 'restart loop', created_at: '2026-08-04T03:01:00Z' },
          { stack: 'demo', services: 'svc3', strategy: 'up', ok: 1, healthy: 1, detail: 'up in 4s', created_at: '2026-08-04T03:02:00Z' },
        ],
        modelTier: [],
      }),
    ),
    diff: String(
      DiffView({
        result: {
          hunks: [{ file: 'demo/docker-compose.yaml', header: '@@ -1 +1 @@', lines: [
            { kind: 'ctx', no: 1, text: 'services:' },
            { kind: 'del', no: 2, text: '  image: nginx:1.0.0' },
            { kind: 'add', no: null, text: '  image: nginx:1.1.0' },
          ] }],
        },
        prNumber: 7, prUrl: 'https://x/7', prScope: 'tag-only', canPropose: true,
      }),
    ),
  }
}

const PROMPTS = [
  { name: 'verdict' as const, body: 'you are a reviewer', customised: false },
  { name: 'proposal' as const, body: 'you are an editor', customised: true },
]

/** Every `class="..."` value in a document, in order. The Stage 1 identity gate. */
export function classesOf(html: string): string[] {
  return [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]!)
}
