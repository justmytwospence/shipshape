import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validatePolicyText } from '../src/config.ts'
import { retiredKeys } from '../src/policy-schema.ts'
import { applyPolicyEdits, planPolicy, planServiceLabels, type LabelEdit } from '../src/v1/convert.ts'

/**
 * The v1 converter's plans, as pure functions: what each old label and key becomes. The
 * mapping is frozen here on purpose -- it must outlive the code that once read v1.
 */

const plan = (labels: Record<string, string>) => planServiceLabels('s/docker-compose.yaml', 'app', labels)
const sets = (edits: LabelEdit[]) => edits.filter((e) => e.value !== null).map((e) => `${e.key}=${e.value}`)
const removes = (edits: LabelEdit[]) => edits.filter((e) => e.value === null).map((e) => e.key)

test('planServiceLabels maps every v1 policy value', () => {
  const cases: Record<string, string> = {
    auto: 'normal',
    manual: 'ask',
    gated: 'ask',
    model: 'ask',
    attended: 'lifeline',
    'on-request': 'frozen',
    skip: 'skip',
    automatic: 'ask',
    ' Auto ': 'normal',
  }
  for (const [v1, cls] of Object.entries(cases)) {
    const edits = plan({ 'shipshape.policy': v1 })
    assert.deepEqual(sets(edits), [`shipshape.class=${cls}`], v1)
    assert.deepEqual(removes(edits), ['shipshape.policy'], v1)
  }
})

test('a class already set keeps its value; the v1 labels go', () => {
  const edits = plan({ 'shipshape.class': 'stateful', 'shipshape.policy': 'auto', 'shipshape.pr': 'on-request' })
  assert.deepEqual(sets(edits), [])
  assert.deepEqual(removes(edits), ['shipshape.policy', 'shipshape.pr'])
})

test('policy: skip wins over a class, as it did', () => {
  const edits = plan({ 'shipshape.class': 'normal', 'shipshape.policy': 'skip' })
  assert.deepEqual(sets(edits), ['shipshape.class=skip'])
  assert.equal(edits[0]!.was, 'shipshape.class: normal')
  assert.deepEqual(removes(edits), ['shipshape.policy'])
})

test('shipshape.pr on-request freezes only when nothing else says otherwise', () => {
  assert.deepEqual(sets(plan({ 'shipshape.pr': 'on-request' })), ['shipshape.class=frozen'])
  assert.deepEqual(sets(plan({ 'shipshape.pr': 'on-request', 'shipshape.policy': 'auto' })), ['shipshape.class=normal'])
  assert.deepEqual(sets(plan({ 'shipshape.pr': 'always' })), [])
  assert.deepEqual(removes(plan({ 'shipshape.pr': 'always' })), ['shipshape.pr'])
})

test('shipshape.claude becomes shipshape.review unless review is already set', () => {
  const edits = plan({ 'shipshape.claude': 'required' })
  assert.deepEqual(sets(edits), ['shipshape.review=required'])
  assert.deepEqual(removes(edits), ['shipshape.claude'])
  const both = plan({ 'shipshape.claude': 'required', 'shipshape.review': 'off' })
  assert.deepEqual(sets(both), [])
  assert.deepEqual(removes(both), ['shipshape.claude'])
  assert.equal(both[0]!.was, 'shipshape.claude: required')
})

test('the class is set before the review, and removals come last', () => {
  const edits = plan({ 'shipshape.claude': 'required', 'shipshape.pr': 'x', 'shipshape.policy': 'auto' })
  assert.deepEqual(edits.map((e) => e.key), ['shipshape.class', 'shipshape.review', 'shipshape.policy', 'shipshape.pr', 'shipshape.claude'])
})

const edit = (raw: string, notifyUrlSet = false) =>
  Object.fromEntries(planPolicy(raw, { notifyUrlSet }).filter((e) => e.value !== null).map((e) => [e.path, e.value]))

test('planPolicy folds claude into review, merge into ship, and derives paused', () => {
  const out = edit('claude:\n  model: claude-x\n  monthly_budget_usd: 40\nmerge:\n  auto: true\n  cooldown_days: 3\ndeploy:\n  mode: auto\n')
  assert.equal(out['review.model'], '"claude-x"')
  assert.equal(out['review.monthly_budget_usd'], '40')
  assert.equal(out['ship.cooldown_days'], '3')
  assert.equal(out['paused'], 'false')
  assert.equal(edit('merge:\n  auto: true\n')['paused'], 'true')
  assert.equal(edit('deploy:\n  mode: auto\n')['paused'], 'true')
  assert.equal(edit('paused: false\nmerge:\n  auto: false\n')['paused'], undefined, 'a written paused wins')
  assert.equal(edit('claude:\n  mode: off\n  model: claude-x\n')['review.model'], '"off"')
  assert.equal(edit('claude:\n  model: claude-x\nreview:\n  model: other\n')['review.model'], undefined)
  assert.equal(edit('deploy:\n  health_window_s: 600\n')['deploy.verify_window_s'], '600')
  assert.equal(edit('propose:\n  mode: manual\n')['propose.mode'], 'off')
})

test('notify sinks are written only for a file that relied on the old default', () => {
  assert.equal(edit('paused: true\n')['notify.sinks'], undefined)
  assert.equal(edit('notify:\n  incidents: off\n')['notify.sinks'], '[]')
  assert.equal(edit('notify:\n  email: alerts\n')['notify.sinks'], '[{ type: email }]')
  assert.equal(edit('paused: true\n', true)['notify.sinks'], '[{ type: webhook }]')
  assert.equal(edit('notify:\n  incidents: all\n  email: all\n')['notify.sinks'], '[{ type: webhook }, { type: email }]')
  assert.equal(edit('notify:\n  incidents: off\n  sinks: []\n')['notify.sinks'], undefined, 'sinks already written')
})

const V1 = `# shipshape policy, by hand
# second header line

claude:
  # the reader
  model: claude-x
  mode: advisory

merge:
  auto: true
  max_per_run: 2

prs:
  max_open: 5

deploy:
  mode: auto
  soak_s: 900 # fifteen minutes

exclude_stacks: [media] # never these
`

test('applyPolicyEdits leaves a file with no retired keys that validates, comments kept', () => {
  const r = applyPolicyEdits(V1, planPolicy(V1, { notifyUrlSet: false }))
  assert.ok(r.ok, r.ok ? '' : r.reason)
  assert.deepEqual(retiredKeys(r.text), [])
  assert.equal(validatePolicyText(r.text).ok, true)
  assert.ok(r.text.startsWith('# shipshape policy, by hand\n# second header line\n'))
  assert.ok(r.text.includes('  soak_s: 900 # fifteen minutes\n'))
  assert.ok(r.text.includes('exclude_stacks: [media] # never these\n'))
  assert.ok(!r.text.includes('# the reader'))
  assert.match(r.text, /^paused: false$/m)
  assert.match(r.text, /^ {2}model: "claude-x"$/m)
  assert.match(r.text, /^ {2}max_per_run: 2$/m)
})

test('a v2 file has nothing to convert', () => {
  const v2 = 'paused: false\nreview:\n  model: claude-x\nship:\n  cooldown_days: 7\nnotify:\n  sinks: [{ type: webhook }]\n'
  assert.deepEqual(planPolicy(v2, { notifyUrlSet: true }), [])
  assert.deepEqual(plan({ 'shipshape.class': 'ask', 'shipshape.review': 'required', 'shipshape.watch': 'true' }), [])
})
