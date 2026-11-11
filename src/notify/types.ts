import type { EventClass } from '../config.ts'

export type Priority = 1 | 2 | 3 | 4 | 5

export type IncidentStatus = 'firing' | 'resolved' | 'event'

/** A tap a card offers; the router calls back through the MCP's update_action / stack_action. */
export interface IncidentAction {
  emoji: string
  label: string
  do:
    | { target: 'shipshape'; verb: 'retry' | 'rollback'; stack: string }
    | { target: 'shipshape'; verb: string; update: number }
}

export interface Message {
  title: string
  body: string
  priority?: Priority
  tags?: string[]
  click?: string
  /**
   * What the message is about, which is what a sink's `events` list filters on:
   * `decision` (an update waiting on you), `broken` (a deploy failed or rolled back),
   * `security` (an exposure), `system` (shipshape's own health). Defaults to `system`.
   */
  eventClass?: EventClass
  /**
   * Stable identity of the condition (`shipshape:deploy:<stack>`). Repeats edit one
   * message; `resolved` closes it. Without a key the message is a one-shot event.
   */
  key?: string
  /** Defaults to `firing` with a key, `event` without one. */
  status?: IncidentStatus
  /** One-tap fixes. A sink renders what it can: reactions, buttons, or signed links. */
  actions?: IncidentAction[]
}
