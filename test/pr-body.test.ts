import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prBody } from '../src/gitops/body.ts'
import type { UpdateGroup } from '../src/groups.ts'
import type { Policy } from '../src/config.ts'

/**
 * What a reviewer actually sees.
 *
 * prBody takes its resolved upstreams as an argument rather than reaching for the
 * database, which is what makes this testable at all -- and is also why the resolution
 * happens in openPr, where it can be awaited, instead of being read out of a cache that
 * is usually still empty when the pull request opens.
 */

const POLICY = { claude: { mode: 'advisory' } } as Policy

function group(members: Partial<UpdateGroup['members'][number]>[]): UpdateGroup {
  return {
    key: members.length > 1 ? 'grp--1.1.0' : null,
    branchKey: members.length > 1 ? 'grp' : null,
    members: members.map((m, i) => ({
      id: i + 1,
      stack: 'demo',
      service: 'svc',
      image: 'nginx:1.0.0',
      from_tag: '1.0.0',
      to_tag: '1.1.0',
      magnitude: 'minor',
      tier: 'manual',
      ...m,
    })),
  }
}

const bodyOf = (g: UpdateGroup, sources: Record<number, string | null> = {}) =>
  prBody(g, POLICY, new Map(g.members.map((m) => [m.id, sources[m.id] ?? null])))

/** Every `[text](url)` in the body. */
function links(md: string): { text: string; url: string }[] {
  return [...md.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g)].map((m) => ({
    text: m[1]!,
    url: m[2]!,
  }))
}

test('the image and the target tag are links, the old tag is not', () => {
  const md = bodyOf(
    group([{ service: 'miniflux', image: 'miniflux/miniflux:2.3.3', from_tag: '2.3.3', to_tag: '2.3.4' }]),
    { 1: 'miniflux/v2' },
  )
  const row = md.split('\n').find((l) => l.startsWith('| `miniflux`'))!
  assert.match(row, /\[`miniflux\/miniflux`\]\(https:\/\/hub\.docker\.com\/r\/miniflux\/miniflux\)/)
  assert.match(row, /\[`2\.3\.4`\]\(https:\/\/hub\.docker\.com\/r\/miniflux\/miniflux\/tags\?name=2\.3\.4\)/)
  // The version being left behind has nothing worth reading about it.
  assert.match(row, /\| `2\.3\.3` \|/)
})

test('the reference section points at the release notes for the target version', () => {
  const md = bodyOf(
    group([{ service: 'miniflux', image: 'miniflux/miniflux:2.3.3', from_tag: '2.3.3', to_tag: '2.3.4' }]),
    { 1: 'miniflux/v2' },
  )
  assert.match(md, /### Reference/)
  const notes = links(md).find((l) => l.text.includes('release notes'))
  assert.equal(notes?.url, 'https://github.com/miniflux/v2/releases?q=2.3.4')
  assert.ok(links(md).some((l) => l.text === 'project' && l.url === 'https://github.com/miniflux/v2'))
})

test('the reference section does not restate what the table already links', () => {
  // The Image and To cells are the registry and per-tag links. Repeating them under a
  // heading called Reference is decoration, not reference.
  const md = bodyOf(
    group([{ service: 'miniflux', image: 'miniflux/miniflux:2.3.3', to_tag: '2.3.4' }]),
    { 1: 'miniflux/v2' },
  )
  const line = md.split('\n').find((l) => l.startsWith('- '))!
  assert.ok(!line.includes('hub.docker.com'), line)
})

test('a Docker Official Image offers its Hub page as documentation', () => {
  // For `library/*` that page is maintained prose about configuring the image, not a
  // generated tag list -- the one registry page worth calling docs.
  const md = bodyOf(group([{ service: 'db', image: 'postgres:18.1', to_tag: '18.2' }]), {
    1: 'postgres/postgres',
  })
  assert.ok(
    links(md).some((l) => l.text === 'image docs' && l.url === 'https://hub.docker.com/_/postgres'),
  )
})

test('LinuxServer images get their container documentation, which the source repo lacks', () => {
  // The upstream project documents the application; the env vars and volumes you
  // actually configure are only on the lsio page.
  const md = bodyOf(
    group([
      {
        service: 'radarr',
        image: 'lscr.io/linuxserver/radarr:5.28.0-ls298',
        from_tag: '5.28.0-ls298',
        to_tag: '5.29.0-ls301',
      },
    ]),
    { 1: 'Radarr/Radarr' },
  )
  assert.ok(
    links(md).some(
      (l) =>
        l.text === 'image docs' &&
        l.url === 'https://docs.linuxserver.io/images/docker-radarr/',
    ),
  )
  // ...and the table still points at the registry, which is where the tags are.
  assert.ok(links(md).some((l) => l.url.includes('fleet.linuxserver.io')))
})

test('an unresolved upstream is stated, not silently omitted', () => {
  // It means the changelog verdict had nothing authoritative to read, which changes how
  // much weight the verdict deserves -- so the reviewer needs to know.
  const md = bodyOf(group([{ service: 'odd', image: 'example.internal/team/app:1.0.0' }]))
  assert.match(md, /No upstream repository resolved/)
  assert.match(md, /shipshape\.source/)
  // ...and nothing was invented to fill the gap.
  assert.equal(links(md).filter((l) => l.url.includes('example.internal')).length, 0)
})

test('a link is never emitted for a page the registry does not serve', () => {
  // Codeberg has no addressable per-tag page and gitlab has no stable one; refLinks
  // returns null rather than guessing, and the body must respect that.
  for (const image of ['codeberg.org/readeck/readeck:0.21.1', 'registry.gitlab.com/a/b/c:v1.2.3']) {
    const md = bodyOf(group([{ image, from_tag: '0.21.0', to_tag: '0.21.1' }]))
    assert.ok(!md.includes('](null)'), image)
    assert.ok(!/\]\(\)/.test(md), image)
  }
})

