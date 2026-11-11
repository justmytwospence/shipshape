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
      <p class="text-sm">{title}</p>
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
