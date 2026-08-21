import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupUpdates, branchFor, taggedBranchFor, sanitise, type GroupMember } from '../src/groups.ts'

let nextId = 1
function m(stack: string, service: string, to: string, over: Partial<GroupMember> = {}): GroupMember {
  return {
    id: nextId++,
    stack,
    service,
    image: `img/${service}`,
    from_tag: 'old',
    to_tag: to,
    magnitude: 'major',
    tier: 'manual',
    ...over,
  }
}

const src = (map: Record<string, string>) => (stack: string, service: string) =>
  map[`${stack}/${service}`] ?? null
const lbl = (map: Record<string, string>) => (stack: string, service: string) =>
  map[`${stack}/${service}`] ?? null

test('services sharing an upstream repo and a target version travel together', () => {
  // Immich does not support running the server and machine-learning containers at
  // different versions, so merging one without the other breaks the stack.
  const rows = [
    m('immich', 'immich-server', 'v3.1.0'),
    m('immich', 'immich-machine-learning', 'v3.1.0'),
  ]
  const groups = groupUpdates(
    rows,
    src({
      'immich/immich-server': 'immich-app/immich',
      'immich/immich-machine-learning': 'immich-app/immich',
    }),
    lbl({}),
  )
  assert.equal(groups.length, 1)
  assert.equal(groups[0]!.members.length, 2)
  assert.equal(groups[0]!.key, 'immich--group-immich--v3.1.0')
  // The key keeps the target tag so drifted members cannot be bundled; the branch drops
  // it so the next target can be retargeted onto the same pull request.
  assert.equal(groups[0]!.branchKey, 'immich--group-immich')
  assert.equal(branchFor(groups[0]!), 'shipshape/immich--group-immich')
})

test('two containers off one image group without any resolution', () => {
  // n8n and n8n-import are literally the same image; the repository path alone is
  // enough identity.
  const groups = groupUpdates(
    [m('n8n', 'n8n', '2.34.0'), m('n8n', 'n8n-import', '2.34.0')],
    src({ 'n8n/n8n': 'n8nio/n8n', 'n8n/n8n-import': 'n8nio/n8n' }),
    lbl({}),
  )
  assert.equal(groups.length, 1)
  assert.equal(groups[0]!.members.length, 2)
})

test('an explicit label groups services the heuristic cannot see', () => {
  // homelable's frontend and backend are separate images that release in lockstep.
  const groups = groupUpdates(
    [m('homelable', 'homelable', '3.1.2'), m('homelable', 'backend', '3.1.2')],
    src({ 'homelable/homelable': 'a/frontend', 'homelable/backend': 'a/backend' }),
    lbl({ 'homelable/homelable': 'homelable', 'homelable/backend': 'homelable' }),
  )
  assert.equal(groups.length, 1)
  assert.equal(groups[0]!.members.length, 2)
  assert.equal(groups[0]!.key, 'homelable--group-homelable--3.1.2')
})

test('members drifting to different versions are never bundled', () => {
  // Bumping two services to mismatched versions in one commit would be worse than the
  // skew grouping exists to prevent.
  const groups = groupUpdates(
    [m('immich', 'immich-server', 'v3.1.0'), m('immich', 'immich-machine-learning', 'v3.0.2')],
    src({
      'immich/immich-server': 'immich-app/immich',
      'immich/immich-machine-learning': 'immich-app/immich',
    }),
    lbl({}),
  )
  assert.equal(groups.length, 2)
  assert.ok(groups.every((g) => g.key === null))
})

test('the same upstream in different stacks stays separate', () => {
  // Three postgres sidecars share an image but belong to unrelated stacks; each deploys
  // on its own.
  const groups = groupUpdates(
    [m('huginn', 'huginn-db', '18.4'), m('miniflux', 'miniflux-db', '18.4')],
    src({ 'huginn/huginn-db': 'postgres/postgres', 'miniflux/miniflux-db': 'postgres/postgres' }),
    lbl({}),
  )
  assert.equal(groups.length, 2)
})

test('a lone service is a singleton, not a one-member group', () => {
  const groups = groupUpdates([m('miniflux', 'miniflux', '2.3.3')], src({}), lbl({}))
  assert.equal(groups.length, 1)
  assert.equal(groups[0]!.key, null)
  assert.equal(groups[0]!.branchKey, null)
  assert.equal(branchFor(groups[0]!), 'shipshape/miniflux--miniflux')
})

test('the branch name says nothing about the target, so it can be reused', () => {
  // Two consecutive targets for one service want the same branch. That is the point:
  // the pull request open on it is retargeted rather than closed and replaced.
  const first = groupUpdates([m('miniflux', 'miniflux', '2.3.3')], src({}), lbl({}))
  const second = groupUpdates([m('miniflux', 'miniflux', '2.3.4')], src({}), lbl({}))
  assert.equal(branchFor(first[0]!), branchFor(second[0]!))
  // The tag-suffixed form is what the two coexisting cases fall back to, and it is the
  // scheme every pull request open before retargeting is still sitting on.
  assert.equal(taggedBranchFor(first[0]!), 'shipshape/miniflux--miniflux--2.3.3')
  assert.equal(taggedBranchFor(second[0]!), 'shipshape/miniflux--miniflux--2.3.4')
})

test('branch names stay readable and legal', () => {
  // A full sha256 in a branch name is unusable; digests collapse to 12 hex.
  assert.equal(
    sanitise('9@sha256:546304417feac0874c3dd576e0952c6bb8f06bb4093ea0c9ca303c73cf458f63'),
    '9@546304417fea',
  )
  assert.equal(sanitise('ghcr.io/immich-app/immich-server'), 'ghcr.io-immich-app-immich-server')
  assert.equal(sanitise('v1.2.3'), 'v1.2.3')
  // No leading/trailing/doubled separators to trip git's ref rules.
  assert.equal(sanitise('--weird//name--'), 'weird-name')

  const g = groupUpdates(
    [
      m('immich', 'immich-redis', '9@sha256:546304417feac0874c3dd576e0952c6bb8f06bb4093ea0c9ca303c73cf458f63'),
    ],
    src({}),
    lbl({}),
  )
  assert.equal(branchFor(g[0]!), 'shipshape/immich--immich-redis')
  // A digest target still has to survive the fallback form.
  assert.match(taggedBranchFor(g[0]!), /^shipshape\/immich--immich-redis--9@[0-9a-f]{12}$/)
})

test('grouping is deterministic so reruns produce the same branches', () => {
  const rows = [
    m('immich', 'immich-machine-learning', 'v3.1.0'),
    m('miniflux', 'miniflux', '2.3.3'),
    m('immich', 'immich-server', 'v3.1.0'),
  ]
  const lookups = [
    src({
      'immich/immich-server': 'immich-app/immich',
      'immich/immich-machine-learning': 'immich-app/immich',
    }),
    lbl({}),
  ] as const
  const a = groupUpdates(rows, ...lookups).map(branchFor)
  const b = groupUpdates([...rows].reverse(), ...lookups).map(branchFor)
  assert.deepEqual(a, b)
})
