import type { FC } from 'hono/jsx'
import { Layout } from './shell.tsx'

/**
 * The page behind a signed action link (email, ntfy). It names what is about to happen and
 * asks first -- a link in a message is one tap from a mistake -- then the POST does it.
 */
export const ActConfirm: FC<{ verb: string; label: string; title: string; steps?: string[]; token: string }> = ({
  label,
  title,
  steps,
  token,
}) => (
  <Layout title={label} nav={null}>
    <div class="mx-auto flex w-full max-w-xl flex-col gap-3 p-4">
      <h2 class="text-base font-semibold">{label}</h2>
      <p class="text-sm break-all">{title}</p>
      {steps && steps.length > 0 ? (
        <ul class="list-disc pl-5 text-sm opacity-80">
          {steps.map((s) => (
            <li>{s}</li>
          ))}
        </ul>
      ) : null}
      <form method="post" action={`/act/${token}`} class="flex gap-2">
        <button type="submit" class="btn btn-primary btn-sm tap">
          {label}
        </button>
        <a href="/" class="btn btn-ghost btn-sm tap">
          Cancel
        </a>
      </form>
    </div>
  </Layout>
)

export const ActDone: FC<{ ok: boolean; message: string; id: number }> = ({ ok, message, id }) => (
  <Layout title={ok ? 'Done' : 'Not done'} nav={null}>
    <div class="mx-auto flex w-full max-w-xl flex-col gap-3 p-4">
      <p class={`text-sm ${ok ? '' : 'text-error'}`}>{message}</p>
      <a href={`/updates/${id}`} class="btn btn-ghost btn-sm tap self-start">
        Open the update
      </a>
    </div>
  </Layout>
)

/** A signed link that cannot be acted on: expired, forged, or pointing at an update that is gone. */
export const ActError: FC<{ heading: string; message: string; href: string; label: string }> = ({
  heading,
  message,
  href,
  label,
}) => (
  <Layout title={heading} nav={null}>
    <div class="mx-auto flex w-full max-w-xl flex-col gap-3 p-4">
      <h2 class="text-base font-semibold">{heading}</h2>
      <p class="text-sm">{message}</p>
      <a href={href} class="btn btn-ghost btn-sm tap self-start">
        {label}
      </a>
    </div>
  </Layout>
)

export const ACT_EXPIRED = {
  heading: 'This link has expired',
  message:
    "Action links from messages stop working after 14 days, or when shipshape's action secret changes. Open the update in shipshape to act on it.",
  href: '/',
  label: 'Open shipshape',
}

export const ACT_GONE = {
  heading: 'That update is gone',
  message: 'It was shipped, skipped or superseded after this message was sent.',
  href: '/updates',
  label: 'Open Updates',
}
