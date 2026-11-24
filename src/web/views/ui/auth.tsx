import type { FC, PropsWithChildren } from 'hono/jsx'
import { THEME_SCRIPT } from '../../theme-script.ts'
import { asset } from '../../assets.ts'
import { Wordmark } from './icon.tsx'

/**
 * The pages that exist before anyone is signed in: the setup page, shown until a sign-in
 * method is configured, and the sign-in page. Standalone documents rather than `Layout`:
 * no htmx, no app.js, no service worker, and nothing that reads the database.
 */

export const DOCS_URL = 'https://justmytwospence.github.io/shipshape/'
export const FORKS_GUIDE_URL = `${DOCS_URL}guides/forks/`

export const AuthShell: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <title>{title} · shipshape</title>
      <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      <link rel="stylesheet" href={asset('app.css')} />
      <link rel="icon" href="/static/icon.svg" type="image/svg+xml" />
    </head>
    <body class="bg-base-100 text-base-content flex min-h-dvh items-center justify-center p-4">
      <main class="w-full max-w-xl">
        <div class="mb-4">
          <Wordmark />
        </div>
        {children}
      </main>
    </body>
  </html>
)

const Snippet: FC<{ text: string }> = ({ text }) => (
  <pre class="bg-base-200 border-base-300 mt-2 overflow-x-auto rounded-box border p-3 font-mono text-xs">{text}</pre>
)

const PASSWORD_SNIPPET = `services:
  shipshape:
    environment:
      SHIPSHAPE_PASSWORD: \${SHIPSHAPE_PASSWORD}                    # at least 12 characters
      SHIPSHAPE_ALLOWED_ORIGIN: https://shipshape.example.com      # the address you open shipshape at`

const PROXY_SNIPPET = `services:
  shipshape:
    environment:
      SHIPSHAPE_TRUSTED_PROXY: 172.20.0.2                          # the proxy's IP address or CIDR; a comma-separated list is fine
      SHIPSHAPE_ALLOWED_USER: alice                                # the username(s) your proxy forwards
      SHIPSHAPE_USER_HEADER: Remote-User                           # optional: the header that carries it
      SHIPSHAPE_ALLOWED_ORIGIN: https://shipshape.example.com      # required to press buttons`

export const SetupPage: FC<{ problems: string[] }> = ({ problems }) => (
  <AuthShell title="Set up sign-in">
    <div class="flex flex-col gap-4 text-sm">
      <h1 class="text-lg font-semibold">shipshape needs a way to sign you in</h1>
      <p>
        No one can use this page yet. Choose one of the two sign-in methods below, set its variables on the shipshape
        container, and restart it.
      </p>
      {problems.length > 0 ? (
        <div role="alert" class="alert alert-error alert-soft flex-col items-start">
          <span class="font-medium">What is wrong with the current settings</span>
          <ul class="list-disc pl-5">
            {problems.map((p) => (
              <li>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <section>
        <h2 class="font-semibold">Option 1: a password (simplest)</h2>
        <p class="mt-1">
          Set a password of at least 12 characters. shipshape shows a sign-in page and keeps you signed in for 30 days.
          Instead of SHIPSHAPE_PASSWORD you can set SHIPSHAPE_PASSWORD_FILE to the path of a file (a Docker secret
          works) that contains it.
        </p>
        <Snippet text={PASSWORD_SNIPPET} />
        <p class="mt-2 opacity-80">
          SHIPSHAPE_ALLOWED_ORIGIN is recommended: it makes the cookie Secure and pins the address that may submit forms.
          Without it, forms are accepted only from the address in the Host header.
        </p>
      </section>
      <section>
        <h2 class="font-semibold">Option 2: your reverse proxy signs people in</h2>
        <p class="mt-1">
          For Authelia, Authentik, oauth2-proxy and similar. shipshape trusts a username header, but only when
          the request comes from your proxy's address.
        </p>
        <Snippet text={PROXY_SNIPPET} />
        <p class="mt-2 opacity-80">
          The proxy must authenticate every request and overwrite any Remote-User header the browser sends.
        </p>
      </section>
      <p class="opacity-80">
        Use one method, not both. Nothing else is reachable until this is fixed. Documentation:{' '}
        <a class="link" href={DOCS_URL} rel="noopener noreferrer">
          {DOCS_URL}
        </a>
      </p>
    </div>
  </AuthShell>
)

export const LoginPage: FC<{ next: string; error?: string }> = ({ next, error }) => (
  <AuthShell title="Sign in">
    <div class="mx-auto flex max-w-sm flex-col gap-4">
      <h1 class="text-lg font-semibold">Sign in to shipshape</h1>
      <form method="post" action="/login" class="flex flex-col gap-3">
        <input type="hidden" name="next" value={next} />
        <label for="password" class="text-sm">
          Password
        </label>
        <input id="password" name="password" type="password" required autofocus autocomplete="current-password" class="input w-full" />
        {error ? (
          <div role="alert" class="alert alert-error alert-soft text-sm">
            {error}
          </div>
        ) : null}
        <button type="submit" class="btn btn-primary w-full tap">
          Sign in
        </button>
      </form>
    </div>
  </AuthShell>
)

export const SignOutForm: FC = () => (
  <form method="post" action="/logout" class="inline">
    <button type="submit" class="btn btn-ghost btn-xs px-1.5">
      Sign out
    </button>
  </form>
)
