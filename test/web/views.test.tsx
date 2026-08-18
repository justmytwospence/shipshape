import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderAll, classesOf, builtCss } from './fixtures.tsx'

/**
 * What the markup has to be true of, independent of how it looks.
 *
 * The gate below is the load-bearing one. Tailwind only emits CSS for classes it can see
 * in the source, so a class built by interpolation -- `badge-${kind}` -- produces no rule
 * at all and fails silently, rendering as unstyled text. That is the same failure the old
 * suite caught for hand-written CSS, in a new form, and it is why the colour maps in the
 * views hold whole class strings.
 */

const VIEWS = renderAll()
const RUNNING = renderAll({ running: true })

const PAGES = [
  'inbox-page',
  'inbox-detail-page',
  'updates-page',
  'update-page',
  'services-page',
  'service-page',
  'activity-page',
  'settings-page',
  'layout',
  'layout-setup',
]
const FRAGMENTS = [
  'inbox',
  'inbox-aside',
  'update-detail',
  'update-row',
  'services',
  'service-detail',
  'activity',
  'settings',
  'status',
]

/** Tailwind escapes the characters that are not valid in a CSS identifier. */
function escapeClass(cls: string): string {
  return cls.replace(/[.:/[\]()%!#,+*~>&'=]/g, (ch) => `\\${ch}`)
}

/** State classes owned by htmx or the browser, never declared by us. */
const NOT_OURS = new Set(['htmx-request', 'htmx-indicator', 'htmx-settling', 'is-dirty'])

test('every class a view emits exists in the built stylesheet', () => {
  const css = builtCss()
  const missing = new Set<string>()
  for (const [name, html] of Object.entries(VIEWS)) {
    for (const cls of classesOf(html)) {
      if (NOT_OURS.has(cls)) continue
      if (!css.includes(`.${escapeClass(cls)}`)) missing.add(`${cls} (in ${name})`)
    }
  }
  assert.deepEqual(
    [...missing],
    [],
    'these classes produce no CSS -- usually a name built by interpolation, which Tailwind cannot see',
  )
})

test('every bespoke class is actually used', () => {
  // The other direction: a rule in the hand-written layer that nothing renders is dead
  // weight that outlives the markup it was for.
  const source = builtCss()
  const rendered = new Set(Object.values(VIEWS).flatMap((h) => classesOf(h)))
  for (const cls of ['pb-safe', 'pb-dock', 'actionbar', 'savebar', 'tap', 'scroll-x', 'dl', 'tl-future']) {
    assert.ok(source.includes(`.${cls}`), `${cls} is declared`)
    if (cls === 'dl' || cls === 'tl-future') continue // rendered only with a diff or a soak
    assert.ok(rendered.has(cls), `${cls} is used by some view`)
  }
})

test('a page is a whole document and a fragment is not', () => {
  for (const key of PAGES) {
    const html = VIEWS[key]!
    assert.match(html, /^<html lang="en"[ >]/, key)
    assert.match(html, /<\/html>$/, key)
    assert.match(html, /<title>[^<]+ · shipshape<\/title>/, key)
  }
  for (const key of FRAGMENTS) {
    assert.doesNotMatch(VIEWS[key]!, /<html[ >]|<head>|<body[ >]/, key)
  }
})

test('the theme is resolved before the stylesheet loads', () => {
  // Any later and the page paints light, then repaints dark.
  const html = VIEWS['layout']!
  const script = html.indexOf('shipshape-theme')
  const css = html.indexOf('/static/app.css')
  assert.ok(script > 0 && css > 0 && script < css, 'theme script precedes the stylesheet')
  assert.doesNotMatch(html.slice(0, css), /<script[^>]*defer[^>]*>\(function/, 'and is not deferred')
})

test('the installable bits are all present', () => {
  const html = VIEWS['layout']!
  assert.match(html, /viewport-fit=cover/)
  // Without credentials the manifest fetch follows Authelia's redirect and fails to
  // parse, leaving the app silently non-installable while still answering 200.
  assert.match(html, /rel="manifest"[^>]*crossorigin="use-credentials"/)
  assert.equal(html.match(/name="theme-color"/g)?.length, 2, 'one per colour scheme')
  assert.match(html, /apple-mobile-web-app-capable/)
  assert.match(html, /rel="apple-touch-icon"/)
  assert.match(html, /navigator\.serviceWorker\.register\('\/sw\.js'\)/)
})

test('both navigations exist, keyed to the same breakpoint', () => {
  const html = VIEWS['layout']!
  assert.match(html, /class="dock dock-sm lg:hidden"/, 'the dock is for narrow screens')
  assert.match(html, /drawer lg:drawer-open/, 'the sidebar takes over at the same width')
  const dock = html.slice(html.indexOf('class="dock'))
  const links = dock.slice(0, dock.indexOf('</nav>')).match(/<a /g)?.length
  assert.equal(links, 5, 'five destinations, and no More menu hiding one of them')
})

test('back and forward are reloads, not snapshots', () => {
  // The lists poll, so a cached snapshot restores stale rows; an inner scroller cannot
  // be restored anyway; and a 149-row page runs into the localStorage quota.
  assert.match(VIEWS['layout']!, /name="htmx-config" content="\{[^"]*&quot;historyCacheSize&quot;:0/)
})

test('the pane and the toasts live outside every swapped region', () => {
  // A pane rendered inside the list it was opened from disappears the moment that list
  // refreshes -- and there is exactly one of each, or a swap by id picks the wrong one.
  for (const key of ['inbox-page', 'updates-page', 'services-page']) {
    const html = VIEWS[key]!
    const list = html.indexOf('id="list"')
    const pane = html.indexOf('id="pane"')
    const toasts = html.indexOf('id="toasts"')
    assert.ok(list > 0 && pane > list && toasts > pane, key)
    assert.equal(html.match(/id="pane"/g)?.length, 1, `${key}: one pane`)
    assert.equal(html.match(/id="toasts"/g)?.length, 1, `${key}: one toast host`)
  }
  for (const key of ['inbox', 'update-detail', 'services']) {
    assert.doesNotMatch(VIEWS[key]!, /id="pane"|id="toasts"/, `${key}: not in the fragment`)
  }
  assert.doesNotMatch(VIEWS['layout']!, /id="sheet"/, 'the modal sheet is gone')
})

test('only the desktop has inner scrollers', () => {
  // Below lg the document is the only thing that scrolls: nested scroll regions on a
  // touch screen are what the old dashboard got most wrong. Every fixed height and
  // every overflow on the frame is therefore behind the lg: prefix.
  for (const key of ['inbox-page', 'updates-page', 'services-page', 'activity-page', 'settings-page']) {
    const html = VIEWS[key]!
    for (const m of html.matchAll(/<(?:section|div|main|body)[^>]*class="([^"]*)"/g)) {
      for (const cls of m[1]!.split(/\s+/)) {
        if (/^(overflow-|h-dvh|max-h-)/.test(cls)) {
          assert.fail(`${key}: "${cls}" scrolls on a phone -- prefix it lg:`)
        }
      }
    }
  }
})

test('nothing important is hidden in a title attribute', () => {
  // A tooltip does not exist on a touch screen, which is where these decisions get made.
  for (const key of ['update-row', 'inbox']) {
    assert.doesNotMatch(VIEWS[key]!, /title="[^"]*confidence/i, key)
  }
  const row = VIEWS['update-row']!
  assert.match(row, /Read first/, 'the verdict is words, not a colour')
  assert.match(row, /medium/, 'and the confidence is on the row')
})

