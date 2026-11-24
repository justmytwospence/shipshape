import { env } from '../env.ts'

/**
 * Times as the server sees them. Activity groups lines by day on the server, so its day
 * headers and its clocks must agree on one zone: the container's (TZ). The browser
 * re-renders every <time> in that same zone (app.js reads <html data-tz>).
 */

/** An IANA zone Intl accepts, else 'UTC'. */
export function validZone(z: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z })
    return z
  } catch {
    return 'UTC'
  }
}

export const ZONE: string = validZone(env.tz)

const DAY = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
const CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** YYYY-MM-DD of an instant, in ZONE. */
export function dayKey(iso: string): string {
  return DAY.format(new Date(iso))
}

/** HH:MM (24 h) of an instant, in ZONE. */
export function clockText(iso: string): string {
  return CLOCK.format(new Date(iso))
}
