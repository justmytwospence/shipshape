# shipshape — working notes for agents

A Docker image update bot for a single-operator compose homelab: it polls registries,
opens real GitHub pull requests bumping `image:`, has Claude find and read the upstream
changelog, merges what policy allows, and deploys with a true `docker compose up -d`,
verifying and rolling back. Server-rendered Hono JSX + htmx, SQLite, no client framework.

`README.md` is the product; this file is how to work on it. The domain vocabulary lives
in the `shipshape-ux` skill — read it before changing anything user-facing rather than
re-deriving the model from `config.ts`.

## Dev loop

```
npm run dev:ui      # sandbox UI dev server on :8081 (see below) -- use this, not `npm run dev`
npm test            # node --test via tsx
npm run typecheck   # tsc --noEmit (note: it does not typecheck test/)
npm run shots       # screenshot matrix, see "Look at it"
```

`npm run dev:ui` (`bin/dev-ui.mjs`) builds a throwaway world in `.dev/`: an **online-backup
copy** of the live SQLite database (never the file itself — it is WAL and the container is
writing to it) and a `git archive` of the compose repo with its own throwaway git repo and
no remote. It sets `SHIPSHAPE_UI_DEV=1`, which stops the scheduler from starting, and
deletes every credential from the environment.

**Never point a dev server at the real checkout.** `POST /settings` commits into
`REPO_DIR`, and a configured `REPO_DIR` + `GITHUB_REPO` arms the scheduler — git sync,
GitHub polling, container recreation. That is not a dev server, it is a second production
instance.

## Look at it

Structure is testable; layout has to be looked at. Two regressions shipped here that the
tests could not see — a sticky header that did not stick, a flex chain that clipped the
page — which is why `bin/shots.mjs` exists.

Every UI change gets a screenshot pass at **phone and desktop, light and dark**, on the
routes it touched:

```
node bin/shots.mjs --label my-change --routes / /updates          # dev server
node bin/shots.mjs --label after --compare baseline               # side-by-side sheet
node bin/shots.mjs --base http://<container-ip>:8080 --label prod  # the deployed container
```

The container's address changes every time it is recreated. Find it with
`docker inspect shipshape --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}'`
and use the `10.0.74.x` one.

It needs a CDP endpoint. This host is headless, so run one in a container that shares the
host's network (CDP stays bound to 127.0.0.1):

```
docker run -d --rm --name ss-chrome --network host --shm-size=1g \
  -v "$PWD/bin/shots-fonts.conf:/etc/fonts/local.conf:ro" \
  gcr.io/zenika-hub/alpine-chrome:124 --no-sandbox --disable-gpu \
  --disable-dev-shm-usage --remote-debugging-port=9222 --hide-scrollbars about:blank
```

(The fonts file matters: without it the image resolves every family to a CJK face and
the text renders letter-spaced, which looks like a layout bug and is not.)

Each shot runs layout probes and the contact sheet flags them: horizontal overflow,
nested scroll regions and interactive targets under 44px on the **phone** shots, and
`rowsVisible` — how many list rows fit on screen — on all of them. Treat a new flag as
a regression, and a drop in `rowsVisible` on a list page as one too (Inbox, Updates and
Services should show 20+ rows at 1440×900 and ~15 on a phone). `.shots/baseline` is the
pre-redesign UI — keep it.

**Polypane** is the better tool when the operator is at their Mac, because it shows every
breakpoint at once and it is a real browser with a real session. It runs there, not here,
so it needs a tunnel:

```sh
# on the Mac
open -a Polypane --args --remote-debugging-port=5858
ssh -N -R 5858:127.0.0.1:5858 -L 8081:127.0.0.1:8081 nuc   # keep open
```

Then `curl -sf --max-time 2 http://127.0.0.1:5858/json/version` answers here, and the
`chrome-devtools` MCP server drives it; otherwise use `chrome-headless` or `bin/shots.mjs`.
Polypane holds a real Authelia session, so treat it as the operator's browser: look, do
not click through destructive flows.

## The interface

daisyUI 5 on Tailwind v4 (`src/styles/app.css` → `public/app.css`, built by `npm run css`).

- Reach for a daisyUI component first, Tailwind utilities second, bespoke CSS in
  `@layer components` last. Colours come from theme tokens (`bg-base-100`,
  `text-base-content`, `badge-success`) — never a raw hex, never an inline style.
- **Class names must be literal in the source.** Tailwind only emits what it can see, so
  `` `badge-${kind}` `` silently produces no CSS. Keep whole class strings in maps.
  `test/web/views.test.tsx` fails the build on any class that is not in the built CSS.
- **It is an application frame, not a page.** At `lg` the viewport is the frame: sidebar,
  one toolbar row, then a list and a detail pane (`Split` in `shell.tsx`) that scroll
  independently. Below `lg` the same DOM is an ordinary document — only the page scrolls,
  a row navigates to its own URL, and the toolbar's filter strip scrolls sideways. So
  every fixed height and every `overflow-*` on the frame is `lg:`-prefixed; a test fails
  on any that is not.
