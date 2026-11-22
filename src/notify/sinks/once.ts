import type { Message } from '../types.ts'

/**
 * Sinks that cannot edit a message speak on a first fire and on an escalation, and say
 * nothing on repeats, edits or resolves. One instance per sink module.
 */
export class FireOnce {
  private readonly sent = new Map<string, number>()

  /** Whether to send. A resolve forgets its key (so the next fire is new) and sends nothing. */
  admit(opts: Message): boolean {
    if (opts.status === 'resolved') {
      if (opts.key) this.sent.delete(opts.key)
      return false
    }
    const priority = opts.priority ?? 3
    if (opts.key) {
      const was = this.sent.get(opts.key)
      if (was !== undefined && priority <= was) return false
      this.sent.set(opts.key, priority)
    }
    return true
  }

  /** After a failed send, so the next fire of the condition tries again. */
  forget(key: string | undefined): void {
    if (key) this.sent.delete(key)
  }

  reset(): void {
    this.sent.clear()
  }
}
