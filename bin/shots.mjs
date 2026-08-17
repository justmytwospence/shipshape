/**
 * Look at the UI, at every size, in both colour schemes.
 *
 * There is no display on this host, so layout changes used to ship blind -- and twice
 * that produced a regression the tests could not see (a sticky header that did not
 * stick, a flex chain that clipped the page). Structure is testable; layout has to be
 * looked at. This drives a headless Chrome over CDP, captures a matrix of
 * route x viewport x colour-scheme, runs layout probes on each, and writes a contact
 * sheet you can open in one go.
 *
 * It needs a CDP endpoint. On a machine with no browser, the shortest path is a
 * container sharing the host's network:
 *
 *   docker run -d --rm --name ss-chrome --network host --shm-size=1g \
 *     gcr.io/zenika-hub/alpine-chrome:124 --no-sandbox --disable-gpu \
 *     --disable-dev-shm-usage --remote-debugging-port=9222 --hide-scrollbars about:blank
 *
 * With --network host it reaches both the dev server on 127.0.0.1 and the deployed
 * container's address, and CDP stays bound to 127.0.0.1. Pass --cdp to point elsewhere
 * (a local Chrome, or Polypane's --remote-debugging-port).
 *
 * Usage:
 *   node bin/shots.mjs --label baseline
 *   node bin/shots.mjs --base http://10.0.74.70:8080 --label prod-before
 *   node bin/shots.mjs --routes / /updates --vp phone --scheme dark --full
 *   node bin/shots.mjs --label after --compare baseline
 *
 * Zero dependencies: Node 22 ships fetch and WebSocket.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const VIEWPORTS = {
  phone: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, touch: true },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true, touch: true },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, touch: false },
  wide: { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, touch: false },
}

// Every page the app serves. Fragments are not screenshotted -- they have no chrome.
const DEFAULT_ROUTES = ['/', '/images', '/activity', '/system', '/settings']

function parseArgs(argv) {
  const out = {
    base: 'http://127.0.0.1:8081',
    cdp: 'http://127.0.0.1:9222',
    label: 'shots',
    routes: DEFAULT_ROUTES,
    vp: ['phone', 'desktop'],
    scheme: ['light', 'dark'],
    theme: 'auto',
    full: false,
    compare: null,
    probe: null,
    outDir: null,
  }
  const list = (v) => String(v).split(',').filter(Boolean)
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    // `--vp phone desktop` and `--vp phone,desktop` should both work.
    const many = (first) => {
      const acc = [...first]
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) acc.push(...list(argv[++i]))
      return acc
    }
    if (a === '--base') out.base = next().replace(/\/$/, '')
    else if (a === '--cdp') out.cdp = next().replace(/\/$/, '')
    else if (a === '--label') out.label = next()
    else if (a === '--vp') out.vp = many(list(next()))
    else if (a === '--scheme') out.scheme = many(list(next()))
    else if (a === '--theme') out.theme = next()
    else if (a === '--full') out.full = true
    else if (a === '--compare') out.compare = next()
    else if (a === '--probe') out.probe = next()
    else if (a === '--out') out.outDir = next()
    else if (a === '--routes') {
      out.routes = []
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.routes.push(argv[++i])
    } else if (a === '--help' || a === '-h') {
      console.log(readFileSync(new URL(import.meta.url)).toString().split('*/')[0])
      process.exit(0)
    } else throw new Error(`unknown argument: ${a}`)
  }
  for (const v of out.vp) if (!VIEWPORTS[v]) throw new Error(`unknown viewport: ${v}`)
  return out
}

