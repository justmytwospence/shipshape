import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  tierFor,
  foldGroupTier,
  foldGroupMagnitude,
  canAutoMerge,
  shouldOpenPr,
  type EffectiveTier,
} from '../src/policy.ts'
import type { Magnitude } from '../src/versions/patterns.ts'

const DEFAULTS = {
  patch: 'auto',
  minor: 'auto',
  major: 'manual',
  digest: 'manual',
} as const

const t = (
  magnitude: Magnitude,
  policyLabel: string | null = null,
  prLabel: string | null = null,
): EffectiveTier => tierFor({ magnitude, policyLabel, prLabel, defaults: { ...DEFAULTS } })

test('tierFor: label precedence, first match wins', () => {
  // skip beats everything
  assert.equal(t('patch', 'skip', 'on-request'), 'skip')
  // on-request beats the remaining labels -- this is what makes datastores dashboard-only
  assert.equal(t('patch', 'manual', 'on-request'), 'held')
  assert.equal(t('major', 'manual', 'on-request'), 'held')
  assert.equal(t('patch', 'manual'), 'manual')
})

test('tierFor: on-request is reachable from either label', () => {
  // The original spelling lives on shipshape.pr; the ladder now also accepts it on
  // shipshape.policy, so one label can express every rung.
  assert.equal(t('patch', null, 'on-request'), 'held')
  assert.equal(t('patch', 'on-request', null), 'held')
})

test('tierFor: "gated" is an accepted spelling of manual, never its own rung', () => {
  // It behaved identically to manual in every decision; keeping both was a coin flip
  // the operator had to remember the result of. Old labels keep working.
  assert.equal(t('patch', 'gated'), 'manual')
  assert.equal(t('minor', 'gated'), 'manual')
  assert.equal(t('patch', 'gated', 'on-request'), 'held')
  assert.equal(
    tierFor({
      magnitude: 'minor',
      policyLabel: null,
      prLabel: null,
      defaults: { ...DEFAULTS, minor: 'gated' as never },
    }),
    'manual',
  )
})

test('tierFor: an unrecognised label narrows to manual rather than widening', () => {
  assert.equal(t('patch', 'atuo'), 'manual')
  assert.equal(t('patch', 'yes-please'), 'manual')
})

test('tierFor: an explicit auto label cannot talk a major past the line', () => {
  // `auto` means "no exception here, follow the defaults" -- it is not an override, so
  // it falls through to the rule that majors always need a human.
  assert.equal(t('major', 'auto'), 'manual')
  assert.equal(t('patch', 'auto'), 'auto')
})

test('tierFor: majors are always manual regardless of defaults', () => {
  assert.equal(t('major'), 'manual')
  // even if someone writes major: auto in policy.yaml
  assert.equal(
    tierFor({
      magnitude: 'major',
      policyLabel: null,
      prLabel: null,
      defaults: { ...DEFAULTS, major: 'auto' },
    }),
    'manual',
  )
})

test('tierFor: patch and minor follow the defaults; digest has its own default', () => {
  assert.equal(t('patch'), 'auto')
  assert.equal(t('minor'), 'auto')
  assert.equal(t('digest'), 'manual')
  assert.equal(
    tierFor({
      magnitude: 'minor',
      policyLabel: null,
      prLabel: null,
      defaults: { ...DEFAULTS, minor: 'on-request' },
    }),
    'held',
  )
})

test('foldGroupTier: the most conservative member wins', () => {
  assert.equal(foldGroupTier(['auto', 'auto']), 'auto')
  // rows written before the collapse still say 'gated'; they normalise on the way in
  assert.equal(foldGroupTier(['auto', 'gated']), 'manual')
  assert.equal(foldGroupTier(['auto', 'manual']), 'manual')
  // one held member holds the whole group
  assert.equal(foldGroupTier(['auto', 'held']), 'held')
  assert.equal(foldGroupTier(['manual', 'held', 'auto']), 'held')
  // skip members never drag a group down -- they produce no update row at all
  assert.equal(foldGroupTier(['skip', 'auto']), 'auto')
  assert.equal(foldGroupTier(['skip']), 'skip')
})

test('foldGroupMagnitude: a group is labelled with its largest jump', () => {
  assert.equal(foldGroupMagnitude(['patch', 'major']), 'major')
  assert.equal(foldGroupMagnitude(['patch', 'minor']), 'minor')
  assert.equal(foldGroupMagnitude(['digest', 'patch']), 'patch')
})

