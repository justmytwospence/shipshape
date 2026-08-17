import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'yaml'
import { setLabel } from '../src/compose/edit.ts'

/**
 * Byte-level label surgery on realistic compose text. The fixtures are full of comments
 * because the real files are: every assertion on exact output is really an assertion
 * that a comment three lines away did not move.
 */

const FIXTURE = `# media stack -- comments everywhere, all of which must survive every edit
services:
  jellyfin:
    image: jellyfin/jellyfin:10.9.11   # pinned; majors broke twice
    labels:
      traefik.enable: true
      # policy for this service:
      shipshape.watch: "true"
      shipshape.policy: manual   # hold majors
    ports:
      - 8096:8096

  db:
    image: postgres:16.4
    labels:
      shipshape.watch: "true"
      shipshape.pr: on-request

  plain:
    image: nginx:1.27.1
    restart: unless-stopped

  listy:
    image: redis:7.4.0
    labels:
      - "shipshape.watch=true"
`

function ok(r: ReturnType<typeof setLabel>): string {
  assert.equal(r.ok, true, `expected ok, got: ${(r as { reason?: string }).reason}`)
  return (r as { text: string }).text
}

test('replacing an existing value touches only the value; the line comment survives', () => {
  const text = ok(setLabel(FIXTURE, 'jellyfin', 'shipshape.policy', 'auto'))
  assert.equal(
    text,
    FIXTURE.replace(
      'shipshape.policy: manual   # hold majors',
      'shipshape.policy: auto   # hold majors',
    ),
  )
})

test('a missing key is inserted after the last label at the same indent', () => {
  const text = ok(setLabel(FIXTURE, 'db', 'shipshape.policy', 'on-request'))
  assert.equal(
    text,
    FIXTURE.replace(
      '      shipshape.pr: on-request\n',
      '      shipshape.pr: on-request\n      shipshape.policy: on-request\n',
    ),
  )
})

test('a service with no labels block gets one, as a sibling of image:', () => {
  const text = ok(setLabel(FIXTURE, 'plain', 'shipshape.policy', 'skip'))
  assert.equal(
    text,
    FIXTURE.replace(
      '    image: nginx:1.27.1\n',
      '    image: nginx:1.27.1\n    labels:\n      shipshape.policy: skip\n',
    ),
  )
})

test('null removes the whole line, comment included', () => {
  const text = ok(setLabel(FIXTURE, 'jellyfin', 'shipshape.policy', null))
  assert.equal(text, FIXTURE.replace('      shipshape.policy: manual   # hold majors\n', ''))
})

test('removing shipshape.pr removes exactly its line', () => {
  const text = ok(setLabel(FIXTURE, 'db', 'shipshape.pr', null))
  assert.equal(text, FIXTURE.replace('      shipshape.pr: on-request\n', ''))
})

test('removing a key that is not there is a no-op, not an error', () => {
  const text = ok(setLabel(FIXTURE, 'plain', 'shipshape.policy', null))
  assert.equal(text, FIXTURE)
})

test('removing the only label removes the labels: block with it', () => {
  const solo = `services:\n  app:\n    image: nginx:1.0\n    labels:\n      shipshape.pr: on-request\n    restart: unless-stopped\n`
  const text = ok(setLabel(solo, 'app', 'shipshape.pr', null))
  assert.equal(text, `services:\n  app:\n    image: nginx:1.0\n    restart: unless-stopped\n`)
})

test('list-form labels are refused, not rewritten', () => {
  const r = setLabel(FIXTURE, 'listy', 'shipshape.policy', 'manual')
  assert.equal(r.ok, false)
  assert.match((r as { reason: string }).reason, /list form/)
})

test('an unknown service is refused', () => {
  const r = setLabel(FIXTURE, 'ghost', 'shipshape.policy', 'manual')
  assert.equal(r.ok, false)
  assert.match((r as { reason: string }).reason, /no service "ghost"/)
})

test('shipshape.watch is written quoted; policy stays bare', () => {
  const text = ok(setLabel(FIXTURE, 'plain', 'shipshape.watch', 'true'))
  assert.ok(text.includes('      shipshape.watch: "true"\n'))
  // Quoted means it parses back as the string, not the boolean.
  const js = parse(text) as { services: Record<string, { labels?: Record<string, unknown> }> }
  assert.equal(js.services.plain!.labels!['shipshape.watch'], 'true')

  const bare = ok(setLabel(FIXTURE, 'plain', 'shipshape.policy', 'manual'))
  assert.ok(bare.includes('      shipshape.policy: manual\n'))
})

test('replacing a quoted watch value keeps the quoting and hits the right service', () => {
  // jellyfin carries a byte-identical watch line above db's; the document tree, not a
  // text search, is what keeps the edit on db.
  const text = ok(setLabel(FIXTURE, 'db', 'shipshape.watch', 'false'))
  assert.equal(
    text,
    FIXTURE.replace(
      'shipshape.watch: "true"\n      shipshape.pr',
      'shipshape.watch: "false"\n      shipshape.pr',
    ),
  )
})

test('a value smuggling a newline cannot become a second key', () => {
  const r = setLabel(FIXTURE, 'db', 'shipshape.policy', 'manual\nevil: injected')
  // Either refused outright or quoted into a harmless single-line string -- never a
  // new top-level key in the map.
  if (r.ok) {
    const js = parse(r.text) as { services: Record<string, { labels?: Record<string, unknown> }> }
    assert.equal(js.services.db!.labels!['evil'], undefined)
    assert.equal(js.services.db!.labels!['shipshape.policy'], 'manual\nevil: injected')
  }
})

test('every comment in the file survives an insert', () => {
  const text = ok(setLabel(FIXTURE, 'db', 'shipshape.policy', 'auto'))
  const comments = (s: string) => s.split('\n').filter((l) => l.includes('#'))
  assert.deepEqual(comments(text), comments(FIXTURE))
})

test('the round-trip check rejects nothing on a clean edit but the parse stays intact', () => {
  const text = ok(setLabel(FIXTURE, 'jellyfin', 'shipshape.policy', 'model'))
  const js = parse(text) as { services: Record<string, { labels?: Record<string, unknown> }> }
  assert.equal(js.services.jellyfin!.labels!['shipshape.policy'], 'model')
  // Neighbours untouched.
  assert.equal(js.services.jellyfin!.labels!['shipshape.watch'], 'true')
  assert.equal(js.services.db!.labels!['shipshape.pr'], 'on-request')
})
