import type { Policy } from '../config.ts'

/**
 * The optional offsite half of a restore point: ask any MCP server to take a backup.
 *
 * Deliberately generic -- JSON-RPC `tools/call`s to a configured URL, with a `job`
 * argument -- so shipshape is not tied to any one backup system. Here the tools are
 * backup-mcp's `run_backup`, `run_status` and `list_jobs`, which re-run a
 * docker-volume-backup job by name.
 *
 * Two uses:
 * - beside a local dump, a fire-and-forget extra copy (`runOffsite`): failure is
 *   reported, never thrown, and never blocks a ship;
 * - as the restore point itself, for a stack with no `shipshape.snapshot` but a backup
 *   job (`runOffsiteAndWait`): the ship waits for the backup to finish, and a backup that
 *   did not succeed holds the update like a failed dump would.
 */

export type OffsiteResult = { status: 'ok' | 'error'; detail: string }

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

type OffsiteConfig = NonNullable<Policy['restore_points']['offsite']>

/** The job to run: the stack's `shipshape.backup-job` label, else the policy template. */
export function offsiteJob(template: string, stack: string, label: string | null): string {
  return label?.trim() || template.replaceAll('{stack}', stack)
}

type ToolResult = { ok: true; text: string } | { ok: false; detail: string }

/** One `tools/call`. Answered as server-sent events or as plain JSON. */
async function callTool(
  url: string,
  name: string,
  args: Record<string, unknown>,
  doFetch: Fetch,
  timeoutMs = 30_000,
): Promise<ToolResult> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      signal: ctl.signal,
    })
    const raw = await res.text()
    if (!res.ok) return { ok: false, detail: `${name}: HTTP ${res.status}` }
    const m = raw.match(/data: (.*)/)
    const j = JSON.parse(m ? m[1]! : raw) as {
      error?: unknown
      result?: { isError?: boolean; content?: { text?: string }[] }
    }
    const text = j.result?.content?.[0]?.text ?? ''
    if (j.error || j.result?.isError) {
      let msg = j.error ? JSON.stringify(j.error) : text || 'tool error'
      try {
        msg = (JSON.parse(text) as { message?: string }).message ?? msg
      } catch {
        /* not JSON */
      }
      return { ok: false, detail: msg }
    }
    return { ok: true, text }
  } catch (err) {
    return { ok: false, detail: (err as Error).message }
  } finally {
    clearTimeout(timer)
  }
}

function parse(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export async function runOffsite(
  stack: string,
  label: string | null,
  cfg: OffsiteConfig,
  doFetch: Fetch = fetch as unknown as Fetch,
): Promise<OffsiteResult> {
  const job = offsiteJob(cfg.job, stack, label)
  const r = await callTool(cfg.url, cfg.tool, { job }, doFetch)
  if (!r.ok) return { status: 'error', detail: `${job}: ${r.detail}`.slice(0, 200) }
  const msg = (parse(r.text)?.message as string | undefined) ?? r.text
  return { status: 'ok', detail: `${job}: ${msg || 'requested'}`.slice(0, 200) }
}

export interface WaitIo {
  fetch: Fetch
  sleep(ms: number): Promise<void>
  now(): number
}

const realWait: WaitIo = {
  fetch: fetch as unknown as Fetch,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
}

/**
 * Run the stack's backup job and wait until it has finished. Only a run the backup
 * server reports as succeeded counts; a refusal (another run busy, unknown job), a
 * failure, a lost run or running out of time is an error, and the caller holds the update.
 */
export async function runOffsiteAndWait(
  stack: string,
  label: string | null,
  cfg: OffsiteConfig,
  io: WaitIo = realWait,
): Promise<OffsiteResult> {
  const job = offsiteJob(cfg.job, stack, label)
  const started = await callTool(cfg.url, cfg.tool, { job }, io.fetch)
  if (!started.ok) return { status: 'error', detail: `backup job ${job} did not start: ${started.detail}`.slice(0, 200) }
  const s = parse(started.text)
  const run = s?.run
  if (run === undefined || run === null) {
    // A server that does not report runs: the request is all there is to go on.
    return { status: 'ok', detail: `${job}: requested` }
  }

  const deadline = io.now() + cfg.wait_minutes * 60_000
  let misses = 0
  while (io.now() < deadline) {
    await io.sleep(cfg.poll_seconds * 1000)
    const st = await callTool(cfg.url, cfg.status_tool, { run }, io.fetch)
    if (!st.ok) {
      // A blip in reading the status is not the backup failing; give it a few.
      if (++misses >= 5) return { status: 'error', detail: `backup job ${job}: status unreadable: ${st.detail}`.slice(0, 200) }
      continue
    }
    misses = 0
    const state = String(parse(st.text)?.state ?? '')
    if (state === 'succeeded') return { status: 'ok', detail: `${job}: backed up` }
    if (state === 'failed' || state === 'lost') return { status: 'error', detail: `backup job ${job} ${state}` }
  }
  return { status: 'error', detail: `backup job ${job} still running after ${cfg.wait_minutes} min` }
}

/**
 * The backup jobs the offsite server knows, cached. Holds are computed synchronously all
 * over the code, so this is read from memory and refreshed in the background; until the
 * first answer arrives no stack has a job, which only ever holds more, never less.
 */
let jobs: { at: number; names: Set<string> } | null = null
const JOBS_TTL_MS = 60 * 60_000

export function offsiteJobs(): Set<string> | null {
  return jobs?.names ?? null
}

/** For the tests. */
export function setOffsiteJobs(names: string[] | null): void {
  jobs = names ? { at: Date.now(), names: new Set(names) } : null
}

export async function refreshOffsiteJobs(
  cfg: OffsiteConfig | null,
  doFetch: Fetch = fetch as unknown as Fetch,
  force = false,
): Promise<void> {
  if (!cfg) {
    jobs = null
    return
  }
  if (!force && jobs && Date.now() - jobs.at < JOBS_TTL_MS) return
  const r = await callTool(cfg.url, cfg.list_tool, {}, doFetch)
  if (!r.ok) return // keep what we had
  const list = parse(r.text)?.jobs
  if (!Array.isArray(list)) return
  const names = list
    .map((j) => (typeof j === 'string' ? j : (j as { job?: unknown; name?: unknown })?.job ?? (j as { name?: unknown })?.name))
    .filter((n): n is string => typeof n === 'string')
  jobs = { at: Date.now(), names: new Set(names) }
}

/** Whether the offsite server has a job for this stack. */
export function hasOffsiteJob(cfg: OffsiteConfig | null, stack: string, label: string | null): boolean {
  if (!cfg) return false
  return offsiteJobs()?.has(offsiteJob(cfg.job, stack, label)) ?? false
}
