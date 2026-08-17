import { test } from 'node:test'
import assert from 'node:assert/strict'
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

/** Tailwind escapes the characters that are not valid in a CSS identifier. */
function escapeClass(cls: string): string {
  return cls.replace(/[.:/[\]()%!#,+*~>&']/g, (ch) => `\\${ch}`)
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
  for (const cls of ['pb-safe', 'pb-dock', 'actionbar', 'tap', 'dl', 'tl-future']) {
    assert.ok(source.includes(`.${cls}`), `${cls} is declared`)
    if (cls === 'dl' || cls === 'tl-future') continue // rendered only with a diff or a soak
    assert.ok(rendered.has(cls), `${cls} is used by some view`)
  }
})

test('a page is a whole document and a fragment is not', () => {
  for (const key of ['inbox-page', 'update-page', 'layout', 'layout-setup']) {
    const html = VIEWS[key]!
    assert.match(html, /^<html lang="en"[ >]/, key)
    assert.match(html, /<\/html>$/, key)
    assert.match(html, /<title>[^<]+ · shipshape<\/title>/, key)
  }
  for (const key of ['inbox', 'update-detail', 'update-card', 'services', 'activity', 'settings']) {
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

test('the panel and the toasts live outside every swapped region', () => {
  // A detail panel rendered inside the list it was opened from disappears the moment
  // that list refreshes.
  const html = VIEWS['inbox-page']!
  const inbox = html.indexOf('id="inbox"')
  const sheet = html.indexOf('id="sheet"')
  const toasts = html.indexOf('id="toasts"')
  assert.ok(inbox > 0 && sheet > inbox && toasts > inbox)
  assert.doesNotMatch(VIEWS['inbox']!, /id="sheet"|id="toasts"/, 'and not in the fragment')
})

test('nothing important is hidden in a title attribute', () => {
  // A tooltip does not exist on a touch screen, which is where these decisions get made.
  for (const key of ['update-card', 'inbox']) {
    assert.doesNotMatch(VIEWS[key]!, /title="[^"]*confidence/i, key)
  }
  const card = VIEWS['update-card']!
  assert.match(card, /Read first/, 'the verdict is words, not a colour')
  assert.match(card, /medium/, 'and the confidence is on the card')
})

test('a row is a link, never a click handler on a table row', () => {
  // The old rows could not be opened by a keyboard at all.
  const row = VIEWS['update-row']!
  assert.match(row, /<a href="\/updates\/7"/)
  assert.doesNotMatch(row, /<tr[^>]*hx-get/, 'the tr itself carries no behaviour')
  assert.doesNotMatch(row, /onclick/)
  assert.match(VIEWS['update-card']!, /<a href="\/updates\/7"[^>]*data-row/)
})

test('a row loads the panel on a wide screen and navigates on a narrow one', () => {
  // One piece of markup, two behaviours: the trigger filter fails below lg, so the
  // browser follows the href instead.
  assert.match(
    VIEWS['update-card']!,
    /hx-trigger="click\[matchMedia\(&#39;\(min-width:1024px\)&#39;\)\.matches\]"/,
  )
})

test('a verb button targets its own card and cannot be double-fired', () => {
  const html = VIEWS['update-detail']!
  for (const m of html.matchAll(/<button[^>]*hx-post="([^"]+)"[^>]*>/g)) {
    const tag = m[0]
    assert.match(tag, /hx-target="#upd-\d+"/, tag)
    assert.match(tag, /hx-swap="outerHTML"/, tag)
    assert.match(tag, /hx-disabled-elt="this"/, tag)
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

test('only a card that is in flight polls', () => {
  assert.doesNotMatch(VIEWS['update-card']!, /hx-trigger="every/, 'a settled card is quiet')
  assert.match(VIEWS['update-card-transient']!, /hx-get="\/updates\/11\/card"[^>]*/)
  assert.match(VIEWS['update-card-transient']!, /every 5s/)
})

test('the scan poll stops when the scan does', () => {
  // Everything that polls during a scan keys off this id, which only exists while one
  // is running -- so the polls end with it rather than running all night.
  assert.match(RUNNING['inbox-page']!, /id="scan-running"/)
  assert.doesNotMatch(VIEWS['inbox-page']!, /id="scan-running"/)
  assert.equal(RUNNING['inbox-page']!.match(/id="scan-running"/g)?.length, 1)
})

test('a filter is one form, with every control inside it', () => {
  for (const key of ['settings']) {
    const forms = VIEWS[key]!.match(/<form/g)?.length ?? 0
    assert.ok(forms >= 1, key)
  }
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