- **Detail lives in `#pane`; confirmations are still `<dialog>`s.** A row is `<a href
  data-row hx-get=…/panel hx-target="#pane" hx-push-url=…>`; the URL it pushes carries
  `?list=…` and the filters, and `/updates/:id?list=…` renders the same page turned
  inside out (list beside a filled pane; pane alone on a phone), so back and reload
  always land on something the server drew whole (`historyCacheSize: 0`). Which of the
  two behaviours a click gets is decided by a capture-phase listener in `app.js` — not by
  a `click[matchMedia(…)]` trigger filter, because htmx cancels an anchor's default
  action *before* it evaluates the filter, which left the phone with rows that did
  nothing.
- Density is the point. 13px body / 11px small (`@theme` in `app.css`; the root stays
  16px so daisyUI's control sizes hold), 36px rows at `lg` and ~48px two-line rows on a
  phone, dividers rather than a card per item, sticky 28px group headers, filters as
  `tabs tabs-box tabs-xs` radios (never the hover-reveal `filter`). A verb pressed in a
  row asks for the row back (`?view=row&list=…`); pressed in the pane, the pane
  (`view=detail`) — the sentence goes in the toast.
- Dialogs are `<dialog>` (`modal modal-bottom sm:modal-middle`), never a checkbox drawer:
  focus trap, Escape and backdrop dismissal come free and work on iOS.
- The phone is the primary target: 44px touch targets (`.tap`, which relaxes at `lg`),
  `env(safe-area-inset-*)` honoured at the bottom (dock, action bar) and the sides in
  landscape, and no information that exists only in a `title` attribute — touch has no
  hover.
- The theme is resolved before first paint by a small inline script from
  `localStorage['shipshape-theme']` (`auto | light | dark`); `auto` removes `data-theme`
  and lets daisyUI's `--prefersdark` follow the OS.
- Fetch current daisyUI 5 / Tailwind 4 docs with context7 rather than recalling v3/v4
  class names; the v4→v5 renames are extensive (`btm-nav`→`dock`, `card-bordered`→
  `card-border`, `form-control`→`fieldset`, `input-bordered` removed…).

## htmx contracts

Some behaviour depends on markup *shape*, which the type checker cannot see and a restyle
breaks silently. `test/web/views.test.tsx` and `test/web/routes.test.tsx` encode those invariants — read them
before touching views. The load-bearing ones:

- A row is an `<a href>` that htmx upgrades on desktop; never a `<tr>` with a handler.
- The pane (`#pane`) and the toast container live **outside** every polled or swapped
  region, or a swap deletes the element mid-interaction; there is exactly one of each per
  page and none in a fragment.
- The row and the pane for the same update have different ids (`upd-N`, `upd-N-detail`);
  a verb's `hx-target` is whichever it sits in.
- Polling attributes are only rendered while the thing is actually in flight, so the poll
  stops itself.
- htmx does not swap on a 4xx: an action that fails returns 200 with the unchanged
  fragment and a warning toast (`HX-Trigger`).

## Upstream links and release notes

Which repository an image comes from, and what its release notes say, feed detection (the
prerelease stream), the review, the model tier's `linked` guard, pull request bodies and
three pages. It went wrong in every one of those places separately before it was pulled
into one place, so keep it there:

- **One accessor.** `sourceFor` / `sourceForSync` in `src/resolver/index.ts` apply labels
  and the cache together. Nothing outside `src/resolver/` reads the `resolutions` table or
  the `source_label` / `changelog_label` columns; `test/resolver-boundary.test.ts` fails on
  a new reader.
- **One version key.** Match an image tag, a release name, a changelog heading or a file
  name through `versionKey` / `inRange` in `src/versions/key.ts`, never by stripping a `v`
  by hand. It already knows variants, LinuxServer builds, `pkg@1.2.3`, `version-` prefixes,
  dash-encoded versions and floating tags.
- **A failure to look is never `none`.** A rate limit, a timeout or a Hub budget stop is
  recorded as an error and retried with backoff. Only a clean answer is written as "nothing
  found", and a repository already found survives a failed lookup.
- **Bump `RESOLVER_VERSION`** whenever tier logic changes, so rows written by the old logic
  are looked at again.
- **Upstream calls go through the clients**: `src/upstream/github.ts` (classified failures,
  ETag cache) and `src/upstream/safe-fetch.ts` for any link an operator typed, which must
  never reach an address inside the lab. Tests use `test/helpers/http.ts` — `mockFetch`
  plus `assertAllMocked`, which catches the call a degrading caller would otherwise swallow
  — and mock DNS with `t.mock.method(dns.promises, 'lookup', …)`.
- **Measure before changing a tier.** `npm run resolve-report -- --dry-run --why` shows
  what a fresh look would find for every watched image without writing anything
  (`--allow-billed` includes the Docker Hub walk, `--without-overrides` shows what the
  curated map is still for). Run it against an online backup of the database, or in the
  container as `node dist/bin/resolve-report.js`.
- **The curated map is the last resort.** Add an entry only when no tier can find the
  repository; remove one when `--without-overrides` finds the same repository with
  certainty.

## Getting a change running

A change is not done when it is committed; it is done when it is running.

```
# from the PRIMARY checkout (/home/spencer/homelab), never a worktree --
# compose resolves relative volume paths and the project name from the checkout it runs in
docker compose -f shipshape/docker-compose.yaml up -d --build
curl -s http://<container-ip>:8080/health
node shipshape/app/bin/shots.mjs --base http://<container-ip>:8080 --label prod-after
```

Then commit the submodule pointer in the parent repo. shipshape excludes its own stack, so
it never updates itself — that rebuild is always by hand.