/** One CDP session against one target. */
class Session {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.events = []
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? reject(new Error(m.error.message)) : resolve(m.result ?? {})
      } else if (m.method) this.events.push(m)
    }
  }
  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((res, rej) => {
      ws.onopen = res
      ws.onerror = () => rej(new Error(`cannot connect to ${wsUrl}`))
    })
    return new Session(ws)
  }
  send(method, params = {}) {
    const n = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(n, { resolve, reject })
      this.ws.send(JSON.stringify({ id: n, method, params }))
      setTimeout(() => {
        if (this.pending.has(n)) {
          this.pending.delete(n)
          reject(new Error(`${method} timed out`))
        }
      }, 30_000)
    })
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'evaluate failed')
    return r.result?.value
  }
  close() {
    this.ws.close()
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * The probes are the point of the exercise: a screenshot shows you a phone layout is
 * wrong, these tell you which invariant it broke, and they run on every shot for free.
 */
const PROBE_JS = `(() => {
  const doc = document.documentElement
  const small = []
  for (const el of document.querySelectorAll('a,button,input,select,summary,[role=button]')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    const s = getComputedStyle(el)
    if (s.visibility === 'hidden' || s.display === 'none') continue
    if (r.height < 44 || r.width < 24) {
      small.push((el.tagName.toLowerCase()) + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : '') + ' ' + Math.round(r.width) + 'x' + Math.round(r.height))
    }
  }
  const scrollers = []
  for (const el of document.querySelectorAll('*')) {
    const s = getComputedStyle(el)
    if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 2) {
      scrollers.push((el.tagName.toLowerCase()) + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : ''))
    }
  }
  return {
    title: document.title,
    theme: doc.getAttribute('data-bs-theme') || doc.getAttribute('data-theme') || '(none)',
    docScrollWidth: doc.scrollWidth,
    innerWidth: innerWidth,
    horizontalOverflow: doc.scrollWidth > innerWidth + 1,
    verticalScrollers: scrollers.slice(0, 8),
    nestedScroll: scrollers.length > 1,
    smallTargets: small.slice(0, 12),
    smallTargetCount: small.length,
    bodyHeight: Math.round(document.body.getBoundingClientRect().height),
  }
})()`

async function shoot(sess, { url, viewport, scheme, theme, full }) {
  await sess.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor,
    mobile: viewport.mobile,
  })
  await sess.send('Emulation.setTouchEmulationEnabled', { enabled: !!viewport.touch })
  await sess.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: scheme }],
  })
  // The app resolves its theme from localStorage before paint; set it on every document
  // so the emulated media query is what actually decides when theme is `auto`.
  await sess.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('shipshape-theme', ${JSON.stringify(theme)}) } catch (e) {}`,
  })
  const nav = await sess.send('Page.navigate', { url })
  if (nav.errorText) return { error: nav.errorText }
  // No load event to await reliably across redirects; settle on a fixed budget, then
  // wait for fonts so text metrics are final.
  await sleep(1200)
  try {
    await sess.evaluate('document.fonts ? document.fonts.ready.then(() => true) : true')
  } catch {}
  await sleep(200)

  const probes = await sess.evaluate(PROBE_JS)
  const opts = { format: 'png' }
  if (full) {
    const m = await sess.send('Page.getLayoutMetrics')
    const cs = m.cssContentSize ?? m.contentSize
    opts.captureBeyondViewport = true
    opts.clip = {
      x: 0,
      y: 0,
      width: cs.width,
      height: Math.min(cs.height, 8000),
      scale: 1,
    }
  }
  const shot = await sess.send('Page.captureScreenshot', opts)
  return { probes, png: shot.data ? Buffer.from(shot.data, 'base64') : null }
}

function slug(route) {
  const s = route.replace(/^\//, '').replace(/[^\w.-]+/g, '_')
  return s === '' ? 'root' : s
}

function contactSheet({ label, base, rows, compare }) {
  const cell = (r) => {
    const flags = []
    if (r.probes?.horizontalOverflow) flags.push('<b class="bad">horizontal overflow</b>')
    if (r.probes?.nestedScroll) flags.push(`<b class="warn">${r.probes.verticalScrollers.length} scroll regions</b>`)
    if (r.probes?.smallTargetCount) flags.push(`<b class="warn">${r.probes.smallTargetCount} small targets</b>`)
    if (r.error) flags.push(`<b class="bad">${r.error}</b>`)
    const img = (l, f) => `<figure><figcaption>${l}</figcaption><img loading="lazy" src="${f}"></figure>`
    return `<div class="cell">
      <h3>${r.route} <span>${r.vp} · ${r.scheme}</span></h3>
      <div class="pair">${compare && r.beforeFile ? img('before', r.beforeFile) : ''}${img(compare ? 'after' : '', r.file)}</div>
      <p class="flags">${flags.join(' · ') || '<span class="ok">clean</span>'}</p>
    </div>`
  }
  return `<!doctype html><meta charset="utf-8"><title>shots · ${label}</title>