test('a row is a link that fills the pane on a wide screen and navigates on a narrow one', () => {
  // The old rows could not be opened by a keyboard at all. One piece of markup, two
  // behaviours: the trigger filter fails below lg, so the browser follows the href.
  const row = VIEWS['update-row']!
  assert.match(row, /<a href="\/updates\/7\?list=inbox"[^>]*data-row/, 'the href carries the list, for the phone')
  assert.doesNotMatch(row, /<tr/, 'no table')
  assert.doesNotMatch(row, /onclick/)
  assert.match(row, /hx-get="\/updates\/7\/panel\?list=inbox"/)
  assert.match(row, /hx-target="#pane"/)
  assert.match(row, /hx-swap="innerHTML scroll:top"/)
  assert.match(row, /hx-push-url="\/updates\/7\?list=inbox"/, 'the URL says which list it came from')
  // Not a `click[matchMedia(...)]` trigger filter: htmx cancels an anchor's default click
  // before it evaluates the filter, so that left the phone with rows that did nothing.
  // The phone/desktop split is a capture-phase listener in app.js.
  assert.doesNotMatch(row, /hx-trigger="click\[/)
  const appJs = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8')
  assert.match(appJs, /closest\('\[data-row\]'\)[\s\S]{0,80}stopPropagation/, 'app.js gates the row')
  assert.match(appJs, /'click',\s*function[\s\S]{0,300}?\},\s*true,?\s*\)/, 'in the capture phase')
  const svc = VIEWS['services']!
  assert.match(svc, /<a href="\/services\/media\/jellyfin\?list=services"[^>]*data-row/)
  assert.match(svc, /hx-push-url="\/services\/media\/jellyfin\?list=services"/)
})

