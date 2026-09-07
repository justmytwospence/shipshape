import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { InboxAside, InboxList } from '../../src/web/views/ui/inbox.tsx'
import { UpdateDetail, UpdateRow } from '../../src/web/views/ui/update.tsx'
import { ServiceDetail, ServicesList } from '../../src/web/views/ui/services.tsx'
import { ActivityList } from '../../src/web/views/ui/activity.tsx'
import { SettingsForm } from '../../src/web/views/ui/settings.tsx'
import { StatusBody } from '../../src/web/views/ui/status.tsx'
import { Layout } from '../../src/web/views/ui/shell.tsx'
import {
  ActivityPage,
  InboxPage,
  ServicesPage,
  SettingsPage,
  StatusPage,
  UpdatesPage,
} from '../../src/web/views/pages.tsx'
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
  policy: 'manual',
}

const CHROME = {
  paused: true,
  missing: [],
  counts: { inbox: 5, updates: 12, attention: 2 },
  scan: { lastAt: ago(9), nextAt: null, running: false },
}

const SETTING_GROUPS = [
  {
    title: 'Update policy',
    prose: [
      'One axis — how much happens without you — answered by default from how large the version jump is.',
      'Majors and digest moves always wait for a person, whatever these say.',
    ],
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

export const STATUS = {
  version: '0.1.0',
  repoDir: '/srv/compose',
  repo: 'you/repo',
  mergeMethod: 'squash',
  pushMain: true,
  blackout: ['00:45-02:30'],
  scan: {
    cron: '0 0 3 * * *',
    lastAt: ago(9),
    nextAt: null,
    durationS: 156,
    counts: { 'up-to-date': 62, unchanged: 45, update: 3, error: 4 },
  },
  digest: { cron: '0 0 8 * * *', nextAt: null },
  // `refused` is rendered here so the class gate covers its badge: it is the state the
  // page could not show through a six-day outage, when a dead token still read `set`.
  credentials: [
    { name: 'GITHUB_TOKEN', state: 'set' as const },
    { name: 'ANTHROPIC_API_KEY', state: 'refused' as const },
  ],
  spend: [{ model: 'claude-haiku-4-5', purpose: 'verdict', calls: 34, cost: 3.63 }],
  budgetUsd: 10,
  spentUsd: 8.03,
  deploys: [
    { at: ago(2), stack: 'media', services: 'jellyfin', status: 'verified', trigger: 'queue' },
  ],
  // Every key the real table holds, so the filter that drops the ones stated in words
  // elsewhere on the page is actually exercised rather than assumed.
  budgets: [
    { key: 'claude.spend_usd', value: 8.03, window: '2026-08' },
    { key: 'dockerhub.pulls', value: 180, window: '200;w=3600' },
    { key: 'scan.last_at', value: 1787389349759, window: '2026-08-22T09:02:29.759Z' },
    { key: 'scan.last_counts', value: 118, window: '{"up-to-date":62,"unchanged":45}' },
    { key: 'scan.last_duration_s', value: 156, window: null },
  ],
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
  // The frame's own copy of the clock: the sidebar's chip is the poll's on-switch.
  const CH = { ...CHROME, scan: { ...CHROME.scan, running: !!opts.running } }
  const list = [UPDATES.waiting!, UPDATES.held!, UPDATES.ready!]
  const detail = (u: UpdateView, ctx: string, listHref: string, warnings: string[] = []) =>
    UpdateDetail({ update: u, milestones: MILESTONES, warnings, ctx, listHref })
  const serviceData = {
    svc: SERVICE,
    composeFile: 'media/docker-compose.yaml',
    config: [
      { key: 'policy', value: 'manual', source: 'label' as const },
      { key: 'major', value: 'manual', source: 'locked' as const },
      { key: 'pattern', value: 'semver', source: 'inferred' as const },
    ],
    history: [UPDATES.waiting!],
    canEdit: true,
  }
  return {
    // pages
    'inbox-page': String(InboxPage({ data: inbox, chrome: CH })),
    'inbox-detail-page': String(
      InboxPage({
        data: inbox,
        chrome: CH,
        selectedId: 7,
        detail: {
          pane: detail(UPDATES.waiting!, 'list=inbox', '/'),
          title: 'jellyfin',
          back: { href: '/', label: 'Inbox' },
        },
      }),
    ),
    'updates-page': String(
      UpdatesPage({
        updates: list,
        stage: 'open',
        q: '',
        magnitude: 'all',
        ctx: 'list=updates&stage=open',
        chrome: CH,
      }),
    ),
    'update-page': String(
      UpdatesPage({
        updates: list,
        stage: 'open',
        q: '',
        magnitude: 'all',
        ctx: 'list=updates&stage=open',
        chrome: CH,
        selectedId: 7,
        detail: {
          pane: detail(UPDATES.waiting!, 'list=updates&stage=open', '/updates', [
            'the changelog review returned caution',
          ]),
          title: 'jellyfin',
          back: { href: '/updates', label: 'Updates' },
        },
      }),
    ),
    'services-page': String(
      ServicesPage({
        services: [SERVICE],
        filter: 'all',
        q: '',
        grouped: false,
        ctx: 'list=services',
        chrome: CH,
      }),
    ),
    'service-page': String(
      ServicesPage({
        services: [SERVICE],
        filter: 'all',
        q: '',
        grouped: false,
        ctx: 'list=services',
        chrome: CH,
        selected: { stack: 'media', service: 'jellyfin' },
        detail: {
          pane: ServiceDetail({ data: serviceData, ctx: 'list=services', listHref: '/services' }),
          title: 'jellyfin',
          back: { href: '/services', label: 'Services' },
        },
      }),
    ),
    'activity-page': String(
      ActivityPage({
        rows: ACTIVITY,
        repo: 'you/repo',
        kind: 'all',
        problems: false,
        q: '',
        more: null,
        chrome: CH,
      }),
    ),
    'settings-page': String(
      SettingsPage({ tab: 'general', groups: SETTING_GROUPS, readyCount: 2, chrome: CH }),
    ),
    'status-page': String(StatusPage({ data: STATUS, chrome: CH })),
    // fragments
    inbox: String(InboxList({ data: inbox })),
    'inbox-aside': String(InboxAside({ data: inbox })),
    'update-detail': String(detail(UPDATES.waiting!, 'list=updates&stage=open', '/updates')),
    'update-row': String(UpdateRow({ update: UPDATES.waiting!, ctx: 'list=inbox' })),
    'update-row-transient': String(UpdateRow({ update: UPDATES.deploying!, ctx: 'list=inbox' })),
    'update-row-stage': String(
      UpdateRow({ update: UPDATES.ready!, ctx: 'list=updates&stage=open', showStage: true }),
    ),
    'update-verified': String(detail(UPDATES.verified!, 'list=updates&stage=done', '/updates')),
    'update-review-failed': String(
      detail(UPDATES.reviewFailed!, 'list=updates&stage=open', '/updates'),
    ),
    services: String(ServicesList({ services: [SERVICE], grouped: false, ctx: 'list=services' })),
    'services-grouped': String(
      ServicesList({ services: [SERVICE], grouped: true, ctx: 'list=services&group=stack' }),
    ),
    'service-detail': String(
      ServiceDetail({ data: serviceData, ctx: 'list=services', listHref: '/services' }),
    ),
    activity: String(ActivityList({ rows: ACTIVITY, repo: 'you/repo', more: null })),
    settings: String(SettingsForm({ groups: SETTING_GROUPS, readyCount: 2 })),
    status: String(StatusBody({ data: STATUS })),
    layout: String(Layout({ title: 'Inbox', nav: 'inbox', chrome: CH, children: 'x' })),
    'layout-setup': String(
      Layout({
        title: 'Inbox',
        nav: 'inbox',
        chrome: {
          paused: false,
          missing: [{ name: 'REPO_DIR', why: 'the checkout to watch' }],
        },
        children: 'x',
      }),
    ),
  }
}

/** Every class any view emits, for the gate that checks they all exist in the CSS. */
export function classesOf(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    // The renderer escapes the attribute; a `[&::-webkit-details-marker]` variant comes
    // back with `&amp;` in it, and the stylesheet knows it by the bare character.
    const raw = m[1]!.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    out.push(...raw.split(/\s+/).filter(Boolean))
  }
  return out
}

export function builtCss(): string {
  return readFileSync(join(process.cwd(), 'public', 'app.css'), 'utf8')
}
