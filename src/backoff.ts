/**
 * When to try again after `attempts` consecutive failures: the base delay, quadrupling each
 * time, capped. Shared by every retry that must neither hammer a failing service nor give up
 * on one that was only briefly down.
 */
export function backoffUntil(
  attempts: number,
  o: { baseMs: number; capMs: number },
  now = Date.now(),
): string {
  const ms = Math.min(o.baseMs * 4 ** Math.max(0, attempts - 1), o.capMs)
  return new Date(now + ms).toISOString()
}
