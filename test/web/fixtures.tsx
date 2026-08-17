import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { InboxBody } from '../../src/web/views/ui/inbox.tsx'
import { UpdateCard, UpdateDetail, UpdateRow } from '../../src/web/views/ui/update.tsx'
import { ServiceDetail, ServicesList } from '../../src/web/views/ui/services.tsx'
import { ActivityList } from '../../src/web/views/ui/activity.tsx'
import { SettingsForm, StatusBody } from '../../src/web/views/ui/settings.tsx'
import { Docs } from '../../src/web/views/ui/docs.tsx'
import { Layout } from '../../src/web/views/ui/shell.tsx'
import { InboxPage, UpdatePage } from '../../src/web/views/pages.tsx'
import type { UpdateView, Milestone } from '../../src/updates/queries.ts'

/**
 * Every view, rendered without a database, a token or a network.
 *
 * hono/jsx components are plain functions returning something stringifiable, so the
 * tests call them directly. The fixtures below cover the states that are easy to get
 * wrong precisely because they are rare: a review that failed, a deploy in flight, an
 * update nobody can act on any more.
 */

const now = new Date().toISOString()
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()

export function update(over: Partial<UpdateView> = {}): UpdateView {
  return {
    id: 7,
    stack: 'media',
    service: 'jellyfin',
    image: 'jellyfin/jellyfin',
    fromTag: '10.9.11',
    toTag: '10.10.3',
    magnitude: 'minor',
    tier: 'manual',
    state: 'pr_open',
    detail: null,
    rolling: false,
    detectedAt: ago(30),
    updatedAt: ago(2),
    ackedAt: null,
    pr: {
      number: 41,
      state: 'open',
      scope: 'tag-only',
      userOwned: false,
      mergeCommitSha: null,
      url: 'https://github.com/you/repo/pull/41',
    },
    verdict: {
      recommendation: 'caution',
      confidence: 'medium',
      severity: 'medium',
      summary: 'Transcoding defaults changed; hardware acceleration must be re-selected.',
      breakingChanges: ['The `hwaccel` config key was renamed'],
      migrationSteps: ['Re-select the hardware acceleration device after upgrading'],
      sources: ['https://github.com/jellyfin/jellyfin/releases/tag/v10.10.3'],
      model: 'claude-haiku-4-5',
      createdAt: ago(20),
      error: null,
      attempts: 0,
      nextAttemptAt: null,
    },
    deploy: null,
    actions: ['merge-deploy', 'propose', 'skip'],
    primary: 'merge-deploy',
    transient: false,
    ...over,
  }
}

export const UPDATES: Record<string, UpdateView> = {
  waiting: update(),
  held: update({
    id: 8,
    state: 'held',
    service: 'postgres',
    magnitude: 'major',
    pr: null,
    verdict: null,
    actions: ['open-pr', 'skip'],
    primary: 'open-pr',
  }),
  rolling: update({
    id: 9,
    state: 'detected',
    detail: 'rolling',
    rolling: true,
    service: 'actual',
    magnitude: 'digest',
    pr: null,
    verdict: null,
    actions: ['redeploy', 'skip'],
    primary: 'redeploy',
  }),
  ready: update({
    id: 10,
    state: 'merged',
    deploy: {
      id: 3,
      status: 'ready',
      trigger: 'queue',
      startedAt: null,
      finishedAt: null,
      recheckAt: null,
      detail: null,
    },
    actions: ['deploy'],
    primary: 'deploy',
  }),
  deploying: update({
    id: 11,
    state: 'deploying',
    deploy: {
      id: 4,
      status: 'running',
      trigger: 'operator',
      startedAt: now,
      finishedAt: null,
      recheckAt: null,
      detail: null,
    },
    actions: [],
    primary: null,
    transient: true,
  }),
  reviewFailed: update({
    id: 12,
    verdict: {
      recommendation: null,
      confidence: null,
      severity: null,
      summary: null,
      breakingChanges: [],
      migrationSteps: [],
      sources: [],
      model: null,
      createdAt: ago(4),
      error: 'the changelog could not be fetched (404)',
      attempts: 3,
      nextAttemptAt: new Date(Date.now() + 3600_000).toISOString(),
    },
    actions: ['rerun-review', 'merge-deploy', 'skip'],
    primary: 'rerun-review',
  }),
  verified: update({
    id: 13,
    state: 'verified',
    pr: {
      number: 22,
      state: 'merged',
      scope: 'tag-only',
      userOwned: false,
      mergeCommitSha: 'abc1234',
      url: 'https://github.com/you/repo/pull/22',
    },
    deploy: {
      id: 5,
      status: 'verified',
      trigger: 'queue',
      startedAt: ago(3),
      finishedAt: ago(2),
      recheckAt: null,
      detail: 'jellyfin up in 14s',
    },
    actions: ['rollback'],
    primary: 'rollback',
  }),
}

