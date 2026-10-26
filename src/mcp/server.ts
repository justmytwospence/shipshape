import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { logEvent } from '../db.ts'
import { buildUpdateDiff } from '../diff.ts'
import { isScanning } from '../scan.ts'
import { runScanNow } from '../scheduler.ts'
import { actionsFor } from '../updates/actions.ts'
import { isOperatorVerb, OPERATOR_VERBS, runOperatorVerb } from '../updates/operator-verbs.ts'
import {
  inboxNeedsYou,
  inboxParked,
  inboxRecent,
  listUpdates,
  STAGE_FILTERS,
  updateTimeline,
  updateView,
} from '../updates/queries.ts'
import { filterServices, serviceDetail, serviceRows } from '../updates/services.ts'
import { runStackVerb, STACK_VERBS } from '../updates/stack-verbs.ts'
import { contextFor, type VerbResult } from '../updates/verbs.ts'
import { activityRows, checkService, scanInfo } from '../web/server.ts'
import { KINDS as ACTIVITY_KINDS } from '../web/views/ui/activity.tsx'
import { version } from '../web/version.ts'
import { exposureViews, findPackage, incidentViews } from '../security/queries.ts'
import { securityStatus } from '../security/loop.ts'
import { apiUsage, registerContext, USAGE } from './context.ts'

/**
 * Shipshape for agents: the dashboard's reads and the operator's verbs, over MCP.
 *
 * Authority is not decided here. Every write goes through the same dispatcher as the
 * dashboard and the alert cards (`runOperatorVerb`, `runStackVerb`), which checks
 * `actionsFor` first, so an agent can do exactly what a button would let you do at that
 * moment and nothing else. Settings, labels, pause and force-merge are not offered.
 * The gate in front of it is the OAuth sidecar; this listener has no auth of its own and
 * must only be reachable from that sidecar.
 */

const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  // Keep the existing text shape; MCP structured content must be an object.
  structuredContent: value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : { data: value },
})

const verbReply = (r: VerbResult) => ({ ...json(r), isError: !r.ok })

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

