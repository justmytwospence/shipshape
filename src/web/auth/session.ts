import { createHash, randomBytes } from 'node:crypto'
import { getDb } from '../../db/index.ts'

/**
 * Sessions for password mode: a random 32-byte token in a cookie, stored only as its
 * SHA-256. A session lasts 30 days from its last use, renewed at most every five minutes
 * so the Inbox's polling does not write on every request. Changing the password signs
 * everyone out: each session remembers which password it was made with.
 */

export const SESSION_COOKIE = 'shipshape_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000
const TOUCH_INTERVAL_MS = 5 * 60_000
const PRUNE_INTERVAL_MS = 24 * 60 * 60_000

const hash = (token: string) => createHash('sha256').update(token).digest('hex')
const iso = (ms: number) => new Date(ms).toISOString()

/** Returns the cookie value. */
export function createSession(fingerprint: string, now = Date.now()): string {
  const token = randomBytes(32).toString('base64url')
  getDb()
    .prepare(
      `INSERT INTO sessions (token_hash, created_at, last_seen_at, expires_at, pw_fingerprint) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(hash(token), iso(now), iso(now), iso(now + SESSION_TTL_MS), fingerprint)
  return token
}

export function lookupSession(
  token: string,
  fingerprint: string,
  now = Date.now(),
): { valid: boolean; renewed: boolean } {
  if (token.length !== 43) return { valid: false, renewed: false }
  const db = getDb()
  const row = db
    .prepare(`SELECT last_seen_at, expires_at, pw_fingerprint FROM sessions WHERE token_hash = ?`)
    .get(hash(token)) as { last_seen_at: string; expires_at: string; pw_fingerprint: string } | undefined
  if (!row || row.expires_at <= iso(now) || row.pw_fingerprint !== fingerprint) return { valid: false, renewed: false }
  if (now - Date.parse(row.last_seen_at) < TOUCH_INTERVAL_MS) return { valid: true, renewed: false }
  db.prepare(`UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?`).run(
    iso(now),
    iso(now + SESSION_TTL_MS),
    hash(token),
  )
  return { valid: true, renewed: true }
}

export function destroySession(token: string): void {
  getDb().prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(hash(token))
}

/** Rows deleted: expired sessions and those made with another password. */
export function pruneSessions(fingerprint: string, now = Date.now()): number {
  return getDb().prepare(`DELETE FROM sessions WHERE expires_at <= ? OR pw_fingerprint != ?`).run(iso(now), fingerprint)
    .changes
}

let lastPrune = 0
/** At most once per PRUNE_INTERVAL_MS per process. */
export function maybePrune(fingerprint: string, now = Date.now()): void {
  if (now - lastPrune < PRUNE_INTERVAL_MS) return
  lastPrune = now
  pruneSessions(fingerprint, now)
}
