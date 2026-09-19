import { test } from 'node:test'
import assert from 'node:assert/strict'
import { annotate, containsText, line, render, renderHtml, workOf } from '../src/notify/digest.ts'
import type { Contains } from '../src/notify/digest.ts'

/**
 * What a pull request carries, said on the line that mentions it.
 *
 * The digest used to describe every update the same way -- `#128 paperless: 3.1.3 -> 3.2.0`
 * -- whether that pull request was an image line and nothing else or carried configuration
 * changes on a second commit. #32 is the case that proves the cost: an Arcane v2 image
 * rename was drafted, committed and merged, and every message shipshape sent about it
 * called it a plain version bump.
 *
 * Everything here is pure. `workOf`, `containsText`, `line` and `annotate` take their
 * facts as arguments, so none of this needs a database.
 */

let seq = 0
type Row = Parameters<typeof render>[0][number]
const row = (over: Partial<Row> = {}): Row => ({
  id: ++seq,
  at: '2026-09-19T03:14:00.000Z',
  category: 'opened',
  stack: null,
  service: null,
  summary: 'something happened',
  detail: null,
  url: null,
  ...over,
})

const carries = (work: Contains['work'], features = false): Contains => ({ work, features })
const at = (n: number) => `https://github.com/o/r/pull/${n}`

/** A proposals row as `outcomesFor` reads one back. */
const prop = (over: Partial<Parameters<typeof workOf>[1] & object> = {}) => ({
  n_ops: 0,
  n_notes: 0,
  instruction_id: null,
  ...over,
})

// ------------------------------------------------------------------ which one it is

test('a person pushing to the branch outranks anything shipshape wrote there', () => {
  // Both the later fact and the one no other signal accounts for. A branch that was
  // drafted onto and then edited by hand is an edited branch.
  assert.equal(workOf('modified', prop({ n_ops: 2 }), { required: 1 }), 'edited')
  assert.equal(workOf('modified', undefined, undefined), 'edited')
})

test('a change the operator asked for is not reported back as shipshape drafting it', () => {
  // The revise path writes a proposals row too and reaches `scope = 'proposed'` exactly as
  // drafting does; `instruction_id` is the only thing that separates them. Without this the
  // digest tells the operator their own instruction was shipshape's idea.
  assert.equal(workOf('proposed', prop({ n_ops: 1, instruction_id: 7 }), undefined), 'asked')
})

test('a proposal that wrote no operation is noted, never drafted', () => {
  // propose ran, found the compose file needed no change, and left the work to a person.
  // No commit is pushed, so "drafted" would point the reader at a diff that does not exist.
  assert.equal(workOf('tag-only', prop({ n_notes: 13 }), undefined), 'noted')
  assert.equal(workOf('tag-only', prop({ n_ops: 1, n_notes: 13 }), undefined), 'drafted')
})

test('a drafted image rename is caught even though its scope reads tag-only', () => {
  // #32, exactly. A proposal whose only operation is `set_image` produces a patch
  // containing nothing but an image line, which `classifyPatch` correctly calls tag-only.
  // Reading `prs.scope` alone would go on missing the updates this exists to catch.
  assert.equal(workOf('tag-only', prop({ n_ops: 1 }), undefined), 'drafted')
})

test('work the review named counts even when nothing was written to the branch', () => {
  // The weakest of the five and still worth saying: most updates that need something never
  // get a proposal drafted at all.
  assert.equal(workOf('tag-only', undefined, { required: 1 }), 'required')
  assert.equal(workOf('tag-only', undefined, { required: 0 }), null)
  assert.equal(workOf('tag-only', undefined, undefined), null)
})

// ------------------------------------------------------------------------ the wording

test('a plain version bump says nothing at all', () => {
  // The absence is the class. 119 of the 120 pull requests this repository has opened were
  // an image line and nothing else; a badge on every one is how a reader stops seeing them.
  assert.equal(containsText(undefined), null)
  assert.equal(containsText(carries(null)), null)
})

