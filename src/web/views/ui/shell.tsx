import type { FC, PropsWithChildren } from 'hono/jsx'
import { Icon, type IconName } from './icon.tsx'
import { version } from '../../version.ts'

/**
 * The frame every page hangs in.
 *
 * One navigation, two presentations: a sidebar where there is room and a dock where
 * there is not. They are the same five destinations in the same order from the same
 * array, because the previous shell kept them in two places and a "More" menu, which is
 * how the System page ended up two taps deep on the device it is most needed on.
 */

export type NavKey = 'inbox' | 'updates' | 'services' | 'activity' | 'settings'

export const NAV: { key: NavKey; href: string; label: string; icon: IconName }[] = [
  { key: 'inbox', href: '/', label: 'Inbox', icon: 'inbox' },
  { key: 'updates', href: '/updates', label: 'Updates', icon: 'updates' },
  { key: 'services', href: '/services', label: 'Services', icon: 'services' },
  { key: 'activity', href: '/activity', label: 'Activity', icon: 'activity' },
  { key: 'settings', href: '/settings', label: 'Settings', icon: 'settings' },
]

/**
 * Resolve the theme before the first paint.
 *
 * Deliberately inline and not deferred: any later and the page renders light, then
 * repaints dark, which is worse than either.
 */
const THEME_SCRIPT = `(function(){
  try {
    var s = localStorage.getItem('shipshape-theme') || 'auto';
    var d = document.documentElement;
    if (s === 'auto') d.removeAttribute('data-theme');
    else d.setAttribute('data-theme', s === 'dark' ? 'bridge-dark' : 'bridge');
  } catch (e) {}
})()`

const SW_SCRIPT = `if ('serviceWorker' in navigator) {
  addEventListener('load', function(){ navigator.serviceWorker.register('/sw.js').catch(function(){}) })
}`

export interface LayoutProps {
  title: string
  nav: NavKey | null
  /** Shown on the phone bar in place of the brand, for a page you drilled into. */
  back?: { href: string; label: string }
  /** One control in the phone bar; the same one repeats in the desktop header. */
  actions?: unknown
  subtitle?: unknown
  /** The filter row, which sits outside the scrolling content on desktop. */
  toolbar?: unknown
  paused?: boolean
  missing?: { name: string; why: string }[]
  /** A page that manages its own padding (a two-pane list, a full-bleed table). */
  bare?: boolean
  /**
   * Pin a theme for this render, overriding the stored preference.
   *
   * Only `?theme=` uses it, so two candidate looks can be put side by side on real data
   * rather than judged from a palette. It is a preview, not a setting: nothing writes it.
   */
  theme?: string
}

export const Layout: FC<PropsWithChildren<LayoutProps>> = ({
  title,
  nav,
  back,
  actions,
  subtitle,
  toolbar,
  paused,
  missing,
  bare,
  theme,
  children,
}) => (
  <html lang="en" data-theme={theme} data-theme-pinned={theme ? 'true' : undefined}>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <title>{title} · shipshape</title>
      {theme ? null : <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />}
      <link rel="stylesheet" href="/static/app.css" />
      {/* Fetched with credentials or Authelia's redirect makes the app silently
          non-installable while still answering 200. */}
      <link rel="manifest" href="/static/manifest.webmanifest" crossorigin="use-credentials" />
      <meta name="theme-color" content="#fbfbfa" media="(prefers-color-scheme: light)" />
      <meta name="theme-color" content="#16171a" media="(prefers-color-scheme: dark)" />
      <meta name="apple-mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-title" content="shipshape" />
      <link rel="icon" href="/static/icon.svg" type="image/svg+xml" />
      <link rel="apple-touch-icon" href="/static/apple-touch-icon.png" />
      <script src="/static/htmx.min.js" defer />
      <script dangerouslySetInnerHTML={{ __html: SW_SCRIPT }} defer />
    </head>
    <body class="bg-base-200 text-base-content min-h-dvh">
      <progress
        id="busy"
        class="progress progress-primary htmx-indicator fixed inset-x-0 top-0 z-50 h-0.5 w-full"
      />

      <div class="drawer lg:drawer-open">
        <input id="nav-drawer" type="checkbox" class="drawer-toggle" />

        <div class="drawer-content flex min-h-dvh flex-col">
          {/* Phone: one bar, one title, one action. No hamburger -- the dock is the nav,
              and a menu that duplicates it is a menu nobody opens. */}
          <header class="navbar bg-base-100 border-base-300 px-safe pt-safe sticky top-0 z-20 min-h-0 gap-2 border-b py-2 lg:hidden">
            {back ? (
              <a href={back.href} class="btn btn-ghost btn-sm tap -ml-2 gap-1 px-2">
                <Icon name="chevron-left" />
                <span class="max-w-[7rem] truncate">{back.label}</span>
              </a>
            ) : (
              <span class="text-base font-semibold tracking-tight">shipshape</span>
            )}
            <h1 class="min-w-0 flex-1 truncate text-center text-sm font-medium opacity-70">
              {title}
            </h1>
            <div class="flex items-center gap-1">{actions}</div>
          </header>

          <main id="main" class="px-safe pb-dock flex-1 lg:pb-0">
            <div class={bare ? '' : 'mx-auto w-full max-w-5xl px-4 py-4 lg:px-8 lg:py-6'}>
              {/* Desktop header: the phone bar is too small for a subtitle or a toolbar. */}
              <div class="mb-4 hidden items-end justify-between gap-4 lg:flex">
                <div>
                  <h1 class="text-2xl font-semibold tracking-tight">{title}</h1>
                  {subtitle ? <div class="text-sm opacity-70">{subtitle}</div> : null}
                </div>
                <div class="flex items-center gap-2">{actions}</div>
              </div>

              {missing && missing.length > 0 ? <SetupBanner missing={missing} /> : null}
              {paused ? <PausedBanner /> : null}
              {toolbar ? <div class="mb-4">{toolbar}</div> : null}
              {children}
            </div>
          </main>

          <Dock active={nav} />
        </div>

        <aside class="drawer-side z-30">
          <label for="nav-drawer" aria-label="close" class="drawer-overlay" />
          <div class="bg-base-100 border-base-300 flex min-h-dvh w-60 flex-col border-r">
            <a href="/" class="px-5 py-5 text-lg font-semibold tracking-tight">
              shipshape
            </a>
            <ul class="menu menu-sm w-full flex-1 gap-0.5 px-3">
              {NAV.map((n) => (
                <li>
                  <a
                    href={n.href}
                    class={n.key === nav ? 'menu-active font-medium' : ''}
                    aria-current={n.key === nav ? 'page' : undefined}
                  >
                    <Icon name={n.icon} />
                    {n.label}
                  </a>
                </li>
              ))}
            </ul>
            <div class="border-base-300 flex items-center justify-between gap-2 border-t px-4 py-3">
              <ThemeToggle />
              <span class="font-mono text-xs opacity-50">v{version()}</span>
            </div>
          </div>
        </aside>
      </div>

      {/* Outside the drawer, and outside every region that gets swapped or polled: a
          detail panel that lives inside the list it was opened from disappears the
          moment that list refreshes. */}
      <dialog id="sheet" class="modal modal-bottom md:modal-end">
        <div
          id="sheet-body"
          data-panel
          class="modal-box pb-safe max-h-[88dvh] md:h-full md:max-h-full md:w-[34rem] md:max-w-none md:rounded-none"
        />
        <form method="dialog" class="modal-backdrop">
          <button>close</button>
        </form>
      </dialog>

      <Shortcuts />

      <div
        id="toasts"
        class="toast toast-top toast-center md:toast-bottom md:toast-end z-50 w-[min(28rem,92vw)]"
        role="status"
        aria-live="polite"
      />

      <script src="/static/app.js" defer />
    </body>
  </html>
)