<style>
  :root { color-scheme: light dark; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; }
  body { margin: 0; padding: 1.5rem; background: Canvas; color: CanvasText; }
  h1 { font-size: 1.1rem; margin: 0 0 .25rem; }
  .meta { opacity: .7; margin: 0 0 1.5rem; }
  .grid { display: grid; gap: 1.5rem; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); }
  .cell { border: 1px solid color-mix(in oklab, CanvasText 15%, transparent); border-radius: 8px; padding: .75rem; }
  .cell h3 { font-size: .9rem; margin: 0 0 .5rem; font-family: ui-monospace, monospace; }
  .cell h3 span { opacity: .6; font-weight: 400; }
  .pair { display: flex; gap: .5rem; align-items: flex-start; }
  figure { margin: 0; flex: 1; min-width: 0; }
  figcaption { font-size: .75rem; opacity: .6; }
  img { width: 100%; height: auto; border: 1px solid color-mix(in oklab, CanvasText 12%, transparent); border-radius: 4px; background: #fff; }
  .flags { margin: .5rem 0 0; font-size: .8rem; }
  .bad { color: #c0392b; } .warn { color: #b7791f; } .ok { opacity: .5; }
</style>
<h1>shipshape · ${label}</h1>
<p class="meta">${base} · ${new Date().toISOString()}${compare ? ` · compared against <code>${compare}</code>` : ''}</p>
<div class="grid">${rows.map(cell).join('\n')}</div>`
}

const args = parseArgs(process.argv)
const outDir = args.outDir ?? join(ROOT, '.shots', args.label)
mkdirSync(outDir, { recursive: true })

const version = await fetch(`${args.cdp}/json/version`)
  .then((r) => r.json())
  .catch(() => {
    throw new Error(
      `no CDP endpoint at ${args.cdp} — start one:\n` +
        '  docker run -d --rm --name ss-chrome --network host --shm-size=1g \\\n' +
        '    gcr.io/zenika-hub/alpine-chrome:124 --no-sandbox --disable-gpu \\\n' +
        '    --disable-dev-shm-usage --remote-debugging-port=9222 --hide-scrollbars about:blank',
    )
  })
console.log(`${version.Browser} at ${args.cdp} → ${args.base}`)

const browser = await Session.open(version.webSocketDebuggerUrl)
const rows = []

for (const route of args.routes) {
  for (const vpName of args.vp) {
    for (const scheme of args.scheme) {
      const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
      const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
      // A flat session multiplexes over the browser socket; simplest is a dedicated
      // socket per target, which the /json/list entry gives us.
      const list = await (await fetch(`${args.cdp}/json/list`)).json()
      const target = list.find((t) => t.id === targetId)
      const sess = await Session.open(target.webSocketDebuggerUrl)
      await sess.send('Page.enable')
      await sess.send('Runtime.enable')

      const file = `${slug(route)}__${vpName}__${scheme}.png`
      let result
      try {
        result = await shoot(sess, {
          url: args.base + route,
          viewport: VIEWPORTS[vpName],
          scheme,
          theme: args.theme,
          full: args.full,
        })
        if (result.png) writeFileSync(join(outDir, file), result.png)
        if (args.probe) result.custom = await sess.evaluate(args.probe)
      } catch (err) {
        result = { error: err.message }
      }
      sess.close()
      await browser.send('Target.closeTarget', { targetId }).catch(() => {})
      void sessionId

      const beforeFile =
        args.compare && existsSync(join(ROOT, '.shots', args.compare, file))
          ? `../${args.compare}/${file}`
          : null
      rows.push({ route, vp: vpName, scheme, file, beforeFile, ...result, png: undefined })
      const p = result.probes
      const flags = p
        ? [
            p.horizontalOverflow ? 'OVERFLOW' : '',
            p.nestedScroll ? `${p.verticalScrollers.length} scrollers` : '',
            p.smallTargetCount ? `${p.smallTargetCount} small` : '',
          ]
            .filter(Boolean)
            .join(' ')
        : result.error ?? ''
      console.log(`  ${file.padEnd(44)} ${flags}`)
    }
  }
}

browser.close()
writeFileSync(join(outDir, 'probes.json'), JSON.stringify(rows, null, 2))
writeFileSync(
  join(outDir, 'index.html'),
  contactSheet({ label: args.label, base: args.base, rows, compare: args.compare }),
)
console.log(`\n${rows.length} shots → ${outDir}\n  open ${join(outDir, 'index.html')}`)