export const MILESTONES: Milestone[] = [
  { at: ago(30), kind: 'detected', label: 'minor update detected', detail: '10.9.11 → 10.10.3' },
  { at: ago(29), kind: 'pr', label: 'pull request #41 opened' },
  {
    at: ago(20),
    kind: 'review',
    label: 'reviewed: caution at medium confidence',
    detail: 'Transcoding defaults changed.',
  },
  { at: null, kind: 'verified', label: 'verified, if it is still healthy', future: true },
]

const SERVICE = {
  stack: 'media',
  service: 'jellyfin',
  image: 'jellyfin/jellyfin',
  tag: '10.9.11',
  watched: true,
  unwatchable: null,
  lastStatus: null,
  lastDetail: null,
  constrainedFrom: null,
  lastSeenAt: ago(6),
}

const CHROME = { paused: true, missing: [] }

const SETTING_GROUPS = [
  {
    title: 'Update policy',
    blurb: 'How much happens without you.',
    items: [
      {
        def: {
          path: 'defaults.patch',
          kind: 'enum' as const,
          label: 'Patch',
          help: 'x.y.Z',
          options: ['auto', 'manual', 'on-request', 'skip'],
          defaultValue: 'auto',
          section: 'Update policy' as never,
        },
        value: 'auto',
        changed: false,
      },
      {
        def: {
          path: 'paused',
          kind: 'bool' as const,
          label: 'Pause',
          help: 'nothing merges or deploys on its own',
          defaultValue: 'true',
          section: 'Merging' as never,
        },
        value: 'true',
        changed: false,
      },
    ],
  },
]

const STATUS = {
  version: '0.1.0',
  repoDir: '/srv/compose',
  repo: 'you/repo',
  mergeMethod: 'squash',
  pushMain: true,
  blackout: ['00:45-02:30'],
  scan: { cron: '0 0 3 * * *', lastAt: ago(9), nextAt: null, durationS: 156 },
  digest: { cron: '0 0 8 * * *', nextAt: null },
  credentials: [{ name: 'GITHUB_TOKEN', state: 'set' as const }],
  spend: [{ model: 'claude-haiku-4-5', purpose: 'verdict', calls: 34, cost: 3.63 }],
  budgetUsd: 10,
  spentUsd: 8.03,
  deploys: [
    { at: ago(2), stack: 'media', services: 'jellyfin', status: 'verified', trigger: 'queue' },
  ],
  budgets: [{ key: 'dockerhub.pulls', value: 200, window: '200;w=3600' }],
}

const ACTIVITY = [
  {
    id: 1,
    at: ago(26),
    lastAt: ago(2),
    count: 14,
    level: 'warn' as const,
    kind: 'analysis',
    stack: 'media',
    service: 'jellyfin',
    message: 'changelog analysis failed',
    detail: '404 fetching the changelog',
  },
  {
    id: 2,
    at: ago(3),
    lastAt: null,
    count: 1,
    level: 'info' as const,
    kind: 'pr',
    stack: null,
    service: null,
    message: 'opened #41: jellyfin 10.9.11 -> 10.10.3',
    detail: null,
  },
]

