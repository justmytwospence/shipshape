import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'

/**
 * A fake network for tests that exercise upstream calls.
 *
 * Replaces the global `fetch` for one test (node:test restores it afterwards) and routes
 * each request to the first matching reply. An unmatched request throws -- and is also
 * recorded, because most upstream callers catch fetch errors and degrade, so a throw on its
 * own would let a test pass while silently exercising the failure path. Call
 * `assertAllMocked` at the end of every test that uses this.
 */

export interface Route {
  method?: string
  /** An exact URL, or a pattern tested against the full URL. */
  url: string | RegExp
  reply: (req: Request, match: RegExpExecArray | null) => Response | Promise<Response>
}

export interface FetchHarness {
  calls: { method: string; url: string; headers: Headers }[]
  unmatched: string[]
}

export function mockFetch(t: TestContext, routes: Route[]): FetchHarness {
  const h: FetchHarness = { calls: [], unmatched: [] }
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init)
    h.calls.push({ method: req.method, url: req.url, headers: req.headers })
    for (const r of routes) {
      if (r.method && r.method.toUpperCase() !== req.method) continue
      if (typeof r.url === 'string') {
        if (r.url === req.url) return r.reply(req, null)
      } else {
        r.url.lastIndex = 0
        const m = r.url.exec(req.url)
        if (m) return r.reply(req, m)
      }
    }
    h.unmatched.push(`${req.method} ${req.url}`)
    throw new TypeError(`unmocked fetch: ${req.method} ${req.url}`)
  })
  return h
}

export function assertAllMocked(h: FetchHarness): void {
  assert.deepEqual(h.unmatched, [], 'every request should have matched a mocked route')
}

export function json(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}

export function text(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body, { status: init.status ?? 200, headers: init.headers })
}

/** A bodiless reply: 304, or an error status whose body nothing reads. */
export function status(code: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: code, headers })
}
