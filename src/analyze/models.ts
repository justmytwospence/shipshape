import { getDb } from '../db.ts'
import { llmProvider, modelsEndpoint } from './client.ts'

/**
 * The models this key can actually use, so the settings page offers a real list rather
 * than a hardcoded one that goes stale.
 */

// Keyed by provider: the ids are spelled differently on each (`claude-opus-5` against
// Anthropic, `anthropic/claude-opus-5` through OpenRouter), so a list cached before a
// switch would offer names the new endpoint rejects for up to a day.
const CACHE_KEY = `models:${llmProvider()}`
const TTL_MS = 24 * 60 * 60 * 1000

export async function listModels(): Promise<string[]> {
  const cached = readCache()
  if (cached) return cached
  const endpoint = modelsEndpoint()
  if (!endpoint) return []

  try {
    const res = await fetch(endpoint.url, {
      headers: endpoint.headers,
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return []
    const body = (await res.json()) as { data?: { id: string }[] }
    // Both endpoints answer `{data: [{id}]}`. OpenRouter lists every vendor it routes to
    // -- hundreds of them -- and shipshape's prompts, tool revisions and pricing table
    // are all written against Claude, so the list it offers stays Claude.
    const ids = (body.data ?? [])
      .map((m) => m.id)
      .filter((id) => id.startsWith('anthropic/') || id.startsWith('claude-'))
    if (ids.length > 0) writeCache(ids)
    return ids
  } catch {
    // The page must render without a working key.
    return []
  }
}

function readCache(): string[] | null {
  const row = getDb()
    .prepare(`SELECT body, fetched_at FROM http_cache WHERE url = ?`)
    .get(CACHE_KEY) as { body: string; fetched_at: string } | undefined
  if (!row) return null
  if (Date.now() - Date.parse(row.fetched_at) > TTL_MS) return null
  try {
    return JSON.parse(row.body) as string[]
  } catch {
    return null
  }
}

function writeCache(ids: string[]): void {
  getDb()
    .prepare(
      `INSERT INTO http_cache (url, etag, body, fetched_at) VALUES (?, NULL, ?, ?)
       ON CONFLICT(url) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at`,
    )
    .run(CACHE_KEY, JSON.stringify(ids), new Date().toISOString())
}
