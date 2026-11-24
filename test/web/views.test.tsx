import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderAll, classesOf, builtCss, STATUS, SERVICE } from './fixtures.tsx'
import { ServiceDetail, ServicesList } from '../../src/web/views/ui/services.tsx'
import { StatusBody } from '../../src/web/views/ui/status.tsx'
import { UpdatesList } from '../../src/web/views/pages.tsx'

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
  'status-page',
  'layout',
  'layout-setup',
]
const FRAGMENTS = [
  'inbox',
  'inbox-setup',
  'inbox-paused',
  'inbox-aside',
  'update-detail',
  'update-row',
  'services',
  'service-detail',
  'service-detail-fork',
  'service-detail-fork-conflict',
  'update-detail-fork-conflict',
  'diff-fork',
  'activity',
  'settings',
  'status',
]

/** Tailwind escapes the characters that are not valid in a CSS identifier. */
function escapeClass(cls: string): string {
  return cls.replace(/[.:/[\]()%!#,+*~>&'=]/g, (ch) => `\\${ch}`)
}

/**
 * State classes owned by htmx or the browser, never declared by us -- and `ctx`, a diff
 * line's unstyled kind: `.dl.add` and `.dl.del` colour the other two, and the context row
 * is the plain `.dl`.
 */
const NOT_OURS = new Set(['htmx-request', 'htmx-indicator', 'htmx-settling', 'is-dirty', 'ctx'])

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
  for (const cls of ['pb-safe', 'pb-dock', 'actionbar', 'savebar', 'tap', 'scroll-x', 'dl', 'tl-future', 'dirty-note']) {
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
  assert.match(html, /<script src="\/static\/app\.js\?v=[0-9a-f]{10}"/)
  assert.match(readFileSync(join(import.meta.dirname, '../../public/app.js'), 'utf8'), /navigator\.serviceWorker\.register\('\/sw\.js'\)/)
})

test('both navigations exist, keyed to the same breakpoint', () => {
  const html = VIEWS['layout']!
  assert.match(html, /class="dock dock-sm lg:hidden"/, 'the dock is for narrow screens')
  assert.match(html, /drawer lg:drawer-open/, 'the sidebar takes over at the same width')
  const dock = html.slice(html.indexOf('class="dock'))
  const links = dock.slice(0, dock.indexOf('</nav>')).match(/<a /g)?.length
  // Six since Status became a destination of its own rather than a tab of Settings. The
  // number is asserted because the failure it guards against is a "More" menu: a phone
  // dock that hides a destination behind an overflow is worse than a tight one that
  // shows them all, and six labels is the point where that trade is still winnable.
  assert.equal(links, 6, 'six destinations, and no More menu hiding one of them')
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
    assert.equal(html.match(/id="conn"/g)?.length, 1, `${key}: one connection banner`)
  }
  for (const key of ['inbox', 'update-detail', 'services']) {
    assert.doesNotMatch(VIEWS[key]!, /id="pane"|id="toasts"|id="conn"/, `${key}: not in the fragment`)
  }
  assert.doesNotMatch(VIEWS['layout']!, /id="sheet"/, 'the modal sheet is gone')
})

