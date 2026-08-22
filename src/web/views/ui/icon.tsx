import type { FC } from 'hono/jsx'

/**
 * The icons the interface uses, inline.
 *
 * Tabler ships ~5,900 of them; vendoring the package for thirty glyphs would outweigh
 * everything else served, and an icon font brings its own flash of unstyled text. So
 * these are the paths, copied, at Tabler's own 24x24 / currentColor / 2px round-cap
 * geometry so they inherit colour and line weight from whatever they sit in.
 */

export type IconName =
  | 'inbox'
  | 'updates'
  | 'services'
  | 'activity'
  | 'settings'
  | 'book'
  | 'refresh'
  | 'search'
  | 'check'
  | 'alert'
  | 'ban'
  | 'clock'
  | 'pause'
  | 'rocket'
  | 'merge'
  | 'pull-request'
  | 'external'
  | 'chevron-right'
  | 'chevron-left'
  | 'dots'
  | 'x'
  | 'undo'
  | 'sun'
  | 'moon'
  | 'auto'
  | 'keyboard'
  | 'copy'
  | 'plus'
  | 'skip'
  | 'eye'
  | 'status'

const PATHS: Record<IconName, string[]> = {
  inbox: ['M4 13h3l3 3h4l3 -3h3', 'M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2z'],
  updates: ['M12 3l8 4.5v9l-8 4.5l-8 -4.5v-9z', 'M12 12l8 -4.5', 'M12 12v9', 'M12 12l-8 -4.5'],
  services: ['M4 4h6v6h-6z', 'M14 4h6v6h-6z', 'M4 14h6v6h-6z', 'M14 14h6v6h-6z'],
  activity: ['M3 12h4l3 8l4 -16l3 8h4'],
  settings: [
    'M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z',
    'M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0',
  ],
  book: ['M3 19a9 9 0 0 1 9 0a9 9 0 0 1 9 0', 'M3 6a9 9 0 0 1 9 0a9 9 0 0 1 9 0', 'M3 6l0 13', 'M12 6l0 13', 'M21 6l0 13'],
  refresh: ['M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4', 'M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4'],
  search: ['M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0', 'M21 21l-6 -6'],
  check: ['M5 12l5 5l10 -10'],
  alert: ['M12 9v4', 'M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z', 'M12 16h.01'],
  ban: ['M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M5.7 5.7l12.6 12.6'],
  clock: ['M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0', 'M12 7v5l3 3'],
  // A gauge, not a clock and not the Activity pulse: both of those are already spoken for
  // in this set, and at 16px a needle reading against an arc is the one of the three that
  // still says "a machine's own dial" rather than "a time" or "a log".
  status: [
    'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0',
    'M13.41 10.59l2.59 -2.59',
    'M7 12a5 5 0 0 1 5 -5',
  ],
  pause: ['M6 5m0 1a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1z', 'M14 5m0 1a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1z'],
  rocket: [
    'M4 13a8 8 0 0 1 7 7a6 6 0 0 0 3 -5a9 9 0 0 0 6 -8a3 3 0 0 0 -3 -3a9 9 0 0 0 -8 6a6 6 0 0 0 -5 3',
    'M7 14a6 6 0 0 0 -3 6a6 6 0 0 0 6 -3',
    'M15 9m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
  ],
  merge: ['M7 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M7 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M17 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M7 8v8', 'M7 8a4 4 0 0 0 4 4h4'],
  'pull-request': ['M6 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M6 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M18 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M6 8v8', 'M11 6h5a2 2 0 0 1 2 2v8', 'M14 9l-3 -3l3 -3'],
  external: ['M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6', 'M11 13l9 -9', 'M15 4h5v5'],
  'chevron-right': ['M9 6l6 6l-6 6'],
  'chevron-left': ['M15 6l-6 6l6 6'],
  dots: ['M5 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0', 'M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0', 'M19 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0'],
  x: ['M18 6l-12 12', 'M6 6l12 12'],
  undo: ['M9 14l-4 -4l4 -4', 'M5 10h11a4 4 0 1 1 0 8h-1'],
  sun: ['M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0', 'M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7'],
  moon: ['M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454z'],
  auto: ['M12 3a9 9 0 0 0 0 18a9 9 0 0 0 0 -18', 'M12 3v18', 'M12 14l7 -7', 'M12 19l8.5 -8.5'],
  keyboard: [
    'M2 6m0 2a2 2 0 0 1 2 -2h16a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2z',
    'M6 10l0 .01',
    'M10 10l0 .01',
    'M14 10l0 .01',
    'M18 10l0 .01',
    'M6 14l12 0',
  ],
  copy: ['M7 7m0 2.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667z', 'M4.012 16.737a2 2 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1'],
  plus: ['M12 5l0 14', 'M5 12l14 0'],
  skip: ['M4 5v14l8 -7z', 'M14 5v14l8 -7z'],
  eye: ['M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0', 'M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6'],
}

export const Icon: FC<{ name: IconName; class?: string }> = ({ name, class: cls }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    class={cls ?? 'size-4'}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {PATHS[name].map((d) => (
      <path d={d} />
    ))}
  </svg>
)