function logged(message: string, r: VerbResult, where: { stack?: string; service?: string } = {}): VerbResult {
  logEvent({ level: r.ok ? 'info' : 'warn', kind: 'pr', ...where, message, detail: r.message })
  return r
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'shipshape', version: version() },
    {
      instructions:
        'Shipshape keeps the homelab\'s container images up to date: it scans registries, opens a pull ' +
        'request per update, has the changelog reviewed, merges what policy allows, deploys, verifies and ' +
        'rolls back. Start with `inbox` for what is waiting on a decision. `get_update` lists the verbs ' +
        'allowed on an update right now (`allowed_verbs`); `update_action` accepts only those. Deploys run ' +
        'in the background: an action returns once started, and `get_update` shows how it went. ' + USAGE,
    },
  )

  registerContext(server)
  server.registerTool('api_usage', {
    title: 'API usage and limits', description: 'Zero-call local budget observations, timestamps and safe-use guidance. Unknown quota is not a remaining allowance.',
    inputSchema: z.object({}), annotations: READ,
    outputSchema: z.object({ observed_at: z.string(), source: z.string(), docker_hub: z.object({}).passthrough(), github: z.object({}).passthrough(), model_budget: z.object({}).passthrough(), guidance: z.string() }),
  }, async () => json(apiUsage()))

  server.registerTool(
    'inbox',
    {
      title: 'Inbox',
      description:
        'What is waiting on a decision (needs_you), what is parked on request (parked), and what happened recently (recent).',
      inputSchema: z.object({ recent_hours: z.number().int().min(1).max(24 * 14).optional() }),
      annotations: READ,
    },
    async ({ recent_hours }) =>
      json({ needs_you: inboxNeedsYou(), parked: inboxParked(), recent: inboxRecent(recent_hours ?? 24) }),
  )

  server.registerTool(
    'list_updates',
    {
      title: 'List updates',
      description:
        'Updates by stage: open (detected, held, PR open, merged), rolling (deploying, deployed), done, closed, all, or releases (newest first).',
      inputSchema: z.object({
        stage: z.enum([...(Object.keys(STAGE_FILTERS) as (keyof typeof STAGE_FILTERS)[]), 'all', 'releases']).optional(),
        q: z.string().optional().describe('Matches stack, service or image.'),
        magnitude: z.enum(['major', 'minor', 'patch', 'digest', 'all']).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
      annotations: READ,
    },
    async (args) => json(listUpdates({ ...args, limit: args.limit ?? 50 })),
  )

  server.registerTool(
    'get_update',
    {
      title: 'Get update',
      description:
        'One update: its state, review verdict, pull request, timeline, the compose diff it makes, and allowed_verbs -- what update_action may do to it right now.',
      inputSchema: z.object({ id: z.number().int().positive() }),
      annotations: READ,
    },
    async ({ id }) => {
      const view = updateView(id)
      if (!view) return { ...json({ error: `no update ${id}` }), isError: true }
      const found = contextFor(id)
      const allowed = found ? actionsFor(found.ctx).filter(isOperatorVerb) : []
      return json({ ...view, allowed_verbs: allowed, timeline: updateTimeline(id), diff: buildUpdateDiff(id) })
    },
  )

  server.registerTool(
    'list_services',
    {
      title: 'List services',
      description:
        'Every service in the compose files with its watch state: watched, unlabelled, unwatchable (and why), unlinked (no certain upstream), or attention (errors, tag filters suppressing a release).',
      inputSchema: z.object({
        filter: z.enum(['all', 'watched', 'unlabelled', 'unwatchable', 'unlinked', 'attention']).optional(),
        q: z.string().optional().describe('Matches stack, service or image.'),
      }),
      annotations: READ,
    },
    async (args) => json(filterServices(serviceRows(), args)),
  )

  server.registerTool(
    'get_service',
    {
      title: 'Get service',
      description:
        'One service: labels as read from git, watched/unwatchable, fork state, label problems, upstream source and its updates.',
      inputSchema: z.object({ stack: z.string(), service: z.string() }),
      annotations: READ,
    },
    async ({ stack, service }) => {
      const d = serviceDetail(stack, service)
      return d ? json(d) : { ...json({ error: `no service ${stack}/${service}` }), isError: true }
    },
  )

  server.registerTool(
    'activity',
    {
      title: 'Activity',
      description: 'The activity log, newest first.',
      inputSchema: z.object({
        kind: z.enum(['all', ...ACTIVITY_KINDS]).optional(),
        problems: z.boolean().optional().describe('Only warnings and errors.'),
        q: z.string().optional().describe('Matches message, detail or stack.'),
        limit: z.number().int().min(1).max(500).optional(),
      }),
      annotations: READ,
    },
    async (a) => json(activityRows({ kind: a.kind ?? 'all', problems: a.problems ?? false, q: a.q ?? '', limit: a.limit ?? 50 })),
  )

  server.registerTool(
    'scan_status',
    {
      title: 'Scan status',
      description: 'Whether a scan is running, when the last one finished, how long it took and what it found.',
      inputSchema: z.object({}),
      annotations: READ,
    },
    async () => json(scanInfo()),
  )

  server.registerTool(
    'scan_now',
    {
      title: 'Scan now',
      description:
        'Scan every service now (labels from git, registries, upstream sources) instead of waiting for the nightly scan. Runs in the background for a few minutes; poll scan_status.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async () => {
      if (isScanning()) return verbReply({ ok: true, message: 'A scan is already running.' })
      void runScanNow().catch(() => {})
      return verbReply(logged('scan requested via MCP', { ok: true, message: 'Scanning. Poll scan_status for the result.' }))
    },
  )

  server.registerTool(
    'check_service',
    {
      title: 'Check service',
      description: 'Re-check one service now: its labels from git, its upstream, and its registry. Returns the service afterwards.',
      inputSchema: z.object({ stack: z.string(), service: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ stack, service }) => {
      if (!(await checkService(stack, service))) {
        return { ...json({ error: `no service ${stack}/${service} in the compose files` }), isError: true }
      }
      return json(serviceDetail(stack, service))
    },
  )

  server.registerTool(
    'update_action',
    {
      title: 'Act on an update',
      description:
        'Apply an operator verb to one update, exactly as the dashboard button would; refused (with the reason) when the verb is not in its allowed_verbs. ' +
        'merge-deploy squash-merges its pull request and the deploy follows; open-pr asks for a pull request for a held update; deploy brings up a merge waiting to be deployed; ' +
        'redeploy pulls a moved rolling tag; retry goes round again after a failure; rollback puts the previous version back; rerun-review reads the changelog again; ' +
        'propose drafts the config changes the update needs onto its pull request; skip dismisses this version for good; release-hold lets a held pull request go; ack marks it seen. ' +
        'Deploys run in the background: follow up with get_update.',
      inputSchema: z.object({ id: z.number().int().positive(), verb: z.enum(OPERATOR_VERBS) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ id, verb }) => {
      const found = contextFor(id)
      const r = await runOperatorVerb(id, verb)
      return verbReply(
        logged(`${verb} on update ${id} requested via MCP`, r, found ? { stack: found.row.stack, service: found.row.service } : {}),
      )
    },
  )

  server.registerTool(
    'stack_action',
    {
      title: 'Act on a stack\'s last deploy',
      description:
        'retry or rollback the newest deploy of a stack, as an alert card would; refused (with the reason) when that deploy does not allow it.',
      inputSchema: z.object({ stack: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/), verb: z.enum(STACK_VERBS) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ stack, verb }) => verbReply(logged(`${verb} of ${stack} requested via MCP`, await runStackVerb(stack, verb), { stack })),
  )

  server.registerTool(
    'list_exposures',
    {
      title: 'Security exposures',
      description:
        'Running services that carry a package version a followed security incident (pwn.watch) names, read from syft ' +
        'inventories of the running images. Each service shows the affected packages and the update, if any, verified from ' +
        'its own image to remove them. Pass `slug` for one incident.',
      inputSchema: z.object({ slug: z.string().max(200).optional() }),
      annotations: READ,
    },
    async ({ slug }) => json({ status: securityStatus(), exposures: exposureViews(slug) }),
  )

  server.registerTool(
    'list_security_incidents',
    {
      title: 'Security incidents',
      description:
        'Incidents shipshape follows, with the package targets extracted from each (null until read; empty when nothing ' +
        'could run in a container). `matched_only` limits to incidents with a running exposure.',
      inputSchema: z.object({ matched_only: z.boolean().optional() }),
      annotations: READ,
    },
    async ({ matched_only }) => json(incidentViews({ matchedOnly: matched_only ?? false })),
  )

  server.registerTool(
    'find_package',
    {
      title: 'Find a package',
      description: 'Which running services carry a package (npm, PyPI, deb, apk, a runtime binary such as node), and at what version.',
      inputSchema: z.object({ name: z.string().min(1).max(200) }),
      annotations: READ,
    },
    async ({ name }) => json(findPackage(name)),
  )

  return server
}
