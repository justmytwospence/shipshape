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
node bin/shots.mjs --base http://10.0.74.70:8080 --label prod     # the deployed container
```

It needs a CDP endpoint. This host is headless, so run one in a container that shares the
host's network (CDP stays bound to 127.0.0.1):

```
docker run -d --rm --name ss-chrome --network host --shm-size=1g \
  gcr.io/zenika-hub/alpine-chrome:124 --no-sandbox --disable-gpu \
  --disable-dev-shm-usage --remote-debugging-port=9222 --hide-scrollbars about:blank
```

Each shot runs layout probes and the contact sheet flags them: horizontal overflow,
nested scroll regions, and interactive targets under 44px. Treat a new flag as a
regression. `.shots/baseline` is the pre-redesign UI — keep it.

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
- Dialogs are `<dialog>` (`modal modal-bottom md:modal-end`), never a checkbox drawer:
  focus trap, Escape and backdrop dismissal come free and work on iOS.
- The phone is the primary target: 44px minimum touch targets, `env(safe-area-inset-*)`
  honoured at the bottom (dock, action bar, sheet) and the sides in landscape, and no
  information that exists only in a `title` attribute — touch has no hover.
- The theme is resolved before first paint by a small inline script from
  `localStorage['shipshape-theme']` (`auto | light | dark`); `auto` removes `data-theme`
  and lets daisyUI's `--prefersdark` follow the OS.
- Fetch current daisyUI 5 / Tailwind 4 docs with context7 rather than recalling v3/v4
  class names; the v4→v5 renames are extensive (`btm-nav`→`dock`, `card-bordered`→
  `card-border`, `form-control`→`fieldset`, `input-bordered` removed…).

## htmx contracts

Some behaviour depends on markup *shape*, which the type checker cannot see and a restyle
breaks silently. `test/web/htmx-contract.test.tsx` encodes those invariants — read it
before touching views. The load-bearing ones:

- A row is an `<a href>` that htmx upgrades on desktop; never a `<tr>` with a handler.
- The detail dialog and the toast container live **outside** every polled or swapped
  region, or a swap deletes the element mid-interaction.
- Polling attributes are only rendered while the thing is actually in flight, so the poll
  stops itself.
- htmx does not swap on a 4xx: an action that fails returns 200 with the unchanged
  fragment and a warning toast (`HX-Trigger`).

## Getting a change running

A change is not done when it is committed; it is done when it is running.

```
# from the PRIMARY checkout (/home/spencer/homelab), never a worktree --
# compose resolves relative volume paths and the project name from the checkout it runs in
docker compose -f shipshape/docker-compose.yaml up -d --build
curl -s http://10.0.74.70:8080/health
node shipshape/app/bin/shots.mjs --base http://10.0.74.70:8080 --label prod-after
```

Then commit the submodule pointer in the parent repo. shipshape excludes its own stack, so
it never updates itself — that rebuild is always by hand.
