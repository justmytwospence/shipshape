import { configured, loadPolicy } from '../config.ts'
import { getDb, logEvent } from '../db.ts'
import { createTicker, type Ticker } from '../loop/ticker.ts'
import { pollFeed } from './feed.ts'
import { runExtraction } from './extract.ts'
import { hasInventory, listRunning, pruneInventories, recordRunning, scanImage } from './sbom.ts'
import {
  commentFixes,
  computeExposures,
  incidentTargets,
  inventoryCandidates,
  recordExposures,
  syncSecurityCards,
  verifyFixes,
} from './act.ts'

/**
 * The security pass, on its own clock.
 *
 * Separate from the pull-request loop on purpose: an inventory is up to a minute of syft
 * per image, and the PR loop's whole shape assumes a tick is short. The two meet in the
 * database -- this writes `security_fixes`, the merge gate reads it -- so neither waits
 * on the other.
 *
 * Order within a pass: read the feed, extract what changed, record what is running,
 * inventory candidates of exposed services first (they decide merges), then running
 * images, then match, verify, and only then say anything.
 */

let ticker: Ticker | null = null
let lastFeedAt = 0
let backlog = false
let running = false

export interface PassResult {
  feed: 'skipped' | 'unchanged' | 'read' | 'failed'
  extracted: number
  inventoried: number
  exposures: number
  fixes: number
}

export async function runSecurityPass(force = false): Promise<PassResult | null> {
  const { policy } = loadPolicy()
  if (policy.security.mode === 'off' || running) return null
  running = true
  const out: PassResult = { feed: 'skipped', extracted: 0, inventoried: 0, exposures: 0, fixes: 0 }
  try {
    const intervalMs = policy.security.interval_m * 60_000
    if (force || Date.now() - lastFeedAt >= intervalMs) {
      try {
        const r = await pollFeed(policy)
        out.feed = r.unchanged ? 'unchanged' : 'read'
        lastFeedAt = Date.now()
      } catch (err) {
        out.feed = 'failed'
        logEvent({ level: 'warn', kind: 'system', message: 'security feed could not be read', detail: (err as Error).message })
      }
      const ex = await runExtraction()
      out.extracted = ex.extracted
    }

    const live = await listRunning()
    recordRunning(live)
    const targets = incidentTargets()

    let budget = policy.security.sbom_per_pass
    // What is exposed with the inventories already taken decides which candidates matter.
    let found = computeExposures(targets, live)
    const exposed = new Set([...found.values()].map((f) => `${f.r.stack}/${f.r.service}`))
    const cand = await inventoryCandidates(exposed, policy, budget)
    budget -= cand
    out.inventoried += cand

    // Then running images nobody has inventoried yet, one image id at a time.
    const pending = [...new Map(live.filter((r) => !hasInventory(r.imageId)).map((r) => [r.imageId, r])).values()]
    for (const r of pending.slice(0, Math.max(0, budget))) {
      await scanImage(r.imageId, r.imageRef, policy)
      out.inventoried++
    }
    backlog = pending.length > Math.max(0, budget)

    found = computeExposures(targets, live)
    out.exposures = recordExposures(found)
    out.fixes = verifyFixes(targets, found)
    pruneInventories()

    // Saying anything is `on` only; shadow stops here with everything recorded.
    await syncSecurityCards(policy)
    await commentFixes(policy)
    return out
  } catch (err) {
    logEvent({ level: 'warn', kind: 'system', message: 'security pass failed', detail: (err as Error).message })
    return out
  } finally {
    running = false
  }
}

export function startSecurityLoop(): void {
  if (!configured().ok) return
  ticker = createTicker(
    async () => {
      await runSecurityPass()
    },
    () => {
      const { policy } = loadPolicy()
      if (policy.security.mode === 'off') return 15 * 60_000
      // While inventories are still being taken, keep going; then the feed's own cadence.
      return backlog ? 60_000 : policy.security.interval_m * 60_000
    },
  )
  // After the first PR loop tick and scan have had their moment.
  ticker.start(90_000)
}

export function stopSecurityLoop(): void {
  ticker?.stop()
}

/** For the status page and the MCP. */
export function securityStatus(): {
  incidents: number
  withTargets: number
  inventories: number
  running: number
  uninventoried: number
  exposures: number
  fixes: number
  nextAt: string | null
} {
  const db = getDb()
  const n = (sql: string) => (db.prepare(sql).get() as { c: number }).c
  return {
    incidents: n(`SELECT COUNT(*) c FROM security_incidents`),
    withTargets: n(`SELECT COUNT(*) c FROM security_incidents WHERE targets IS NOT NULL AND targets != '[]'`),
    inventories: n(`SELECT COUNT(*) c FROM sbom_images WHERE error IS NULL`),
    running: n(`SELECT COUNT(*) c FROM security_running`),
    uninventoried: n(
      `SELECT COUNT(DISTINCT r.image_id) c FROM security_running r LEFT JOIN sbom_images s ON s.image_id = r.image_id WHERE s.image_id IS NULL`,
    ),
    exposures: n(`SELECT COUNT(DISTINCT slug || '/' || stack || '/' || service) c FROM exposures`),
    fixes: n(`SELECT COUNT(*) c FROM security_fixes`),
    nextAt: ticker?.nextAt() ?? null,
  }
}
