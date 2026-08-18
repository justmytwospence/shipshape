/**
 * Everything the interface needs beyond htmx, which is not much.
 *
 * Four jobs: remember the theme, show what an action did, mark which row the pane is
 * showing, and let a keyboard work the queue. No framework, no build step -- this file
 * is served as written.
 */
;(function () {
  'use strict'

  // ------------------------------------------------------------------- theme
  //
  // `auto` removes the attribute entirely so daisyUI's own prefers-dark rule applies;
  // anything else pins it. The same resolution runs inline in <head> before first paint,
  // because doing it here would show a white flash first.
  var THEME_KEY = 'shipshape-theme'
  var COLORS = { light: '#fbfbfa', dark: '#16171a' }

  function resolved() {
    var stored = localStorage.getItem(THEME_KEY) || 'auto'
    if (stored !== 'auto') return stored
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }

  function applyTheme() {
    var root = document.documentElement
    // A `?theme=` preview is pinned by the server. Without this the stored preference
    // would immediately overwrite it, and the two candidate looks would render the same.
    if (root.hasAttribute('data-theme-pinned')) return
    var stored = localStorage.getItem(THEME_KEY) || 'auto'
    if (stored === 'auto') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', stored === 'dark' ? 'bridge-dark' : 'bridge')
    var meta = document.querySelector('meta[name=theme-color]:not([media])')
    if (meta) meta.setAttribute('content', COLORS[resolved()])
    document.querySelectorAll('[data-set-theme]').forEach(function (el) {
      el.setAttribute('aria-pressed', String(el.getAttribute('data-set-theme') === stored))
    })
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-set-theme]')
    if (!btn) return
    localStorage.setItem(THEME_KEY, btn.getAttribute('data-set-theme'))
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
    el.setAttribute('role', 'status')
    el.textContent = detail.text
    el.addEventListener('click', function () {
      el.remove()
    })
    host.appendChild(el)
    setTimeout(
      function () {
        el.remove()
      },
      detail.level === 'error' ? 9000 : 5000,
    )
  }

  document.body.addEventListener('toast', function (e) {
    toast(e.detail)
  })

  // A request that never arrived is the one failure htmx cannot express as content.
  function failed(e) {
    toast({
      level: 'error',
      text:
        e.detail && e.detail.xhr && e.detail.xhr.status
          ? 'The server answered ' + e.detail.xhr.status + '. Nothing was changed.'
          : 'Could not reach shipshape. Nothing was changed.',
    })
  }
  document.body.addEventListener('htmx:responseError', failed)
  document.body.addEventListener('htmx:sendError', failed)

  // ----------------------------------------------------------------- dialogs
  //
  // Native <dialog>: focus trap, Escape and backdrop dismissal come free, and on iOS it
  // behaves like a sheet rather than a div pretending to be one.
  document.addEventListener('click', function (e) {
    var opener = e.target.closest('[data-open]')
    if (!opener) return
    var dlg = document.querySelector(opener.getAttribute('data-open'))
    if (dlg && dlg.showModal) {
      e.preventDefault()
      dlg.showModal()
    }
  })

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
    function (e) {
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
    document.querySelectorAll('[data-row]').forEach(function (r) {
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

  // ---------------------------------------------------------------- keyboard
  //
  // A backlog of eight is a lot of pointing. j/k move a cursor through the rows and, on
  // a desktop, fill the pane with the row it lands on; Enter opens it; m does the thing
  // the pane's button says, s skips. Nothing here fires while typing.
  function rows() {
    return Array.prototype.slice.call(document.querySelectorAll('[data-row]'))
  }
  function cursor() {
    var el = document.activeElement
    if (el && el.hasAttribute && el.hasAttribute('data-row')) return el
    return document.querySelector('[data-row][aria-current="true"]')
  }
  var loadTimer = null
  function focus(el) {
    if (!el) return
    el.focus({ preventScroll: true })
    el.scrollIntoView({ block: 'nearest' })
    // Fill the pane once the cursor rests, not on every keypress through the list.
    if (wide.matches && window.htmx) {
      clearTimeout(loadTimer)
      loadTimer = setTimeout(function () {
        if (document.activeElement === el) el.click()
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
  document.addEventListener('keydown', function (e) {
    var t = e.target
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return
    if (document.querySelector('dialog[open]') && e.key !== 'Escape') return

    if (pending === 'g') {
      var go = { i: '/', u: '/updates', s: '/services', a: '/activity', ',': '/settings' }[e.key]
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
      case 'Enter':
        if (cursor()) {
          e.preventDefault()
          cursor().click()
        }
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
        setTimeout(function () {
          pending = ''
        }, 1200)
        break
    }
  })

  // A form with unsaved edits says so, rather than leaving you to remember.
  document.addEventListener('input', function (e) {
    var form = e.target.closest('form[data-dirty]')
    if (form) form.classList.add('is-dirty')
  })
  document.body.addEventListener('htmx:afterSwap', function () {
    document.querySelectorAll('form[data-dirty]').forEach(function (f) {
      f.classList.remove('is-dirty')
    })
  })
})()