test('a direct load of a detail marks its row and fills its pane', () => {
  // What a reload, a bookmark or a notification link produces: the same page the row
  // would have made, drawn whole by the server so there is no flash of unselected list.
  const html = VIEWS['update-page']!
  assert.match(html, /<a href="\/updates\/7\?[^"]*"[^>]*aria-current="true"/)
  assert.doesNotMatch(html, /<a href="\/updates\/8\?[^"]*"[^>]*aria-current="true"/)
  assert.match(html, /id="upd-7-detail"/, 'the pane holds the detail')
  const svc = VIEWS['service-page']!
  assert.match(svc, /<a href="\/services\/media\/jellyfin\?[^"]*"[^>]*aria-current="true"/)
  assert.match(svc, /id="svc-card-media-jellyfin"/)
})

test('a verb pressed in the pane redraws the pane, not the row', () => {
  // They shared an id for a while, so Deploy in the pane replaced a row off to the left.
  const pane = VIEWS['update-detail']!
  for (const m of pane.matchAll(/<button[^>]*hx-post="([^"]+)"[^>]*>/g)) {
    const tag = m[0]
    assert.match(tag, /hx-target="#upd-7-detail"/, tag)
    assert.match(tag, /hx-swap="outerHTML"/, tag)
    assert.match(tag, /hx-disabled-elt="this"/, tag)
    assert.match(m[1]!, /view=detail/, 'and asks for the pane back')
  }
  const rows = VIEWS['inbox']!
  for (const m of rows.matchAll(/<button[^>]*hx-post="([^"]+)"[^>]*>/g)) {
    assert.match(m[0], /hx-target="#upd-\d+"/, m[0])
    assert.match(m[1]!, /view=row&amp;list=inbox/, 'a row asks for a row back')
  }
})

