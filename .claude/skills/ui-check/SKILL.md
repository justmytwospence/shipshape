---
name: ui-check
description: Visually verify a shipshape UI change before calling it done — start the sandbox dev server, capture the phone/desktop × light/dark screenshot matrix, read the layout probes, and compare against the baseline. Use after any change to src/web/views/**, public/app.js, or src/styles/app.css, and whenever asked whether the UI "looks right", is responsive, works on a phone, or regressed.
allowed-tools: Bash(node bin/shots.mjs:*), Bash(node bin/dev-ui.mjs:*), Bash(npm run css:*), Bash(curl -sf --max-time 2 http://127.0.0.1:5858/json/version), Read, Glob, Grep
---

# Look at the UI before saying it works

Structure is testable; appearance is not. Two regressions shipped here that a green test
suite could not see. Never report a UI change as done on the strength of `npm test`.

## 1. Get a browser

```
curl -sf --max-time 2 http://127.0.0.1:5858/json/version   # Polypane, via the Mac's tunnel
curl -sf --max-time 2 http://127.0.0.1:9222/json/version   # the local headless container
```

If neither answers, start the container (host networking, so it reaches both the dev
server on 127.0.0.1 and the deployed container's address; CDP stays on 127.0.0.1):

```
docker run -d --rm --name ss-chrome --network host --shm-size=1g \
  -v "$PWD/bin/shots-fonts.conf:/etc/fonts/local.conf:ro" \
  gcr.io/zenika-hub/alpine-chrome:124 --no-sandbox --disable-gpu \
  --disable-dev-shm-usage --remote-debugging-port=9222 --hide-scrollbars about:blank
```

If Polypane *is* up, prefer it for interactive states (pane filled, dialog, keyboard
focus) through the `chrome-devtools` MCP server — it is a real browser at every
breakpoint at once. It is also the operator's own session: look, don't click through
merges, deploys or rollbacks.

## 2. Serve the app

```
npm run dev:ui          # :8081, sandbox database + throwaway checkout, scheduler off
npm run dev:ui -- --fresh   # re-snapshot the live database
npm run dev:ui -- --empty   # the unconfigured first-run state
```

Give it ~40s (better-sqlite3 rebuilds on first run) and check `curl -s
http://127.0.0.1:8081/health`. If `src/styles/app.css` exists, the Tailwind watcher runs
too; otherwise run `npm run css` yourself before shooting, or every class is missing.

## 3. Capture the matrix

```
node bin/shots.mjs --label <change> --routes <the routes you touched>
node bin/shots.mjs --label <change> --compare baseline      # side-by-side with the old UI
node bin/shots.mjs --label <change> --vp phone --scheme dark --full   # whole-page
```

Defaults are phone (390×844@3, touch) + desktop (1440×900) × light + dark. Then **read
the PNGs** — actually open them, do not just trust the probe output.

## 4. Read the probes

Every shot records them; `.shots/<label>/index.html` flags them and `probes.json` has the
detail:

| Flag | What it means | Usually |
|---|---|---|
| `horizontalOverflow` | the document is wider than the viewport | a `nowrap` table or a fixed width on a phone |
| `nestedScroll` (>1 scroller, phone only) | scroll regions inside scroll regions | an `overflow-y-auto` or fixed height that lost its `lg:` prefix |
| `smallTargets` (phone only) | interactive elements under 44px tall (40 for tabs) | icon buttons, link-styled buttons, dense row actions |
| `rowsVisible` | `[data-row]` elements on screen | should be 20+ on a list page at 1440×900, ~15 on a phone; a drop is a regression |

A flag that was not there before is a regression. On the phone shots also check by eye:
is the primary action reachable without scrolling sideways; is anything hidden behind the
dock; does the action bar clear the home indicator. On the desktop shots: does the list
fill its column, is the pane showing what the selected row is about, do the columns of
neighbouring rows line up.

## 5. Checklist before reporting done

- [ ] Phone and desktop, light and dark, for every route touched
- [ ] No new probe flags versus `--compare baseline`
- [ ] Dialog: opens, traps focus, closes on Escape and backdrop; body does not scroll behind
- [ ] Nothing conveyed only by colour, and nothing that exists only in a `title` (no hover on touch)
- [ ] Keyboard: visible focus ring, and the row/action reachable by Tab
- [ ] `npm test` and `npm run typecheck` still green (the CSS gate catches classes Tailwind never emitted)
