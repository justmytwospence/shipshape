import type { FC } from 'hono/jsx'
import { Layout, type Chrome } from './shell.tsx'

/** The page for a path that leads nowhere, or a request that failed on the server's side. */
export const ErrorPage: FC<{
  heading: string
  body: string
  actions: { href: string; label: string; primary?: boolean }[]
  chrome?: Chrome
}> = ({ heading, body, actions, chrome }) => (
  <Layout title={heading} nav={null} chrome={chrome}>
    <div class="mx-auto flex w-full max-w-xl flex-col gap-3 p-4">
      <h2 class="text-base font-semibold">{heading}</h2>
      <p class="text-sm opacity-80">{body}</p>
      <div class="flex flex-wrap gap-2">
        {actions.map((a) => (
          <a href={a.href} class={a.primary ? 'btn btn-sm tap btn-primary' : 'btn btn-sm tap btn-ghost'}>
            {a.label}
          </a>
        ))}
      </div>
    </div>
  </Layout>
)

export interface ErrorCopy {
  heading: string
  body: string
  actions: { href: string; label: string; primary?: boolean }[]
}

/** What a 404 says, by where it was asked for. */
export function notFoundCopy(path: string): ErrorCopy {
  if (/^\/updates\/\d+/.test(path)) {
    return {
      heading: 'That update is gone',
      body: 'It may have been superseded by a newer version, or retired once its change landed.',
      actions: [{ href: '/updates', label: 'Back to Updates', primary: true }],
    }
  }
  if (/^\/services\//.test(path)) {
    return {
      heading: 'That service is gone',
      body: 'It is no longer in your compose files.',
      actions: [{ href: '/services', label: 'Back to Services', primary: true }],
    }
  }
  return {
    heading: 'That page is not here',
    body: 'Nothing lives at this address. It may have moved, or a link may be out of date.',
    actions: [
      { href: '/', label: 'Back to Inbox', primary: true },
      { href: '/updates', label: 'Open Updates' },
    ],
  }
}

/** What a 500 says. A GET can simply be tried again; anything else may have half-happened. */
export function serverErrorCopy(method: string, pathAndQuery: string): ErrorCopy {
  return {
    heading: 'Something went wrong',
    body: 'shipshape hit an error handling that request. It may have been partly carried out, so check Activity before trying again. The details are in the container log.',
    actions:
      method === 'GET'
        ? [
            { href: pathAndQuery, label: 'Reload', primary: true },
            { href: '/activity', label: 'Open Activity' },
          ]
        : [
            { href: '/activity', label: 'Open Activity', primary: true },
            { href: '/', label: 'Back to Inbox' },
          ],
  }
}