test('merging and rolling back ask twice', () => {
  // Both change a running host. The confirm writes out what will happen.
  const html = VIEWS['update-detail']!
  assert.match(html, /data-open="#confirm-merge-deploy-7"/)
  assert.match(html, /id="confirm-merge-deploy-7"/)
  assert.match(html, /squash #41 into main/)
  assert.match(html, /soak for thirty more/)
  const verified = VIEWS['update-verified']!
  assert.match(verified, /data-open="#confirm-rollback-13"/)
})

test('only a row that is in flight polls', () => {
  assert.doesNotMatch(VIEWS['update-row']!, /hx-trigger="every/, 'a settled row is quiet')
  assert.match(VIEWS['update-row-transient']!, /hx-get="\/updates\/11\/card\?list=inbox"/)
  assert.match(VIEWS['update-row-transient']!, /every 5s/)
})

test('the scan poll stops when the scan does', () => {
  // Everything that polls during a scan keys off this id, which only exists while one
  // is running -- so the polls end with it rather than running all night.
  assert.match(RUNNING['inbox-page']!, /id="scan-running"/)
  assert.doesNotMatch(VIEWS['inbox-page']!, /id="scan-running"/)
  assert.equal(RUNNING['inbox-page']!.match(/id="scan-running"/g)?.length, 1)
})

test('a filter is a segmented control that asks the page for its list', () => {
  // daisyUI's `filter` hides every unselected option until hover, which on a phone left
  // the single word "Open". And a form that pushed a /fragments/ URL reloaded as a bare
  // fragment.
  for (const key of ['updates-page', 'services-page', 'activity-page']) {
    const html = VIEWS[key]!
    assert.match(html, /role="tablist"/, key)
    assert.doesNotMatch(html, /class="filter"/, key)
    const form = html.match(/<form[^>]*hx-push-url="true"[^>]*>/)?.[0] ?? ''
    assert.match(form, /hx-get="\/(updates|services|activity)"/, `${key}: ${form}`)
    assert.doesNotMatch(form, /fragments/, key)
  }
})

test('the toolbar counts what the list shows', () => {
  for (const key of ['updates-page', 'services-page', 'activity-page']) {
    assert.match(VIEWS[key]!, /id="list-count"/, key)
    assert.equal(VIEWS[key]!.match(/id="list-count"/g)?.length, 1, `${key}: once`)
  }
  assert.match(VIEWS['updates-page']!, />3 shown</)
})

test('an unchecked switch still says off', () => {
  // A checkbox that is not ticked sends nothing at all, which would read as "leave it
  // alone" rather than "turn it off".
  const html = VIEWS['settings']!
  assert.match(html, /<input type="hidden" name="paused" value="false"\/>/)
  assert.match(html, /<input id="paused" type="checkbox" name="paused" value="true"/)
})

test('the settings form knows what unpausing will not do', () => {
  assert.match(VIEWS['settings']!, /2 merged updates are waiting for a deploy/)
})

test('a service says where each of its settings came from', () => {
  const html = VIEWS['service-detail']!
  for (const source of ['label', 'locked', 'inferred']) {
    assert.match(html, new RegExp(`>${source}</span>`), source)
  }
  assert.match(html, /media\/docker-compose\.yaml/, 'and which file it is in')
  assert.match(html, /list=service&amp;stack=media&amp;service=jellyfin/, 'its history rows lead back here')
})

test('a repeated log line is one row with a count', () => {
  const html = VIEWS['activity']!
  assert.match(html, /×14/)
  assert.equal(html.match(/changelog analysis failed/g)?.length, 1)
})

test('a settings section explains itself, without linking away', () => {
  // The prose was a separate page for a while, which meant answering "what does this
  // actually do" cost a page load and a scroll back to the control you were looking at.
  const html = VIEWS['settings']!
  assert.match(html, /how much happens without you/i, 'the section says what it is for')
  assert.match(html, /always wait for a person/, 'including the part that surprises people')
  assert.doesNotMatch(html, /Learn more/, 'and does not send you elsewhere for it')
  assert.doesNotMatch(html, /href="\/docs/, 'there is no separate docs page to send you to')
})

test('a failed review says so, with what it will do next', () => {
  const html = VIEWS['update-review-failed']!
  assert.match(html, /Review failed — attempt 3/)
  assert.match(html, /Trying again/)
})

test('the setup banner names what is missing', () => {
  assert.match(VIEWS['layout-setup']!, /REPO_DIR/)
  assert.match(VIEWS['layout-setup']!, /not configured yet/)
})

test('the banner points at the switch, not at the top of the page it sits on', () => {
  // "Paused — Change" used to land you at the top of Settings with the switch halfway
  // down it, which reads exactly like a link that did nothing.
  assert.match(VIEWS['layout']!, /href="\/settings#pause"/)
})