const Dock: FC<{ active: NavKey | null }> = ({ active }) => (
  <nav class="dock dock-sm lg:hidden" aria-label="Primary">
    {NAV.map((n) => (
      <a
        href={n.href}
        class={n.key === active ? 'dock-active' : ''}
        aria-current={n.key === active ? 'page' : undefined}
      >
        <Icon name={n.icon} class="size-5" />
        <span class="dock-label">{n.label}</span>
      </a>
    ))}
  </nav>
)

const ThemeToggle: FC = () => (
  <div class="join" role="group" aria-label="Theme">
    {(
      [
        ['auto', 'auto', 'Match the system'],
        ['light', 'sun', 'Light'],
        ['dark', 'moon', 'Dark'],
      ] as const
    ).map(([value, icon, label]) => (
      <button
        type="button"
        class="btn btn-ghost btn-xs join-item"
        data-set-theme={value}
        aria-label={label}
        title={label}
      >
        <Icon name={icon} class="size-3.5" />
      </button>
    ))}
  </div>
)

const PausedBanner: FC = () => (
  <div class="alert alert-warning alert-soft mb-4 py-2 text-sm">
    <Icon name="pause" />
    <span>
      <strong class="font-medium">Paused.</strong> Nothing merges or deploys on its own.
    </span>
    <a href="/settings" class="link ml-auto shrink-0">
      Change
    </a>
  </div>
)

const SetupBanner: FC<{ missing: { name: string; why: string }[] }> = ({ missing }) => (
  <div class="alert alert-error alert-soft mb-4 flex-col items-start gap-1 text-sm">
    <strong class="font-medium">shipshape is not configured yet.</strong>
    <ul class="list-inside list-disc opacity-90">
      {missing.map((m) => (
        <li>
          <code class="font-mono">{m.name}</code> — {m.why}
        </li>
      ))}
    </ul>
  </div>
)

const KEYS: [string, string][] = [
  ['j / k', 'move through the list'],
  ['Enter', 'open the update'],
  ['m', 'do the thing the button says'],
  ['s', 'skip this version'],
  ['/', 'search'],
  ['g then i / u / s / a / ,', 'go to Inbox, Updates, Services, Activity, Settings'],
  ['?', 'this list'],
]

const Shortcuts: FC = () => (
  <dialog id="shortcuts" class="modal">
    <div class="modal-box max-w-md">
      <h2 class="mb-3 text-lg font-semibold">Keyboard</h2>
      <dl class="space-y-2 text-sm">
        {KEYS.map(([k, what]) => (
          <div class="flex items-baseline justify-between gap-4">
            <dt class="shrink-0">
              <kbd class="kbd kbd-sm">{k}</kbd>
            </dt>
            <dd class="text-right opacity-70">{what}</dd>
          </div>
        ))}
      </dl>
      <form method="dialog" class="modal-action">
        <button class="btn btn-sm">Close</button>
      </form>
    </div>
    <form method="dialog" class="modal-backdrop">
      <button>close</button>
    </form>
  </dialog>
)
