import type { FC, PropsWithChildren } from 'hono/jsx'
import { Icon, type IconName } from './icon.tsx'
import { version } from '../../version.ts'

/**
 * The application frame.
 *
 * On a desktop the viewport is the frame: a sidebar, a one-row toolbar, and below it a
 * list and a detail pane that each scroll on their own. On a phone the same DOM is an
 * ordinary document with a sticky bar at the top and the dock at the bottom, and only the
 * page scrolls -- nested scrollers on a touch screen are the thing the old dashboard got
 * most wrong. Every fixed height and every `overflow-*` here is therefore prefixed `lg:`.
 *
 * One navigation, two presentations: the sidebar and the dock are the same five
 * destinations in the same order from the same array.
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
 * Resolve the theme before the first paint. Deliberately inline and not deferred: any
 * later and the page renders light, then repaints dark, which is worse than either.
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

/**
 * Back and forward are full reloads. htmx's history cache would snapshot a list that
 * polls and restore it stale, cannot restore an inner scroller's position anyway, and
 * a 149-row page runs into localStorage quota warnings. Every URL here renders correctly
 * from the server, so a reload is one round trip and always right.
 */
const HTMX_CONFIG = '{"historyCacheSize":0,"refreshOnHistoryMiss":true}'

export interface LayoutProps {
  /** The document title and the phone bar's title. */
  title: string
  /** The toolbar's title on a desktop, when it differs (a detail page inside a list). */
  section?: string
  nav: NavKey | null
  /** Shown on the phone bar in place of the brand, for a page you drilled into. */
  back?: { href: string; label: string }
  /** One control: repeated in the phone bar and at the toolbar's right edge. */
  actions?: unknown
  /** The filter form. Rendered once, in the toolbar. */
  toolbar?: unknown
  /** "56 shown", updated out-of-band when a filter changes. */
  count?: unknown
  paused?: boolean
  missing?: { name: string; why: string }[]
  /** A `?theme=` preview, overriding the stored preference. Nothing writes it. */
  theme?: string
  /**
   * Below lg this document is a detail page: the phone bar carries a back link and the
   * toolbar row is not drawn, because the list it filters is not on screen. At lg the
   * list is beside the pane and the toolbar stays.
   */
  detail?: boolean
}