test('each thing a pull request can carry has one wording', () => {
  assert.equal(containsText(carries('edited')), 'carries edits')
  assert.equal(containsText(carries('asked')), 'changes you asked for')
  assert.equal(containsText(carries('drafted')), 'config changes drafted')
  assert.equal(containsText(carries('noted')), 'manual steps noted')
  assert.equal(containsText(carries('required')), 'required steps in the review')
})

test('what the release offers is joined to what the pull request carries, never ranked', () => {
  // Different questions: one is a fact about a diff that exists, the other an assertion
  // read off upstream prose. Either may appear alone.
  assert.equal(containsText(carries(null, true)), 'new features')
  assert.equal(containsText(carries('drafted', true)), 'config changes drafted; new features')
  assert.equal(containsText(carries('required', true)), 'required steps in the review; new features')
})

test('a mark the heading has already said is not said again', () => {
  // "1 carried drafted config changes" above "#120 n8n/n8n — config changes drafted" says
  // it twice. Same idea as the SAID map, and scoped per category for the same reason.
  assert.equal(containsText(carries('drafted'), 'drafted'), null)
  assert.equal(containsText(carries('asked'), 'revised'), null)
  // ...but what the release offers is not what that heading said, so it survives.
  assert.equal(containsText(carries('drafted', true), 'drafted'), 'new features')
})

test('the same mark is kept under a heading that does not say it', () => {
  // Dropping it globally would lose the only place the fact appears. A drafted pull request
  // that went on to merge is listed under "merged", which says nothing about drafting.
  assert.equal(containsText(carries('drafted'), 'merged'), 'config changes drafted')
  assert.equal(containsText(carries('drafted'), 'deployed'), 'config changes drafted')
  assert.equal(containsText(carries('asked'), 'opened'), 'changes you asked for')
})

// --------------------------------------------------------------------------- the line

test('the mark goes at the end, after the versions', () => {
  const m = line(
    row({
      stack: 'grafana',
      service: 'grafana',
      summary: '12.4 -> 13.0 (#116)',
      url: at(116),
      contains: carries('required'),
    }),
  )
  assert.equal(m, '#116 grafana/grafana: 12.4 -> 13.0 — required steps in the review')
})

test('a version-only line is byte-for-byte what it always was', () => {
  const r = row({ stack: 'plex', service: 'plex', summary: '1.43.3 -> 1.43.4 (#95)', url: at(95) })
  assert.equal(line(r), '#95 plex/plex: 1.43.3 -> 1.43.4')
  assert.equal(line({ ...r, contains: carries(null) }), '#95 plex/plex: 1.43.3 -> 1.43.4')
})

test('a line reduced to just its name still carries the mark', () => {
  // reconcile writes "#66 deployed" when it never learned the versions, and `bare` drops a
  // payload that would only repeat the heading. The mark is the one thing left worth saying.
  const m = line(
    row({
      category: 'deployed',
      stack: 'paperless',
      service: 'litellm',
      summary: '#66 deployed',
      url: at(66),
      contains: carries('drafted'),
    }),
  )
  assert.equal(m, '#66 paperless/litellm — config changes drafted')
})

test('a quoted failure reason keeps its own em dash and still gets the mark', () => {
  const reason = '#93 merged, but did not deploy: litellm — litellm restarted 4 times in 90s'
  const m = line(
    row({
      category: 'went-wrong',
      stack: 'paperless',
      service: 'litellm',
      summary: reason,
      url: at(93),
      contains: carries('edited'),
    }),
  )
  assert.equal(
    m,
    '#93 paperless/litellm: merged, but did not deploy: litellm — litellm restarted 4 times in 90s — carries edits',
  )
})

test('a row with no service to name still carries the mark', () => {
  const m = line(
    row({
      category: 'superseded',
      summary: '#19 closed — superseded by v3.2.2',
      url: at(19),
      contains: carries(null, true),
    }),
  )
  assert.equal(m, '#19 closed: superseded by v3.2.2 — new features')
})