test('ghcr does not print the same releases link twice', () => {
  // refLinks points ghcr's `tag` at filtered releases, because ghcr has no per-tag page,
  // so the To cell and the release-notes link are the same URL. Once in the line is enough.
  const md = bodyOf(
    group([{ service: 'immich', image: 'ghcr.io/immich-app/immich-server:v3.1.0', to_tag: 'v3.2.0' }]),
    { 1: 'immich-app/immich' },
  )
  const line = md.split('\n').find((l) => l.startsWith('- ') && l.includes('release notes'))!
  assert.equal(links(line).filter((l) => l.url.includes('/releases?q=')).length, 1)
})

test('a grouped pull request names each service in its own reference line', () => {
  const md = bodyOf(
    group([
      { id: 1, service: 'immich-server', image: 'ghcr.io/immich-app/immich-server:v3.1.0', to_tag: 'v3.2.0' },
      {
        id: 2,
        service: 'immich-machine-learning',
        image: 'ghcr.io/immich-app/immich-machine-learning:v3.1.0',
        to_tag: 'v3.2.0',
      },
    ]),
    { 1: 'immich-app/immich', 2: 'immich-app/immich' },
  )
  assert.match(md, /- \*\*immich-server\*\* — /)
  assert.match(md, /- \*\*immich-machine-learning\*\* — /)
  assert.match(md, /bumped together/)
})

test('a singleton does not repeat its own name in the reference line', () => {
  const md = bodyOf(group([{ service: 'miniflux', image: 'miniflux/miniflux:2.3.3' }]), {
    1: 'miniflux/v2',
  })
  assert.ok(!/- \*\*miniflux\*\* — /.test(md))
})

test('a digest ref never leaks a sha into a link, and the table stays readable', () => {
  const long = 'sha256:546304417feac0874c3dd576e0952c6bb8f06bb4093ea0c9ca303c73cf458f63'
  const md = bodyOf(
    group([
      {
        service: 'valkey',
        image: `valkey/valkey:9@${long}`,
        from_tag: `9@${long}`,
        to_tag: `9@${long.replace('546304', '111111')}`,
        magnitude: 'digest',
      },
    ]),
  )
  for (const l of links(md)) assert.ok(!l.url.includes('sha256'), l.url)
  // Shortened to 12 hex in the visible cells rather than 64. The trailing metadata
  // comment deliberately keeps the full ref -- it is an identifier, and a truncated
  // identifier is not one -- so the check is against what a reader actually sees.
  const visible = md.replace(/<!--[\s\S]*?-->/g, '')
  assert.ok(!visible.includes(long))
  assert.match(visible, /`9@546304417fea`/)
  assert.match(md, /<!-- shipshape: .*to=9@sha256:111111417fea/)
})

test('the verdict markers and the metadata comment survive the new section', () => {
  // Analysis rewrites the body between these markers; poll.ts and the dashboard read the
  // trailing comment. Both must still be there, and in that order.
  const md = bodyOf(group([{ service: 'miniflux', image: 'miniflux/miniflux:2.3.3' }]), {
    1: 'miniflux/v2',
  })
  assert.ok(md.indexOf('### Reference') < md.indexOf('<!-- shipshape:verdict:start -->'))
  assert.ok(md.includes('<!-- shipshape:verdict:end -->'))
  assert.match(md, /<!-- shipshape: stack=demo services=miniflux from=/)
})

test('the analysis placeholder says which of the two reasons it is empty', () => {
  const on = bodyOf(group([{}]))
  assert.match(on, /Changelog analysis has not run yet/)
  const off = prBody(group([{}]), { claude: { mode: 'off' } } as Policy, new Map())
  assert.match(off, /Changelog analysis is disabled/)
})