const INBOX = {
  needsYou: [
    { kind: 'pr-waiting' as const, update: UPDATES.waiting! },
    { kind: 'on-request' as const, update: UPDATES.held! },
    { kind: 'rolling-moved' as const, update: UPDATES.rolling! },
    { kind: 'ready-to-deploy' as const, update: UPDATES.ready! },
    { kind: 'review-failed' as const, update: UPDATES.reviewFailed! },
  ],
  recent: [
    {
      at: ago(1),
      kind: 'verified' as const,
      stack: 'media',
      service: 'jellyfin',
      fromTag: '10.9.10',
      toTag: '10.9.11',
      updateId: 13,
      prNumber: 22,
      detail: null,
    },
  ],
  parked: [UPDATES.waiting!],
  scan: { lastAt: Date.now() - 9 * 3600_000, nextAt: null, running: false, watched: 118 },
}

/** Every view, keyed, for the tests that sweep across all of them. */
export function renderAll(opts: { running?: boolean } = {}): Record<string, string> {
  const scan = { ...INBOX.scan, running: !!opts.running }
  const inbox = { ...INBOX, scan }
  return {
    'inbox-page': String(InboxPage({ data: inbox, chrome: CHROME })),
    inbox: String(InboxBody({ data: inbox })),
    'update-page': String(
      UpdatePage({
        update: UPDATES.waiting!,
        milestones: MILESTONES,
        warnings: ['the changelog review returned caution'],
        chrome: CHROME,
      }),
    ),
    'update-detail': String(
      UpdateDetail({ update: UPDATES.waiting!, milestones: MILESTONES, warnings: [] }),
    ),
    'update-card': String(UpdateCard({ update: UPDATES.waiting! })),
    'update-card-transient': String(UpdateCard({ update: UPDATES.deploying! })),
    'update-row': `<table><tbody>${String(UpdateRow({ update: UPDATES.waiting! }))}</tbody></table>`,
    'update-verified': String(
      UpdateDetail({ update: UPDATES.verified!, milestones: MILESTONES }),
    ),
    'update-review-failed': String(
      UpdateDetail({ update: UPDATES.reviewFailed!, milestones: MILESTONES }),
    ),
    services: String(ServicesList({ services: [SERVICE], grouped: false })),
    'services-grouped': String(ServicesList({ services: [SERVICE], grouped: true })),
    'service-detail': String(
      ServiceDetail({
        data: {
          svc: SERVICE,
          composeFile: 'media/docker-compose.yaml',
          config: [
            { key: 'policy', value: 'manual', source: 'label' },
            { key: 'major', value: 'manual', source: 'locked' },
            { key: 'pattern', value: 'semver', source: 'inferred' },
          ],
          history: [UPDATES.waiting!],
          canEdit: true,
        },
      }),
    ),
    activity: String(ActivityList({ rows: ACTIVITY, repo: 'you/repo', more: null })),
    settings: String(SettingsForm({ groups: SETTING_GROUPS, readyCount: 2 })),
    status: String(StatusBody({ data: STATUS })),
    docs: String(Docs({})),
    layout: String(Layout({ title: 'Inbox', nav: 'inbox', paused: true, children: 'x' })),
    'layout-setup': String(
      Layout({
        title: 'Inbox',
        nav: 'inbox',
        missing: [{ name: 'REPO_DIR', why: 'the checkout to watch' }],
        children: 'x',
      }),
    ),
  }
}

/** Every class any view emits, for the gate that checks they all exist in the CSS. */
export function classesOf(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    out.push(...m[1]!.split(/\s+/).filter(Boolean))
  }
  return out
}

export function builtCss(): string {
  return readFileSync(join(process.cwd(), 'public', 'app.css'), 'utf8')
}
