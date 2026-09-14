import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assess, isUnder } from '../src/policy/model-tier.ts'

const clean = {
  resolutionTier: 'annotation' as const,
  sourceRepo: 'acme/widget',
  resolutionConfidence: 'high' as const,
  sources: ['https://github.com/acme/widget/releases/tag/v2.0.0'],
  recommendation: 'approve' as const,
  confidence: 'high' as const,
  breakingChanges: [] as string[],
  migrationSteps: [] as string[],
}

test('a clean, authoritatively-sourced approval promotes', () => {
  const a = assess(clean)
  assert.equal(a.promote, true)
  assert.ok(a.guards.every((g) => g.passed))
})

test('an image nobody can tie to a source is never promoted', () => {
  // There is nothing authoritative to read, so "the changelog looked fine" means
  // nothing.
  assert.equal(assess({ ...clean, resolutionTier: 'none', sourceRepo: null }).promote, false)
  assert.match(assess({ ...clean, resolutionTier: 'none', sourceRepo: null }).reason, /linked/)
})

test('a repository the resolver only thinks likely is not linked', () => {
  // Found by the image's name, or linked from its description: good enough to read notes
  // from, not to extend trust to.
  const a = assess({ ...clean, resolutionTier: 'lookup', resolutionConfidence: 'medium' })
  assert.equal(a.promote, false)
  assert.match(a.reason, /linked/)
  assert.match(a.guards[0]!.detail ?? '', /only a likely match/)
  assert.equal(assess({ ...clean, resolutionTier: 'description', resolutionConfidence: 'high' }).promote, true)
})

test('evidence from outside the upstream repository blocks promotion', () => {
  // This is the injection guard. web_fetch has no domain allowlist, and GitHub hosts
  // content anyone can create, so appearing in a search result proves nothing.
  const a = assess({
    ...clean,
    sources: [
      'https://github.com/acme/widget/releases/tag/v2.0.0',
      'https://widget-fanpage.example.com/why-v2-is-safe',
    ],
  })
  assert.equal(a.promote, false)
  assert.match(a.reason, /outside acme\/widget/)
})

test('a verdict citing nothing does not count as clean', () => {
  const a = assess({ ...clean, sources: [] })
  assert.equal(a.promote, false)
  assert.match(a.reason, /cited nothing/)
})

test('the model must be both approving and confident', () => {
  for (const rec of ['caution', 'block', 'unavailable'] as const) {
    assert.equal(assess({ ...clean, recommendation: rec }).promote, false, rec)
  }
  for (const conf of ['medium', 'low'] as const) {
    assert.equal(assess({ ...clean, confidence: conf }).promote, false, conf)
  }
})

test('anything the model found to tell you about sends it to a human', () => {
  assert.equal(assess({ ...clean, breakingChanges: ['renamed FOO'] }).promote, false)
  assert.equal(assess({ ...clean, migrationSteps: ['back up first'] }).promote, false)
})

test('a lookalike repository is outside, not inside', () => {
  // github.com/acme/widget-evil must not read as inside acme/widget.
  assert.equal(isUnder('https://github.com/acme/widget-evil/releases', 'acme/widget'), false)
  assert.equal(isUnder('https://github.com/acme/widget/releases', 'acme/widget'), true)
  assert.equal(isUnder('https://github.com/acme/widget', 'acme/widget'), true)
})

test('only https github counts as inside', () => {
  assert.equal(isUnder('http://github.com/acme/widget/x', 'acme/widget'), false)
  assert.equal(isUnder('https://gitlab.com/acme/widget/x', 'acme/widget'), false)
  // A host that merely ends in github.com is a different host.
  assert.equal(isUnder('https://evil-github.com/acme/widget/x', 'acme/widget'), false)
  assert.equal(isUnder('not a url', 'acme/widget'), false)
})

test('case and trailing slashes do not change the answer', () => {
  assert.equal(isUnder('https://GitHub.com/Acme/Widget/releases/', 'acme/widget'), true)
})

test('the refusal names the guard that refused, not just that one did', () => {
  // The audit trail is the point: "it was blocked" is useless a month later.
  const a = assess({ ...clean, confidence: 'low' })
  assert.match(a.reason, /confident/)
  assert.equal(a.guards.filter((g) => !g.passed).length, 1)
})

test('every guard is evaluated, so shadow mode shows all of them', () => {
  const a = assess({ ...clean, resolutionTier: 'none', sourceRepo: null, confidence: 'low' })
  assert.equal(a.guards.length, 6)
  assert.ok(a.guards.filter((g) => !g.passed).length >= 2)
})

test('a refused update lands on a human, not on the magnitude default', () => {
  // `model` replaces whatever static label the service had, and shipshape cannot know
  // what that was. Deriving the fallback from magnitude would silently rewrite intent:
  // deluge-gluetun is pinned `manual` because it is a torrent stack's VPN container,
  // and a patch landing on `auto` the moment a guard refused is the exact inversion of
  // why it was pinned. This asserts the contract stays "routine if vouched for, a human
  // otherwise".
  const refused = assess({ ...clean, confidence: 'low' })
  assert.equal(refused.promote, false)
  // The tier that a refusal maps to is asserted in the merge path; here we pin the
  // property it depends on — a refusal is never silently a promotion.
  assert.ok(refused.guards.some((g) => !g.passed))
})