// ----------------------------------------------------------------------- the annotation

test('every row about a pull request is annotated, not just the one that wins', () => {
  // `collapse` has not run yet and which row survives depends on what else is in the batch.
  // Annotating a chosen one would make the mark appear or vanish according to how far the
  // update happened to get overnight.
  const rows = [
    row({ category: 'opened', summary: 'a (#10)', url: at(10) }),
    row({ category: 'merged', summary: '#10 merged', url: at(10) }),
  ]
  const out = annotate(rows, new Map([[10, { merged: true, deploy: null, contains: carries('drafted') }]]))
  assert.equal(out.length, 2)
  for (const r of out) assert.deepEqual(r.contains, carries('drafted'))
})

test('a row with no pull request, or an outcome that looked at nothing, is left alone', () => {
  assert.equal(annotate([row({ summary: 'no pull request here' })], new Map())[0]!.contains, undefined)
  const withPr = row({ summary: 'x (#11)', url: at(11) })
  assert.equal(annotate([withPr], new Map([[11, { merged: false, deploy: null }]]))[0]!.contains, undefined)
})

test('annotate does not mutate the rows it was given', () => {
  const r = row({ summary: 'x (#12)', url: at(12) })
  annotate([r], new Map([[12, { merged: false, deploy: null, contains: carries(null, true) }]]))
  assert.equal(r.contains, undefined)
})

// ------------------------------------------------------------------- both renderers

test('one morning, read the way the operator asked for it', () => {
  // The three classes in one batch, which is the whole ask: an update that is only a
  // version bump, one that also carries required work, and one that also offers something.
  const body = render([
    row({ stack: 'plex', service: 'plex', summary: '1.43.3 -> 1.43.4 (#117)', url: at(117) }),
    row({
      stack: 'grafana',
      service: 'grafana',
      summary: '12.4 -> 13.0 (#116)',
      url: at(116),
      contains: carries('required', true),
    }),
    row({
      stack: 'arcane',
      service: 'arcane',
      summary: 'v1.18.1 -> v2.7.0 (#118)',
      url: at(118),
      contains: carries('drafted'),
    }),
  ])!.body

  assert.match(body, /^ {2}#117 plex\/plex: 1\.43\.3 -> 1\.43\.4$/m)
  assert.match(
    body,
    /^ {2}#116 grafana\/grafana: 12\.4 -> 13\.0 — required steps in the review; new features$/m,
  )
  assert.match(body, /^ {2}#118 arcane\/arcane: v1\.18\.1 -> v2\.7\.0 — config changes drafted$/m)
})

test('a drafted pull request that merged still says it was drafted', () => {
  // The core fix. `collapse` discards the `drafted` row -- it ranks below `merged` -- so the
  // fact cannot travel on that row. It is read from the database when the digest is sent,
  // which is also what makes it survive being drafted on Tuesday and merged on Wednesday.
  const body = render(
    annotate(
      [
        row({ category: 'drafted', stack: 'arcane', service: 'arcane', summary: '#32 — 1 config change(s) drafted', url: at(32) }),
        row({ category: 'merged', stack: 'arcane', service: 'arcane', summary: '#32 merged', url: at(32) }),
      ],
      new Map([[32, { merged: true, deploy: null, contains: carries('drafted') }]]),
    ),
  )!.body
  assert.match(body, /^1 merged$/m)
  assert.match(body, /^ {2}#32 arcane\/arcane — config changes drafted$/m)
})

test('the mail says exactly what the plain text says', () => {
  // Both renderers go through `line`, which is what stops the push and the mail from
  // describing the same pull request two ways.
  const rows = [
    row({
      stack: 'arcane',
      service: 'arcane',
      summary: 'v1.18.1 -> v2.7.0 (#118)',
      url: at(118),
      contains: carries('drafted', true),
    }),
  ]
  assert.ok(render(rows)!.body.includes('config changes drafted; new features'))
  assert.ok(renderHtml(rows)!.includes('config changes drafted; new features'))
})
