import { createTransport, type Transporter } from 'nodemailer'
import { env } from '../config.ts'
import { logEvent } from '../db.ts'

/**
 * Email delivery.
 *
 * Configured entirely from the environment, because it is credentials -- a connection
 * string with a password in it does not belong in the tracked policy file next to the
 * merge semantics. What email *receives* is policy and lives there; whether it can send
 * at all is deployment.
 *
 * Both `SMTP_URL` and `MAIL_TO` are required, and having one without the other counts as
 * unconfigured rather than broken. Half-configured mail that fails on every send would
 * produce a warning per notification forever, which is the failure mode this whole file
 * exists to avoid.
 */

/** Can email be sent at all? */
export function configured(): boolean {
  return !!env.smtpUrl && !!env.mailTo
}

/**
 * One transport, created lazily and reused.
 *
 * nodemailer pools and reconnects on its own, and building a transport per message would
 * open a TCP connection and do a TLS handshake for every line shipshape ever writes.
 */
let transport: Transporter | null = null

function mailer(): Transporter {
  transport ??= createTransport(env.smtpUrl, {
    // A hung SMTP server must not hold up the loop that is trying to tell you something
    // went wrong. Fail fast and log; the Activity page still has the event.
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  })
  return transport
}

/** Drop the pooled connection, so a corrected SMTP_URL takes effect on the next send. */
export function reset(): void {
  transport?.close?.()
  transport = null
}

export interface Mail {
  subject: string
  text: string
  /** Optional rich body. Absent means the client renders `text`, which is always valid. */
  html?: string
}

export async function send(mail: Mail): Promise<{ ok: boolean; error?: string }> {
  if (!configured()) return { ok: false, error: 'email is not configured' }
  try {
    await mailer().sendMail({
      from: env.mailFrom,
      // Several recipients are a comma-separated list, which is what nodemailer wants
      // anyway -- but trimmed, because "a@x, b@y" is how a person writes it.
      to: env.mailTo
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      subject: mail.subject,
      text: mail.text,
      ...(mail.html ? { html: mail.html } : {}),
    })
    return { ok: true }
  } catch (err) {
    const error = (err as Error).message.slice(0, 300)
    // A missed notification must never break the operation that triggered it -- the same
    // contract push delivery has held from the start.
    logEvent({
      level: 'warn',
      kind: 'system',
      message: 'could not send email',
      detail: error,
    })
    return { ok: false, error }
  }
}

/** Minimal HTML escaping, for the bodies assembled in digest.ts. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