export const Layout: FC<PropsWithChildren<LayoutProps>> = ({
  title,
  section,
  nav,
  back,
  actions,
  toolbar,
  count,
  paused,
  missing,
  theme,
  detail,
  children,
}) => (
  <html lang="en" data-theme={theme} data-theme-pinned={theme ? 'true' : undefined}>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <title>{title} · shipshape</title>
      {theme ? null : <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />}
      <link rel="stylesheet" href="/static/app.css" />
      <meta name="htmx-config" content={HTMX_CONFIG} />
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
    <body class="bg-base-100 text-base-content min-h-dvh lg:h-dvh lg:overflow-hidden">
      <progress
        id="busy"
        class="progress progress-primary htmx-indicator fixed inset-x-0 top-0 z-50 h-0.5 w-full"
      />

      <div class="drawer lg:drawer-open lg:h-dvh">
        <input id="nav-drawer" type="checkbox" class="drawer-toggle" />

        <div class="drawer-content flex min-h-dvh flex-col lg:h-dvh lg:min-h-0 lg:overflow-hidden">
          {/* One header, two rows. Row 1 is the phone bar; row 2 is the toolbar, which on
              a phone scrolls sideways under it and on a desktop is the only header there is. */}
          {/* One header. On a phone it wraps into two rows -- back|brand · title · actions,
              then the toolbar full-width -- and at lg the phone parts hide and what is
              left is a single row: section · toolbar · count · actions. The actions are
              one node in both, moved by `order`, because they carry ids that must exist
              once (the scan chip is the poll's on-switch). */}
          <header class="border-base-300 bg-base-100 px-safe pt-safe sticky top-0 z-20 flex shrink-0 flex-wrap items-center gap-x-2 border-b px-2 lg:static lg:h-10 lg:flex-nowrap lg:px-3">
            {back ? (
              <a href={back.href} class="btn btn-ghost btn-sm tap order-1 -ml-1 gap-1 px-2 lg:hidden">
                <Icon name="chevron-left" />
                <span class="max-w-[7rem] truncate">{back.label}</span>
              </a>
            ) : (
              <span class="order-1 flex h-11 items-center px-2 text-sm font-semibold tracking-tight lg:hidden">
                shipshape
              </span>
            )}
            <h1 class="order-2 h-11 min-w-0 flex-1 truncate text-center text-sm leading-11 font-medium lg:hidden">
              {title}
            </h1>
            <div
              class={`${detail ? 'hidden lg:flex' : 'flex'} order-3 h-11 shrink-0 items-center gap-1 lg:order-5 lg:h-10`}
            >
              {actions}
            </div>
            <div
              class={`${toolbar && !detail ? 'flex' : 'hidden lg:flex'} scroll-x order-4 -mx-2 h-11 basis-full items-center gap-2 px-2 lg:order-2 lg:mx-0 lg:h-10 lg:min-w-0 lg:flex-1 lg:basis-auto lg:overflow-visible lg:px-0`}
            >
              <h1 class="hidden shrink-0 text-sm font-semibold lg:block">{section ?? title}</h1>
              {toolbar}
              <div class="ml-auto hidden shrink-0 items-center gap-2 pl-2 lg:flex">{count}</div>
            </div>
          </header>

          {missing && missing.length > 0 ? <SetupBanner missing={missing} /> : null}
          {paused ? <PausedBanner /> : null}

          <main id="main" class="pb-dock flex min-h-0 flex-1 flex-col lg:pb-0">
            {children}
          </main>

          <Dock active={nav} />
        </div>

        <aside class="drawer-side z-30">
          <label for="nav-drawer" aria-label="close" class="drawer-overlay" />
          <div class="bg-base-100 border-base-300 flex h-full w-56 flex-col border-r">
            <a href="/" class="px-4 py-3 text-sm font-semibold tracking-tight">
              shipshape
            </a>
            <ul class="menu menu-xs w-full flex-1 gap-0.5 px-2">
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
            <div class="border-base-300 flex items-center justify-between gap-2 border-t px-3 py-2">
              <ThemeToggle />
              <span class="font-mono text-xs opacity-50">v{version()}</span>
            </div>
          </div>
        </aside>
      </div>

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

/**
 * The list and the pane.
 *
 * `split` is the working shape: a list that keeps its width and a pane that takes the
 * rest, each its own scroller at lg. `wide` is a list with no pane (the log). `nav` is a
 * narrow list of anchors beside a pane that is always shown (settings). Below lg only one
 * of the two renders -- `mode` says which -- and neither is a scroller.
 */
export const Split: FC<{
  list: unknown
  pane?: unknown
  mode?: 'list' | 'detail'
  variant?: 'split' | 'wide' | 'nav'
}> = ({ list, pane, mode = 'list', variant = 'split' }) => {
  const listCls =
    variant === 'wide'
      ? 'lg:min-h-0 lg:flex-1 lg:overflow-y-auto'
      : variant === 'nav'
        ? 'border-base-300 hidden lg:block lg:min-h-0 lg:w-52 lg:shrink-0 lg:overflow-y-auto lg:border-r'
        : `border-base-300 lg:min-h-0 lg:w-[55%] lg:min-w-[34rem] lg:max-w-[56rem] lg:shrink-0 lg:overflow-y-auto lg:border-r ${
            mode === 'detail' ? 'hidden lg:block' : ''
          }`
  const paneCls = `lg:min-h-0 lg:min-w-0 lg:flex-1 lg:overflow-y-auto ${
    variant === 'nav' || mode === 'detail' ? '' : 'hidden lg:block'
  }`
  return (
    <div class="flex min-h-0 flex-1 flex-col lg:flex-row">
      <section id="list" class={listCls}>
        {list}
      </section>
      {pane !== undefined ? (
        <section id="pane" data-panel class={paneCls}>
          {pane}
        </section>
      ) : null}
    </div>
  )
}

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
  <div class="alert alert-warning alert-soft shrink-0 rounded-none border-x-0 border-t-0 py-1 text-xs">
    <Icon name="pause" class="size-3.5" />
    <span>
      <strong class="font-medium">Paused.</strong> Nothing merges or deploys on its own.
    </span>
    {/* Straight to the switch, not to the top of a page it sits somewhere on. The
        negative margin gives a thumb 44px without making the strip 44px. */}
    <a href="/settings#pause" class="link tap -my-2 ml-auto inline-flex shrink-0 items-center px-2">
      Change
    </a>
  </div>
)

const SetupBanner: FC<{ missing: { name: string; why: string }[] }> = ({ missing }) => (
  <div class="alert alert-error alert-soft shrink-0 flex-col items-start gap-1 rounded-none border-x-0 border-t-0 py-1.5 text-xs">
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
