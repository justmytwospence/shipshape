import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseChangelogLabel } from '../src/resolver/labels.ts'
import { isPrivateAddress, refusedHost } from '../src/upstream/hosts.ts'
import { htmlToText } from '../src/notes/html.ts'
import { sectionize } from '../src/notes/sectionize.ts'

/**
 * `shipshape.changelog` is typed into a browser and fetched from inside the lab, so what it
 * may name is decided before anything is fetched.
 */

test('a notes link is an https page on a public host, or a path in the repository', () => {
  assert.deepEqual(parseChangelogLabel('https://www.plex.tv/media-server-downloads/'), {
    ok: true,
    kind: 'url',
    url: 'https://www.plex.tv/media-server-downloads/',
  })
  assert.deepEqual(parseChangelogLabel(' CHANGELOG.md '), { ok: true, kind: 'path', path: 'CHANGELOG.md' })
  assert.deepEqual(parseChangelogLabel('./docs/changelog/'), { ok: true, kind: 'path', path: 'docs/changelog' })
})

test('a link that could reach inside the lab, or out of the repository, is refused with the reason', () => {
  const cases: [string, RegExp][] = [
    ['http://example.com/notes', /only https/],
    ['https://user:pw@example.com/notes', /credentials/],
    ['https://10.0.0.1/notes', /private/],
    ['https://127.0.0.1/notes', /private/],
    ['https://[::1]/notes', /private/],
    ['https://169.254.169.254/latest/meta-data', /private/],
    ['https://nas/notes', /not a public host/],
    ['https://grafana.lan/notes', /local network/],
    ['https://printer.local/', /local network/],
    ['https://example.com:8443/notes', /standard https port/],
    ['https://example.com/${VERSION}', /interpolate/],
    ['/etc/passwd', /path inside the repository/],
    ['../secrets.md', /path inside the repository/],
    ['docs/../../x', /path inside the repository/],
    ['CHANGE LOG.md', /whitespace/],
    ['', /empty/],
  ]
  for (const [value, reason] of cases) {
    const p = parseChangelogLabel(value)
    assert.equal(p.ok, false, value)
    assert.match(p.ok ? '' : p.reason, reason, value)
  }
})

test('private ranges are recognised in both address families, and public ones are not', () => {
  for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:7f00:1']) {
    assert.equal(isPrivateAddress(ip), true, ip)
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(ip), false, ip)
  }
  assert.equal(refusedHost('releases.example.com'), null)
})

test('a web page becomes text whose headings still cut by version', () => {
  const html = `<html><head><style>h2 { color: red }</style><script>alert(1)</script></head><body>
    <nav><a href="/">Home</a></nav>
    <h1>Release notes</h1>
    <h2>Version 1.43.5 &mdash; <em>September</em></h2>
    <ul><li>Fixed playback &amp; transcoding</li><li>Faster scans</li></ul>
    <h2>Version 1.43.4</h2>
    <p>Older&nbsp;changes</p>
  </body></html>`
  const text = htmlToText(html)
  assert.doesNotMatch(text, /alert|color: red|Home/)
  assert.match(text, /## Version 1\.43\.5 — September\n\n- Fixed playback & transcoding\n- Faster scans/)
  assert.deepEqual(sectionize(text).map((s) => s.key?.core.join('.')), ['1.43.5', '1.43.4'])
})
