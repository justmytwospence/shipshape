/**
 * Everything the interface needs beyond htmx, which is not much.
 *
 * Four jobs: remember the theme, show what an action did, mark which row the pane is
 * showing, and let a keyboard work the queue. No framework, no build step -- this file
 * is served as written.
 */
;(() => {
  'use strict'

  // Storage can throw (Safari private mode, storage disabled, a full quota); a theme
  // preference is never worth an exception that stops the rest of this file.
  function load(k) { try { return localStorage.getItem(k) } catch (e) { return null } }
  function save(k, v) { try { localStorage.setItem(k, v) } catch (e) {} }

  if ('serviceWorker' in navigator) {
    addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    })
  }

  // ------------------------------------------------------------------- theme
  //
  // `auto` removes the attribute entirely so daisyUI's own prefers-dark rule applies;
  // anything else pins it. The same resolution runs inline in <head> before first paint,
  // because doing it here would show a white flash first.
  var THEME_KEY = 'shipshape-theme'
  // --color-base-100 of bridge and bridge-dark.
  var COLORS = { light: '#fbfcfd', dark: '#13161c' }

  function applyTheme() {
    var root = document.documentElement
    var stored = load(THEME_KEY) || 'auto'
    if (stored === 'auto') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', stored === 'dark' ? 'bridge-dark' : 'bridge')
    // Both metas carry a media query; a pinned theme sets both to its own colour, so the
    // address bar follows the theme rather than the OS.
    document.querySelectorAll('meta[name=theme-color]').forEach((m) => {
      var scheme = (m.getAttribute('media') || '').indexOf('dark') !== -1 ? 'dark' : 'light'
      m.setAttribute('content', stored === 'auto' ? COLORS[scheme] : COLORS[stored])
    })
    document.querySelectorAll('[data-set-theme]').forEach((el) => {
      el.setAttribute('aria-pressed', String(el.getAttribute('data-set-theme') === stored))
    })
  }

  document.addEventListener('click', (e) => {
    var btn = e.target.closest('[data-set-theme]')
    if (!btn) return
    save(THEME_KEY, btn.getAttribute('data-set-theme'))
    applyTheme()
  })
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme)
  addEventListener('DOMContentLoaded', applyTheme)

  // ------------------------------------------------------------------ toasts
  //
  // Every action answers with a sentence. They used to land as small grey text in place
  // of the button, which is unreadable on a phone and gone on the next swap.
  var LEVEL = { info: 'alert-info', warn: 'alert-warning', error: 'alert-error' }

  function toast(detail) {
    var host = document.getElementById('toasts')
    if (!host || !detail || !detail.text) return
    var el = document.createElement('div')
    el.className = 'alert alert-soft ' + (LEVEL[detail.level] || LEVEL.info) + ' text-sm shadow'
    el.setAttribute('role', detail.level === 'error' ? 'alert' : 'status')
    var text = document.createElement('span')
    text.textContent = detail.text
    var close = document.createElement('button')
    close.type = 'button'
    close.className = 'btn btn-ghost btn-xs btn-square tap'
    close.setAttribute('aria-label', 'Dismiss')
    close.textContent = '\u00d7'
    close.addEventListener('click', () => {
      el.remove()
    })
    el.appendChild(text)
    el.appendChild(close)
    host.appendChild(el)
    // Long enough to read; paused while a pointer or focus is on it, so a sentence being
    // read is never taken away mid-way.
    var left = detail.level === 'info' || !detail.level ? 5000 : 9000
    var started = 0
    var timer = null
    function run() {
      started = Date.now()
      timer = setTimeout(() => {
        el.remove()
      }, left)
    }
    function hold() {
      if (timer === null) return
      clearTimeout(timer)
      timer = null
      left = Math.max(1000, left - (Date.now() - started))
    }
    el.addEventListener('mouseenter', hold)
    el.addEventListener('focusin', hold)
    el.addEventListener('mouseleave', () => {
      if (timer === null) run()
    })
    el.addEventListener('focusout', () => {
      if (timer === null) run()
    })
    run()
  }

  document.body.addEventListener('toast', (e) => {
    toast(e.detail)
  })

  // ------------------------------------------------------------- connection
  //
  // A poll that fails says so once, in a banner that clears itself on the next request
  // that succeeds; only a request a person made raises a toast.
  function isPoll(e) {
    var elt = e.detail && e.detail.elt
    var t = elt && elt.getAttribute && elt.getAttribute('hx-trigger')
    return !!t && /\bevery\b/.test(t)
  }
  function showConn(text) {
    var el = document.getElementById('conn')
    if (!el) return
    document.getElementById('conn-text').textContent = text
    el.classList.remove('hidden')
  }
  function hideConn() {
    var el = document.getElementById('conn')
    if (el) el.classList.add('hidden')
  }
  document.body.addEventListener('htmx:afterRequest', (e) => {
    if (e.detail && e.detail.successful) hideConn()
  })
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-reload]')) location.reload()
  })

  function failed(e) {
    // The server already said what happened in its own toast; a second one would repeat it.
    if (e.detail && e.detail.xhr && e.detail.xhr.getResponseHeader && e.detail.xhr.getResponseHeader('HX-Trigger')) return
    var status = e.detail && e.detail.xhr ? e.detail.xhr.status : 0
    if (!status) {
      showConn('Lost contact with shipshape. Retrying… If this does not clear, your sign-in may have expired: reload the page.')
      if (!isPoll(e)) {
        toast({ level: 'error', text: 'Could not reach shipshape. If you pressed a button, check Activity before pressing it again.' })
      }
      return
    }
    if (status === 401 || status === 403) {
      showConn('shipshape refused a request (' + status + '). Your sign-in may have expired: reload the page.')
      if (!isPoll(e)) {
        toast({
          level: 'error',
          text:
            status === 401
              ? 'Your session has expired. Reload the page to sign in again.'
              : 'Refused (403). Reload the page; if it keeps happening, SHIPSHAPE_ALLOWED_ORIGIN may not match this address.',
        })
      }
      return
    }
    if (isPoll(e)) return
    toast({
      level: 'error',
      text:
        status === 503
          ? 'shipshape is not set up to accept this yet (503). Nothing was changed; Status says what is missing.'
          : status >= 500
            ? 'The server failed (' + status + '). It may have done part of the work: check Activity before trying again.'
            : 'The server answered ' + status + '. Nothing was changed.',
    })
  }
  document.body.addEventListener('htmx:responseError', failed)
  document.body.addEventListener('htmx:sendError', failed)

  // ------------------------------------------------------------------- times
  //
  // Every <time> is re-rendered here, in the server's zone (<html data-tz>), so a page
  // left open keeps saying "5m ago" truthfully and Activity's clocks match its day headers.
  var TZ = document.documentElement.getAttribute('data-tz') || undefined
  function fmt(opts) {
    try {
      return new Intl.DateTimeFormat(undefined, Object.assign({ timeZone: TZ }, opts))
    } catch (e) {
      return new Intl.DateTimeFormat(undefined, opts)
    }
  }
  var CLOCK = fmt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  // The same words as relative() in src/web/views/ui/parts.tsx.
  function rel(ms) {
    var abs = Math.abs(ms)
    var mins = Math.round(abs / 60000)
    if (mins < 1) return 'just now'
    var span = mins < 60 ? mins + 'm' : abs < 86400000 ? Math.round(mins / 60) + 'h' : Math.round(mins / 1440) + 'd'
    return ms >= 0 ? span + ' ago' : 'in ' + span
  }
  function formatTimes() {
    document.querySelectorAll('time[data-format]').forEach((t) => {
      var at = Date.parse(t.getAttribute('datetime'))
      if (isNaN(at)) return
      t.textContent = t.getAttribute('data-format') === 'clock' ? CLOCK.format(at) : rel(Date.now() - at)
    })
  }
  addEventListener('DOMContentLoaded', formatTimes)
  document.body.addEventListener('htmx:afterSettle', formatTimes)
  setInterval(formatTimes, 60000)

  // ----------------------------------------------------------------- dialogs
  //
  // Native <dialog>: focus trap, Escape and backdrop dismissal come free, and on iOS it
  // behaves like a sheet rather than a div pretending to be one.
  document.addEventListener('click', (e) => {
    var opener = e.target.closest('[data-open]')
    if (!opener) return
    var dlg = document.querySelector(opener.getAttribute('data-open'))
    if (dlg && dlg.showModal) {
      e.preventDefault()
      dlg.showModal()
    }
  })

  // A Cancel button, or a form that submits, closes the dialog it sits in. Delegated here
  // because the content security policy allows no inline handlers.
  document.addEventListener('click', (e) => {
    var b = e.target.closest('button[data-close-dialog]')
    if (!b) return
    var d = b.closest('dialog')
    if (d) d.close()
  })
  document.addEventListener(
    'submit',
    (e) => {
      var f = e.target.closest('form[data-close-dialog]')
      if (!f) return
      var d = f.closest('dialog')
      if (d) d.close()
    },
    true,
  )

  // While a scan runs, the Inbox refreshes every 10 seconds rather than every 60: its
  // trigger listens for this event, which replaces a trigger filter htmx would have to eval.
  setInterval(() => {
    if (document.getElementById('scan-running')) document.body.dispatchEvent(new Event('scan-progress'))
  }, 10000)

  // ------------------------------------------------------------------- rows
  //
  // A row is a link that htmx upgrades to fill the pane. On a phone there is no pane, so
  // the link has to be left alone to navigate -- and that cannot be a `click[...]`
  // filter on the trigger, because htmx cancels an anchor's default action before it
  // evaluates the filter. This runs in the capture phase, ahead of htmx's own listener
  // on the element, and stops the event reaching it; the browser then follows the href.
  var wide = matchMedia('(min-width:1024px)')
  document.addEventListener(
    'click',
    (e) => {
      if (wide.matches) return
      var row = e.target.closest('[data-row]')
      if (row) e.stopPropagation()
    },
    true,
  )

  // --------------------------------------------------------------- selection
  //
  // The pane shows one row's detail; that row is `aria-current`. The server marks it on
  // a direct load, and after a row fills the pane the URL says which one it is, so the
  // mark follows the URL: on load, after every swap, and after every push. A list that
  // polls itself keeps the mark the same way, since a redrawn row starts unmarked.
  function markSelected() {
    var path = location.pathname
    document.querySelectorAll('[data-row]').forEach((r) => {
      var href = r.getAttribute('href') || ''
      var at = href.indexOf('?')
      if (at !== -1) href = href.slice(0, at)
      if (href === path) r.setAttribute('aria-current', 'true')
      else r.removeAttribute('aria-current')
    })
  }
  addEventListener('DOMContentLoaded', markSelected)
  document.body.addEventListener('htmx:afterSettle', markSelected)
  document.body.addEventListener('htmx:pushedIntoHistory', markSelected)

  // ------------------------------------------------------------------- focus
  //
  // A swap that replaced the element holding focus would drop it on <body>, and a screen
  // reader would start again from the top. A row clicked or tapped moves focus to the
  // pane's heading; a row reached with j/k keeps it, so the keys keep working.
  var keyNav = false
  var swapFocus = null
  document.body.addEventListener('htmx:beforeSwap', (e) => {
    var t = e.detail.target
    swapFocus = t && t.id && t.contains(document.activeElement) ? t.id : null
  })
  document.body.addEventListener('htmx:afterSettle', (e) => {
    var t = e.detail.target
    if (t && t.id === 'pane') {
      if (!keyNav) {
        var h = t.querySelector('[data-pane-heading]')
        if (h) h.focus({ preventScroll: true })
      }
      keyNav = false
      return
    }
    if (swapFocus) {
      var el = document.getElementById(swapFocus)
      swapFocus = null
      if (el && !el.contains(document.activeElement)) {
        var to = el.querySelector('[data-pane-heading]') || el.querySelector('button, a[href]')
        if (to) to.focus({ preventScroll: true })
      }
    }
    var bad = document.querySelector('#settings-form [aria-invalid="true"]')
    if (bad && t && t.id === 'settings-form') bad.focus()
  })

  // ---------------------------------------------------------------- sections
  //
  // A nav of anchors beside a long form (Settings) marks the section you are reading as
  // the pane scrolls, so the nav is a map and not just a list of links. The section at
  // the top edge wins; at the very end the last one does, since the last sections can
  // never reach the top. Recomputed from the DOM each time, because the form is swapped
  // whole after a save. The nav is only shown at lg, where the pane is the scroller.
  function spy() {
    var nav = document.querySelector('[data-spy]')
    if (!nav || nav.offsetParent === null) return
    var links = Array.prototype.slice.call(nav.querySelectorAll('a[href^="#"]'))
    if (!links.length) return
    var pane = document.querySelector('[data-panel]')
    var edge = (pane ? pane.getBoundingClientRect().top : 0) + 24
    var current = null
    links.forEach((a) => {
      var t = document.getElementById(a.getAttribute('href').slice(1))
      if (t && t.getBoundingClientRect().top <= edge) current = a
    })
    if (pane && pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2) {
      current = links[links.length - 1]
    }
    if (!current) current = links[0]
    links.forEach((a) => {
      if (a === current) a.setAttribute('aria-current', 'true')
      else a.removeAttribute('aria-current')
    })
  }
  var spyQueued = false
  function queueSpy() {
    if (spyQueued) return
    spyQueued = true
    requestAnimationFrame(() => {
      spyQueued = false
      spy()
    })
  }
  addEventListener('DOMContentLoaded', () => {
    var pane = document.querySelector('[data-panel]')
    if (pane) pane.addEventListener('scroll', queueSpy, { passive: true })
    addEventListener('resize', queueSpy)
    spy()
  })
  document.body.addEventListener('htmx:afterSettle', queueSpy)

  // ---------------------------------------------------------------- keyboard
  //
  // A backlog of eight is a lot of pointing. j/k move a cursor through the rows and, on
  // a desktop, fill the pane with the row it lands on; Enter opens it (the browser does
  // that for a focused link); m does the thing the pane's button says, s asks to skip.
  // Nothing here fires while typing. Only the list's rows: the pane has rows of its own
  // (a service's history), and the cursor must not wander into them.
  function rows() {
    return Array.prototype.slice.call(document.querySelectorAll('#list [data-row]')).filter((r) => r.offsetParent !== null)
  }
  function cursor() {
    var el = document.activeElement
    if (el && el.hasAttribute && el.hasAttribute('data-row') && el.closest('#list')) return el
    return document.querySelector('#list [data-row][aria-current="true"]')
  }
  var loadTimer = null
  function focus(el) {
    if (!el) return
    el.focus({ preventScroll: true })
    el.scrollIntoView({ block: 'nearest' })
    // Fill the pane once the cursor rests, not on every keypress through the list.
    if (wide.matches && window.htmx) {
      clearTimeout(loadTimer)
      loadTimer = setTimeout(() => {
        if (document.activeElement === el) {
          keyNav = true
          el.click()
        }
      }, 200)
    }
  }
  function move(delta) {
    var all = rows()
    if (!all.length) return
    var at = all.indexOf(cursor())
    focus(all[Math.max(0, Math.min(all.length - 1, at === -1 ? 0 : at + delta))])
  }
  // The pane's buttons first -- it shows the row you are looking at -- then the cursor
  // row's inline button.
  function click(selector) {
    var pane = document.querySelector('[data-panel]')
    var el = (pane && pane.querySelector(selector)) || null
    if (!el) {
      var row = cursor()
      var wrap = row && row.parentElement
      el = wrap ? wrap.querySelector(selector) : null
    }
    if (el) el.click()
  }

  var pending = ''
  document.addEventListener('keydown', (e) => {
    var t = e.target
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return
    if (document.querySelector('dialog[open]') && e.key !== 'Escape') return

    if (pending === 'g') {
      var go = { i: '/', u: '/updates', s: '/services', a: '/activity', ',': '/settings', t: '/status' }[e.key]
      pending = ''
      if (go) {
        e.preventDefault()
        location.href = go
      }
      return
    }

    switch (e.key) {
      case 'j':
        e.preventDefault()
        move(1)
        break
      case 'k':
        e.preventDefault()
        move(-1)
        break
      case 'm':
        e.preventDefault()
        click('[data-primary]')
        break
      case 's':
        e.preventDefault()
        click('[data-verb=skip]')
        break
      case '/':
        var search = document.querySelector('[data-search]')
        if (search) {
          e.preventDefault()
          search.focus()
        }
        break
      case '?':
        var help = document.getElementById('shortcuts')
        if (help && help.showModal) {
          e.preventDefault()
          help.showModal()
        }
        break
      case 'g':
        pending = 'g'
        setTimeout(() => {
          pending = ''
        }, 1200)
        break
    }
  })

  // Leaving with unsaved edits asks first.
  addEventListener('beforeunload', (e) => {
    if (document.querySelector('form.is-dirty')) {
      e.preventDefault()
      e.returnValue = ''
    }
  })

  // A form with unsaved edits says so, rather than leaving you to remember.
  document.addEventListener('input', (e) => {
    var form = e.target.closest('form[data-dirty]')
    if (form) form.classList.add('is-dirty')
  })
  document.body.addEventListener('htmx:afterSwap', () => {
    document.querySelectorAll('form[data-dirty]').forEach((f) => {
      f.classList.remove('is-dirty')
    })
  })
})()
