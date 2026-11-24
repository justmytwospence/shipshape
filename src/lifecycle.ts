import type { ServerType } from '@hono/node-server'
import { logEvent, type EventKind } from './db.ts'

/** A listener that can be closed: stops accepting, finishes the requests it has. */
export interface ServerHandle {
  close(): Promise<void>
}

export function serverHandle(server: ServerType): ServerHandle {
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        if ('closeIdleConnections' in server) server.closeIdleConnections()
      }),
  }
}

/**
 * What shipshape is still doing, and whether it has been asked to stop.
 *
 * Background work (a deploy a button started, a review re-run, a published rule) is
 * registered here so shutdown has one place to wait on. A rejection in a detached
 * promise would otherwise take the process down with it.
 */
const pending = new Map<Promise<unknown>, string>()
let stopping = false

export function isStopping(): boolean {
  return stopping
}

export function beginShutdown(): void {
  stopping = true
}

/** Register work so shutdown can wait for it; resolves or rejects exactly as `work` does. */
export function track<T>(work: Promise<T>, label: string): Promise<T> {
  pending.set(work, label)
  const forget = () => void pending.delete(work)
  work.then(forget, forget)
  return work
}

/** Fire and forget: tracked, and a rejection is logged instead of escaping. */
export function background(work: Promise<unknown>, label: string, kind: EventKind = 'system'): void {
  track(work, label).catch((err: unknown) => {
    logEvent({
      level: 'error',
      kind,
      message: `${label} threw`,
      detail: (err as Error)?.message?.slice(0, 300) ?? String(err),
    })
  })
}

/** Labels of tracked work still running, for the shutdown log. */
export function inFlight(): string[] {
  return [...pending.values()]
}

/** Resolves when every tracked promise has settled, re-checking until the set is empty. */
export async function drain(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending.keys()])
}
