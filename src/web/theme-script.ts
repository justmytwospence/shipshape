import { createHash } from 'node:crypto'

/**
 * Resolve the theme before the first paint. Deliberately inline and not deferred: any
 * later and the page renders light, then repaints dark, which is worse than either.
 *
 * It is the one inline script on any page, so the content security policy allows it by
 * its hash (THEME_SCRIPT_HASH) rather than allowing inline scripts at all.
 */
export const THEME_SCRIPT = `(function(){
  try {
    var s = localStorage.getItem('shipshape-theme') || 'auto';
    var d = document.documentElement;
    if (s === 'auto') d.removeAttribute('data-theme');
    else d.setAttribute('data-theme', s === 'dark' ? 'bridge-dark' : 'bridge');
  } catch (e) {}
})()`

export const THEME_SCRIPT_HASH = `sha256-${createHash('sha256').update(THEME_SCRIPT).digest('base64')}`
