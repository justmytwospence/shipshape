import type { Policy } from '../config.ts'

/**
 * The optional offsite half of a restore point: ask any MCP server to take a backup.
 *
 * Deliberately generic -- one JSON-RPC `tools/call` to a configured URL and tool, with a
 * `job` argument -- so shipshape is not tied to any one backup system. Here the tool is
 * backup-mcp's `run_backup`, which re-runs a docker-volume-backup job by name. Failure is
 * reported, never thrown: an offsite copy is extra safety and must not block a ship.
 */

export type OffsiteResult = { status: 'ok' | 'error'; detail: string }

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

/** The job to run: the stack's `shipshape.backup-job` label, else the policy template. */
export function offsiteJob(template: string, stack: string, label: string | null): string {
  return label?.trim() || template.replaceAll('{stack}', stack)
}

export async function runOffsite(
  stack: string,
  label: string | null,
  cfg: NonNullable<Policy['restore_points']['offsite']>,
  doFetch: Fetch = fetch as unknown as Fetch,
): Promise<OffsiteResult> {
  const job = offsiteJob(cfg.job, stack, label)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 30_000)
  try {
    const res = await doFetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: cfg.tool, arguments: { job } },
      }),
      signal: ctl.signal,
    })
    const raw = await res.text()
    if (!res.ok) return { status: 'error', detail: `${cfg.tool} ${job}: HTTP ${res.status}` }
    // Answered as server-sent events or as plain JSON.
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
      return { status: 'error', detail: `${job}: ${msg}`.slice(0, 200) }
    }
    let msg = text
    try {
      msg = (JSON.parse(text) as { message?: string }).message ?? text
    } catch {
      /* not JSON */
    }
    return { status: 'ok', detail: `${job}: ${msg || 'requested'}`.slice(0, 200) }
  } catch (err) {
    return { status: 'error', detail: `${job}: ${(err as Error).message}`.slice(0, 200) }
  } finally {
    clearTimeout(timer)
  }
}
