/**
 * Wake the main loop now. Verbs sit below the scheduler and must not import it; the
 * scheduler registers the listener when the loop starts.
 */
let listener: (() => void) | null = null

export function onWake(fn: (() => void) | null): void {
  listener = fn
}

export function wakeLoop(): void {
  listener?.()
}