test('only the desktop has inner scrollers', () => {
  // Below lg the document is the only thing that scrolls: nested scroll regions on a
  // touch screen are what the old dashboard got most wrong. Every fixed height and
  // every overflow on the frame is therefore behind the lg: prefix.
  for (const key of ['inbox-page', 'updates-page', 'services-page', 'activity-page', 'settings-page', 'status-page']) {
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

test('the scan is stated in words, and never twice', () => {
  // Status is the page the machine describes itself on, which is exactly why it drifted
  // into printing what the database happens to store: an epoch, a JSON object, and
  // counters named after their keys. Everything on it is for a person.
  const html = VIEWS['status']!
  assert.match(html, /62 up to date/, 'the tally reads as a sentence, not as JSON')
  assert.match(html, /45 unchanged/)
  assert.doesNotMatch(html, /\{&quot;|\{"/, 'no JSON object printed as itself')
  for (const key of ['scan.last_at', 'scan.last_counts', 'scan.last_duration_s']) {
    assert.doesNotMatch(
      html,
      new RegExp(key.replace(/\./g, '\\.')),
      `${key} is stated in words above, so it must not also appear as a database key`,
    )
  }
  assert.doesNotMatch(html, /1787389349759/, 'an epoch is not a time a person reads')
  // The Hub allowance counts down, and its bare number under a key name reads as the
  // opposite of what it means.
  assert.match(html, /180 of 200 left this hour/, 'the direction the number counts is said')
  assert.doesNotMatch(html, /200;w=3600/, 'the rate-limit header is not the sentence')
})

test('one of a thing is not called several of it', () => {
  const html = String(
    StatusBody({
      data: {
        ...STATUS,
        scan: { ...STATUS.scan, counts: { 'moved-pinned': 1, 'moved-rolling': 3 } },
      },
    }),
  )
  assert.match(html, /1 pinned digest moved/)
  assert.match(html, /3 rolling images moved/)
})

test('two ways of failing are one word to the person reading it', () => {
  // A registry that would not answer and a row that would not write are both an error
  // here; listed separately they read as "4 errors · 1 errors".
  const html = String(
    StatusBody({
      data: { ...STATUS, scan: { ...STATUS.scan, counts: { error: 4, 'persist-error': 1 } } },
    }),
  )
  assert.match(html, /5 errors/)
})

test('an outcome nobody has named still gets counted', () => {
  // The labels are a map, and a scan that grows a new outcome must not lose it silently
  // just because no word has been chosen yet -- it should look odd and get one.
  const html = String(
    StatusBody({
      data: { ...STATUS, scan: { ...STATUS.scan, counts: { 'brand-new-outcome': 2 } } },
    }),
  )
  assert.match(html, /2 brand-new-outcome/)
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

test('shipping, rolling back and skipping ask twice', () => {
  // Both change a running host. The confirm writes out what will happen.
  const html = VIEWS['update-detail']!
  assert.match(html, /data-open="#confirm-ship-7"/)
  assert.match(html, /id="confirm-ship-7"/)
  assert.match(html, /record it as a merge commit on main/)
  // Written from policy (here the defaults), not from constants.
  assert.match(html, /watch it for up to 5 minutes/)
  assert.match(html, /look again 30 minutes later/)
  const verified = VIEWS['update-verified']!
  assert.match(verified, /data-open="#confirm-rollback-13"/)
  assert.match(html, /data-open="#confirm-skip-7"/)
  assert.match(html, /id="confirm-skip-7"/)
})

test('the screen quotes the notes, links them, and says when nothing acted on it', () => {
  const html = VIEWS['update-screened']!
  assert.match(html, /<details>[\s\S]*Screen \(shadow\)/, 'folded away in shadow mode')
  assert.match(html, /Shadow mode: shown, not acted on/)
  assert.match(html, /Setting removed or renamed 93%/)
  assert.match(html, /Needs action/)
  assert.match(html, /href="https:\/\/github.com\/jellyfin\/jellyfin\/releases\/tag\/v10.10.3"/)
  assert.doesNotMatch(VIEWS['update-detail']!, /Screen \(shadow\)/, 'and is absent where there is no screen')
})

test('a lifeline service asks first, and says why on the page', () => {
  const html = VIEWS['update-attended']!
  assert.match(html, />class lifeline</)
  assert.match(html, />Ship<\/button>/)
  assert.match(html, /Waiting on you/)
  assert.match(html, /this service always asks/)
})

test('a verb that asks first asks from the overflow menu too', () => {
  // The menu used to post straight to the endpoint, so a verb chosen from it skipped the
  // confirmation the same verb gets as the primary button.
  const html = VIEWS['update-secondary-merge']!
  const start = html.indexOf('dropdown-content')
  const menu = html.slice(start, html.indexOf('</ul>', start))
  assert.match(menu, /data-verb="ship" data-open="#confirm-ship-/)
  assert.doesNotMatch(menu, /hx-post="\/updates\/\d+\/ship/)
})

test('a left-stopped update says so', () => {
  // The badge word, not Verified: nothing was started, and saying it soaked would be false.
  // Its colour, badge-ghost, is held to the stylesheet by the class gate above.
  const html = VIEWS['update-left-stopped']!
  assert.ok(html.includes('Left stopped'))
  assert.doesNotMatch(html, />Verified</)
  assert.match(html, /data-open="#confirm-rollback-14"/, 'Roll back is the one thing left to do')
})

test('a link is previewed before it is written, inside the dialog it was asked from', () => {
  const html = VIEWS['service-detail']!
  assert.match(html, /data-open="#link-media-jellyfin"/)
  assert.match(html, /<dialog id="link-media-jellyfin" class="modal modal-bottom sm:modal-middle">/)
  const dialog = html.slice(html.indexOf('<dialog id="link-media-jellyfin"'))
  const end = dialog.indexOf('</dialog>')
  assert.match(dialog, /hx-get="\/services\/media\/jellyfin\/link\/preview\?list=services"/)
  assert.match(dialog, /hx-target="#link-preview-media-jellyfin"/)
  // The preview lands inside the dialog, never in the pane behind it...
  const target = dialog.indexOf('id="link-preview-media-jellyfin"')
  assert.ok(target > 0 && target < end, 'the preview target is inside the dialog')
  // ...and nothing in the dialog writes on its own: the write form arrives with a preview.
  assert.doesNotMatch(dialog.slice(0, end), /hx-post/)

  const preview = VIEWS['link-preview']!
  assert.match(preview, /hx-post="\/services\/media\/jellyfin\/labels\?list=services"/)
  assert.match(preview, /hx-target="#svc-card-media-jellyfin"/)
  assert.match(preview, /name="source" value="jellyfin\/jellyfin"/)
  assert.match(preview, /Write it to the compose file/)
  assert.doesNotMatch(VIEWS['link-preview-refused']!, /hx-post/, 'a refused link offers no write')
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
    assert.match(html, /role="radiogroup"/, key)
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

test('the settings nav is a map of the form: it glides to a section and marks the one you are in', () => {
  const html = VIEWS['settings-page']!
  assert.match(html, /<nav data-spy[^>]*>/, 'the nav is the scroll-spy root')
  assert.match(html, /<a href="#shipping"/, 'anchors, scrolled natively')
  assert.match(html, /id="shipping"[^>]*class="[^"]*scroll-mt-2/, 'sections land under the top edge')
  assert.match(html, /id="pane"[^>]*class="[^"]*lg:scroll-smooth/, 'the pane glides rather than jumps')
  const appJs = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8')
  assert.match(appJs, /\[data-spy\][\s\S]{0,1200}aria-current/, 'app.js marks the current section')
  // The other panes are swapped whole, where an animated scroll-to-top reads as a stutter.
  assert.doesNotMatch(VIEWS['updates-page']!, /lg:scroll-smooth/)
})

test('an unchecked switch still says off', () => {
  // A checkbox that is not ticked sends nothing at all, which would read as "leave it
  // alone" rather than "turn it off".
  const html = VIEWS['settings']!
  assert.match(html, /<input type="hidden" name="paused" value="false"\/>/)
  assert.match(html, /<input id="paused" type="checkbox" name="paused" value="true"/)
})

test('the settings form knows what unpausing will not do', () => {
  assert.match(VIEWS['settings']!, /2 shipped updates are waiting for a deploy/)
})

test('a service says where each of its settings came from', () => {
  const html = VIEWS['service-detail']!
  for (const source of ['label', 'locked', 'inferred']) {
    assert.match(html, new RegExp(`>${source}</span>`), source)
  }
  assert.match(html, /media\/docker-compose\.yaml/, 'and which file it is in')
  // A note is shown as text under its value, not hidden in a title a phone cannot hover.
  assert.match(html, />label on media\/jellyfin-web, which runs the same image</, 'and why, when there is more to say')
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
  assert.match(html, /ships on its own unless a hold says/i, 'the section says what it is for')
  assert.match(html, /Pause stops that, and nothing else/, 'including the part that surprises people')
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

test('a snoozed decision says so, and keeps ship on offer', () => {
  const html = VIEWS['update-detail-hold']!
  assert.match(html, />Ship<\/button>/)
  assert.doesNotMatch(html, /Release hold/, 'the v1 hold verb is gone')
  assert.doesNotMatch(html, /badge[^"]*">\s*Held/)
})

test('a decision lists what it is waiting on, and nothing else says so', () => {
  assert.match(VIEWS['update-detail']!, /Waiting on you[\s\S]*this service always asks/)
  assert.doesNotMatch(VIEWS['update-verified']!, /Waiting on you/)
})

test('a link the model or a feed supplied is only ever http(s)', async () => {
  const { update } = await import('./fixtures.tsx')
  const { UpdateDetail } = await import('../../src/web/views/ui/update.tsx')
  const u = update()
  const html = String(
    UpdateDetail({
      update: { ...u, verdict: { ...u.verdict!, sources: ['javascript://github.com/%0aalert(1)', 'https://github.com/a/b'] } },
      milestones: [],
      warnings: [],
      ctx: '',
      listHref: '/updates',
    }),
  )
  assert.doesNotMatch(html, /javascript:/)
  assert.match(html, /href="https:\/\/github\.com\/a\/b"/)
})

test('every outbound link goes through ExtLink', async () => {
  const { readdirSync } = await import('node:fs')
  const root = join(import.meta.dirname, '../../src/web/views')
  const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('.tsx'))
  const hits = files.flatMap((f) => (readFileSync(join(root, f), 'utf8').match(/target="_blank"/g) ?? []).map(() => f))
  assert.deepEqual(hits, ['ui/parts.tsx'])
})

test('no view carries an inline event handler or an inline script but the theme', () => {
  for (const [name, html] of Object.entries(VIEWS)) {
    assert.doesNotMatch(html, /\son[a-z]+="/, name)
    const inline = html.match(/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?<\/script>/g) ?? []
    assert.ok(inline.length <= 1, `${name}: ${inline.length} inline scripts`)
    for (const s of inline) assert.match(s, /shipshape-theme/, `${name}: the only inline script is the theme`)
  }
})

test('htmx is configured for the CSP', () => {
  const html = VIEWS['layout']!
  for (const k of ['allowEval', 'includeIndicatorStyles', 'allowScriptTags']) {
    assert.match(html, new RegExp(`&quot;${k}&quot;:false`), k)
  }
})

test('the inbox scan poll needs no eval', () => {
  const html = VIEWS['inbox-page'] ?? VIEWS['inbox']!
  assert.match(html, /hx-trigger="every 60s, scan-progress from:body"/)
  assert.doesNotMatch(html, /\[document/)
})

test('a new install is told what to do next, in order', () => {
  const html = VIEWS['inbox-setup']!
  assert.match(html, /Getting started/)
  assert.match(html, /1 of 3 done/)
  assert.match(html, /href="\/services\?filter=unwatched"/)
  assert.doesNotMatch(html, /Nothing needs you/)
})

test('a finished setup shows no checklist', () => {
  assert.doesNotMatch(VIEWS.inbox!, /Getting started/)
})

test('updates held only by pause are listed under their own heading', () => {
  assert.match(VIEWS['inbox-paused']!, /Ships when you unpause/)
  assert.doesNotMatch(VIEWS['inbox-paused']!, /Nothing needs you/)
})

test('an empty list says why it is empty', () => {
  assert.match(String(UpdatesList({ updates: [], ctx: 'list=updates', total: 0 })), /No updates yet/)
  assert.match(String(UpdatesList({ updates: [], ctx: 'list=updates', total: 3 })), /Nothing matches/)
})

const watchData = (over: Record<string, unknown>) => ({
  svc: { ...SERVICE, watched: false },
  composeFile: 'media/docker-compose.yaml',
  config: [{ key: 'watch', value: 'off', source: 'label' as const }],
  history: [],
  canEdit: true,
  canWatch: true,
  watchPattern: 'semver',
  ...over,
})

test('a service that is not watched offers to watch it, and says what that writes', () => {
  const html = String(ServiceDetail({ data: watchData({}) as never, ctx: 'list=services' }))
  assert.match(html, /Watch this service/)
  assert.match(html, /name="key" value="watch"/)
  assert.match(html, /shipshape\.watch: &quot;true&quot;/)
  assert.match(html, /compared as semver/)
})

test('a tag shipshape cannot read says so before it is watched', () => {
  const html = String(ServiceDetail({ data: watchData({ watchPattern: null }) as never, ctx: 'list=services' }))
  assert.match(html, /cannot tell how/)
})

test('the Not watched filter offers to watch them all', () => {
  const html = String(
    ServicesList({
      services: [{ ...SERVICE, watched: false }],
      grouped: false,
      ctx: 'list=services&filter=unwatched',
      filter: 'unwatched',
      q: '',
      total: 1,
    }),
  )
  assert.match(html, /Watch all 1/)
  assert.match(html, /hx-post="\/services\/watch"/)
})

test('the interface never says pull request, or points at a file that is not here', () => {
  for (const [name, html] of Object.entries(VIEWS)) {
    assert.doesNotMatch(html, /pull request|\bPRs?\b|FORKS\.md|Hermes|\bJev\b|homelab/i, name)
  }
})

test('fork copy links the forks guide', () => {
  for (const name of ['update-detail-fork-conflict', 'service-detail-fork']) {
    assert.match(VIEWS[name]!, /guides\/forks\//, name)
  }
})

test('the toast host is not itself a live region', () => {
  assert.doesNotMatch(VIEWS.layout!, /id="toasts"[^>]*aria-live/)
})

test('every time a person reads is a <time> the browser can refresh', () => {
  assert.match(VIEWS.activity!, /<time datetime="[^"]+" data-format="clock"/)
  assert.match(VIEWS['update-row']!, /data-format="relative"/)
})

test('the page says which zone its times are in', () => {
  assert.match(VIEWS.layout!, /<html lang="en" data-tz="[^"]+"/)
})

test('a schedule names its zone', async () => {
  const { describeCron } = await import('../../src/web/views/ui/settings.tsx')
  assert.equal(describeCron('0 0 3 * * *', 'UTC'), 'Every day at 03:00 (UTC)')
  assert.equal(describeCron('0 0 3 * * *'), 'Every day at 03:00')
  assert.equal(describeCron('30 4 * * *'), 'Every day at 04:30')
  assert.equal(describeCron('*/5 * * * * *', 'UTC'), null)
})

test('assets are addressed by their content', () => {
  assert.match(VIEWS.layout!, /href="\/static\/app\.css\?v=[0-9a-f]{10}"/)
})

test('the brand is the mark, not a stock glyph', () => {
  assert.match(VIEWS.layout!, /viewBox="96 96 320 336"/)
  assert.match(readFileSync('public/icon.svg', 'utf8'), /#006eb3/)
})

test('the phone bar says whether shipshape ships on its own', () => {
  const html = VIEWS.layout!
  assert.match(html, /class="tap order-1 flex h-11[^"]*lg:hidden"/)
  assert.match(html, />Paused</)
  assert.doesNotMatch(html, /Nothing merges/)
})

test('the theme can be changed on a phone', () => {
  const html = VIEWS['settings-page']!
  const m = /<section id="on-this-device" class="([^"]*)"/.exec(html)
  assert.ok(m, 'the section is rendered')
  assert.doesNotMatch(m![1]!, /hidden/)
  const section = html.slice(m!.index)
  assert.match(section, /data-set-theme="dark"/)
})

test('group headers are headings', () => {
  assert.match(VIEWS.inbox!, /<h2 class="bg-base-100 border-base-300 sticky top-0/)
  assert.match(VIEWS['service-detail']!, /<h3 class="bg-base-100/)
})

test('a skip link leads to the content', () => {
  assert.match(VIEWS.layout!, /href="#main"[^>]*>\s*Skip to content\s*</)
  assert.match(VIEWS.layout!, /<main id="main" tabindex="-1"/)
})

test('the pane heading can take focus', () => {
  assert.match(VIEWS['update-detail']!, /<h2(?=[^>]*tabindex="-1")(?=[^>]*data-pane-heading)/)
})

test('no text is fainter than opacity-70', () => {
  for (const [name, html] of Object.entries(VIEWS)) {
    for (const m of html.matchAll(/<(\w+)[^>]*class="[^"]*\bopacity-(?:50|55|60)\b/g)) {
      assert.ok(m[1] === 'svg' || m[1] === 'img', `${name}: <${m[1]}> ${m[0].slice(0, 120)}`)
    }
  }
})

test("a log line's severity is said, not only coloured", () => {
  assert.match(VIEWS.activity!, /class="sr-only">(Warning|Error):</)
})

test('a list says what its columns are', () => {
  assert.match(VIEWS['updates-page']!, /aria-hidden="true" class="bg-base-100[^"]*lg:grid[^"]*">[\s\S]*?>Review</)
  assert.match(VIEWS['services-page']!, />Class</)
})

test('review pending is said only while a review is coming', async () => {
  const { update } = await import('./fixtures.tsx')
  const { UpdateRow } = await import('../../src/web/views/ui/update.tsx')
  const pending = update({ verdict: null, state: 'detected', shipStatus: 'waiting', shipWhy: 'review pending' })
  assert.match(String(UpdateRow({ update: pending, ctx: 'list=updates' })), /Review pending/)
  const paused = update({ verdict: null, state: 'detected', shipStatus: 'waiting', shipWhy: 'paused' })
  assert.doesNotMatch(String(UpdateRow({ update: paused, ctx: 'list=updates' })), /Review pending/)
})

test('a pane says why nothing will read the notes', async () => {
  const { update, MILESTONES } = await import('./fixtures.tsx')
  const { UpdateDetail } = await import('../../src/web/views/ui/update.tsx')
  const html = String(
    UpdateDetail({ update: update({ verdict: null, reviewOff: 'no model provider is set' }), milestones: MILESTONES, ctx: 'list=updates' }),
  )
  assert.match(html, /Nothing will read this version(&#39;|')s release notes: no model provider is set/)
})

test('Status lists recent deploys in words', () => {
  assert.match(VIEWS.status!, /Recent deploys/)
  assert.match(VIEWS.status!, />Verified</)
  assert.match(VIEWS.status!, /after a ship/)
})

test('a setting that was refused says why beside itself', async () => {
  const { SettingsForm } = await import('../../src/web/views/ui/settings.tsx')
  const { SETTINGS } = await import('../../src/settings/defs.ts')
  const def = SETTINGS.find((d) => d.kind === 'int' && !d.locked)!
  const html = String(
    SettingsForm({
      groups: [{ title: 'X', tagline: 'x', items: [{ def, value: '-1', changed: true, error: 'must be at least 0' }], more: [] }] as never,
    }),
  )
  assert.match(html, /aria-invalid="true"/)
  assert.match(html, /aria-describedby="[^"]*-error/)
  assert.match(html, /class="text-error mt-0\.5 text-xs">must be at least 0</)
})

test('number settings are number inputs with a floor', async () => {
  const { SettingsForm } = await import('../../src/web/views/ui/settings.tsx')
  const { SETTINGS } = await import('../../src/settings/defs.ts')
  const def = SETTINGS.find((d) => d.kind === 'int' && !d.locked && d.min !== undefined)!
  const html = String(SettingsForm({ groups: [{ title: 'X', tagline: 'x', items: [{ def, value: '3', changed: false }], more: [] }] as never }))
  assert.match(html, /type="number"[^>]*min="\d/)
})

test('rules read as words', async () => {
  const { RulesList } = await import('../../src/web/views/ui/settings.tsx')
  const html = String(RulesList({ rules: [{ id: 'r1', match: { image: 'ghcr.io/example/app' }, waive: ['ask'], because: 'x' }] as never }))
  assert.match(html, /every service running ghcr\.io\/example\/app, waiving ask/)
})