const merge = (over: Partial<Parameters<typeof canAutoMerge>[0]> = {}) =>
  canAutoMerge({
    tier: 'auto',
    magnitude: 'patch',
    verdict: 'approve',
    confidence: 'high',
    claudeRequired: false,
    claudeMode: 'advisory',
    minConfidence: 'medium',
    ...over,
  })

test('canAutoMerge: only the auto tier, only patch/minor', () => {
  assert.equal(merge().merge, true)
  assert.equal(merge({ magnitude: 'minor' }).merge, true)
  for (const tier of ['manual', 'held', 'skip'] as const) {
    assert.equal(merge({ tier }).merge, false, tier)
  }
  assert.equal(merge({ magnitude: 'major' }).merge, false)
  assert.equal(merge({ magnitude: 'digest' }).merge, false)
})

test('canAutoMerge: Claude can demote but never promote', () => {
  // demote
  assert.equal(merge({ verdict: 'block' }).merge, false)
  assert.equal(merge({ verdict: 'caution' }).merge, false)
  assert.equal(merge({ verdict: 'approve', confidence: 'low' }).merge, false)
  // and cannot promote: a confident approval does NOT rescue a major or a review-only service
  assert.equal(merge({ magnitude: 'major', verdict: 'approve', confidence: 'high' }).merge, false)
  assert.equal(merge({ tier: 'manual', verdict: 'approve', confidence: 'high' }).merge, false)
})

test('canAutoMerge: labels identify why a merge was withheld', () => {
  assert.equal(merge({ verdict: 'block' }).merge === false && merge({ verdict: 'block' }).label, 'review-block')
  const caution = merge({ verdict: 'caution' })
  assert.equal(caution.merge === false && caution.label, 'review-hold')
})

test('canAutoMerge: absent analysis fails OPEN by default, CLOSED when required', () => {
  // The static policy is what runs today under WUD; an API outage must not freeze the
  // whole homelab.
  assert.equal(merge({ verdict: 'unavailable' }).merge, true)
  // ...unless the service opted into fail-closed.
  const required = merge({ verdict: 'unavailable', claudeRequired: true })
  assert.equal(required.merge, false)
  assert.equal(required.merge === false && required.label, 'needs-review')
})

test('canAutoMerge: claude off skips the damper entirely', () => {
  assert.equal(merge({ claudeMode: 'off', verdict: 'unavailable' }).merge, true)
  // but the hard rules still bind
  assert.equal(merge({ claudeMode: 'off', magnitude: 'major' }).merge, false)
})

test('canAutoMerge: confidence threshold is inclusive', () => {
  assert.equal(merge({ confidence: 'medium', minConfidence: 'medium' }).merge, true)
  assert.equal(merge({ confidence: 'low', minConfidence: 'medium' }).merge, false)
  assert.equal(merge({ confidence: 'medium', minConfidence: 'high' }).merge, false)
})

test('shouldOpenPr: every rung but held and skip opens one, and rolling never does', () => {
  // There was a `coexist` scope for running beside WUD. WUD is retired; shipshape owns
  // every update, so the only refusals left are the rungs that say "not without me".
  const s = (over: Partial<Parameters<typeof shouldOpenPr>[0]>) =>
    shouldOpenPr({ tier: 'auto', magnitude: 'patch', rolling: false, ...over })
  assert.equal(s({}), true)
  assert.equal(s({ magnitude: 'major', tier: 'manual' }), true)
  assert.equal(s({ tier: 'attended' }), true)
  assert.equal(s({ tier: 'held', magnitude: 'major' }), false)
  assert.equal(s({ tier: 'skip' }), false)
  assert.equal(s({ rolling: true, magnitude: 'major' }), false)
})

test('canAutoMerge refuses any pull request carrying unverified changes', () => {
  // The whole point of a drafted or hand-edited PR is that something in it has not been
  // checked by policy or by a changelog verdict. Neither may ever merge unattended.
  assert.equal(merge({ prScope: 'tag-only' }).merge, true)

  const proposed = merge({ prScope: 'proposed' })
  assert.equal(proposed.merge, false)
  assert.match(proposed.merge === false ? proposed.reason : '', /drafted config changes/)

  const edited = merge({ prScope: 'modified' })
  assert.equal(edited.merge, false)
  assert.match(edited.merge === false ? edited.reason : '', /has been edited/)

  // A confident approval does not rescue either of them.
  assert.equal(merge({ prScope: 'proposed', verdict: 'approve', confidence: 'high' }).merge, false)
  // Absent scope information behaves as before, so existing callers are unaffected.
  assert.equal(merge({}).merge, true)
})
