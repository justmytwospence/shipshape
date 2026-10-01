import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NOTE_CAP,
  TOTAL_CAP,
  buildState,
  clean,
  contextHash,
  deploymentOf,
  extractLines,
  missingVersions,
  selectNotes,
  type ScreenNote,
} from '../src/analyze/screen/state.ts'
import { decideScreen, questionsFor, THRESHOLDS, type ScreenEvidence } from '../src/analyze/screen/decide.ts'
import type { Answer } from '../src/analyze/jev.ts'
import type { NotesBundle } from '../src/notes/assemble.ts'
import { versionKey } from '../src/versions/key.ts'

/**
 * What the screen is shown, and what its answers decide.
 *
 * Both halves are pure on purpose: the screen's whole value is that a cheap model can be
 * trusted with the easy cases, and that trust rests on rules that can be read and tested
 * without a model in reach.
 */

// ----------------------------------------------------------------------- state

test('the noise is removed before anything is sent', () => {
  const body = [
    '## Breaking',
    '- APP_DB_URL renamed to DATABASE_URL',
    '- Bump lodash from 4.17.20 to 4.17.21',
    '- build(deps): bump foo',
    '* @someone made their first contribution in #12',
    '<details><summary>Commits</summary>lots of commits</details>',
    '**Full Changelog**: https://github.com/o/r/compare/a...b',
    '<!-- release-please -->',
  ].join('\n')
  const out = clean(body)
  assert.match(out, /APP_DB_URL renamed/)
  for (const gone of ['lodash', 'build(deps)', 'first contribution', 'lots of commits', 'Full Changelog', 'release-please']) {
    assert.doesNotMatch(out, new RegExp(gone.replace(/[()]/g, '\\$&')), gone)
  }
})

const note = (heading: string, text: string): ScreenNote => ({ version: heading, source: 'release', heading, text, url: null })

test('the notes that look like they matter go first, and the caps hold', () => {
  const big = 'x'.repeat(NOTE_CAP + 500)
  const { notes, omitted } = selectNotes([
    note('v1.2.0', '- small fix'),
    note('v1.1.0', `## Upgrade notes\n- run the migration\n${big}`),
  ])
  assert.equal(notes[0]!.heading, 'v1.1.0', 'the upgrade note leads')
  assert.ok(notes[0]!.text.length <= NOTE_CAP + 30, 'one note is capped')
  assert.ok(omitted.some((o) => o.includes('(cut)')), 'and the cut is named')

  const many = Array.from({ length: 20 }, (_, i) => note(`v1.${i}.0`, '- y'.repeat(1000)))
  const sel = selectNotes(many)
  assert.ok(sel.notes.reduce((n, x) => n + x.text.length, 0) <= TOTAL_CAP)
  assert.ok(sel.omitted.length > 0, 'what did not fit is named')
})

test('the lines asked about are the notes\' own bullets, deduplicated, important ones first', () => {
  const lines = extractLines([
    note('v2', '- Faster thumbnails\n- Removed support for PostgreSQL 13\n- faster thumbnails\nnot a bullet'),
  ])
  assert.deepEqual(lines.map((l) => l.text), ['Removed support for PostgreSQL 13', 'Faster thumbnails'])
})

const bundle = (o: Partial<NotesBundle> = {}): NotesBundle => ({
  source: { repo: 'o/r', tier: 'oci', confidence: 'high', detail: null },
  range: { from: '1.0.0', to: '1.2.0', approximate: false, basis: '' },
  releases: [],
  omitted: [],
  unplaced: [],
  changelog: null,
  external: null,
  commits: null,
  container: [],
  fetches: [],
  notes: [],
  incomplete: false,
  ...o,
})

const release = (tag: string, body: string) => ({ tag, key: versionKey(tag), prerelease: false, name: null, published: null, body })

test('a release with no words and no changelog section is a hole in the range', () => {
  const b = bundle({ releases: [release('1.2.0', '- fix'), release('1.1.0', '')] })
  assert.deepEqual(missingVersions(b), ['1.1.0'])
  const covered = bundle({
    releases: [release('1.1.0', '')],
    changelog: { file: 'CHANGELOG.md', sections: [{ heading: '1.1.0', key: versionKey('1.1.0'), unreleased: false, body: '- x' }], omitted: [] },
  })
  assert.deepEqual(missingVersions(covered), [])
})

test('the deployment is names only: values never leave this host', () => {
  const repo = mkdtempSync(join(tmpdir(), 'shipshape-screen-'))
  mkdirSync(join(repo, 'app'))
  writeFileSync(
    join(repo, 'app', 'docker-compose.yaml'),
    [
      'services:',
      '  app:',
      '    image: example/app:1.0.0',
      '    environment:',
      '      DB_PASSWORD: hunter2',
      '      TZ: UTC',
      '    volumes:',
      '      - ./data:/data',
      '      - type: bind',
      '        source: ./cfg',
      '        target: /config',
      '    depends_on: [db]',
      '    healthcheck:',
      '      test: ["CMD", "true"]',
      '  db:',
      '    image: postgres:16',
    ].join('\n'),
  )
  const d = deploymentOf(repo, 'app/docker-compose.yaml', 'app')!
  assert.deepEqual(d.environment, ['DB_PASSWORD', 'TZ'])
  assert.deepEqual(d.volumes, ['/config', '/data'])
  assert.deepEqual(d.depends_on, ['db (postgres:16)'])
  assert.equal(d.healthcheck, true)
  assert.doesNotMatch(JSON.stringify(d), /hunter2|UTC/)
  // The hash is stable and moves with the configuration.
  assert.equal(contextHash([d]), contextHash([{ ...d }]))
  assert.notEqual(contextHash([d]), contextHash([{ ...d, environment: ['TZ'] }]))
})

test('the state carries what code computed, so Jev is never asked to count', () => {
  const b = bundle({ releases: [release('1.2.0', '- Removed FOO'), release('1.1.0', '')] })
  const s = buildState(b, { image: 'o/r', from: '1.0.0', to: '1.2.0', magnitude: 'minor' }, [])
  assert.deepEqual(s.state.update.notes_missing_for, ['1.1.0'])
  assert.equal(s.state.lines.length, 1)
  assert.equal(Object.keys(questionsFor(s.lines.length)).filter((k) => k.startsWith('L')).length, 2)
})

// -------------------------------------------------------------------- deciding

const ev = (o: Partial<ScreenEvidence> = {}): ScreenEvidence => ({
  magnitude: 'patch',
  notesInRange: 2,
  incomplete: false,
  approximate: false,
  missing: 0,
  omitted: 0,
  sourceCertain: true,
  ...o,
})

const n = (v: number): Answer => ({ type: 'noul', noul: v })
function answers(o: Record<string, number> = {}, score = 0.1, conf = 0.95): Record<string, Answer> {
  const base: Record<string, Answer> = {
    config_removed_or_renamed: n(0.02),
    manual_step_required: n(0.02),
    irreversible_migration: n(0.01),
    dropped_support: n(0.01),
    default_changed: n(0.03),
    config_change_needed: n(0.02),
    affects_this_deployment: n(0.05),
    security_fix: n(0.1),
    risk: { type: 'score', score, confidence: conf },
  }
  for (const [k, v] of Object.entries(o)) base[k] = n(v)
  return base
}

test('clean answers on complete evidence are routine', () => {
  const r = decideScreen(ev(), answers(), 0)
  assert.equal(r.decision, 'routine')
  assert.equal(r.confidence, 'high')
  assert.equal(decideScreen(ev(), answers({}, 0.1, 0.8), 0).confidence, 'medium')
})

test('any risk question past the line is a finding, whatever else is true', () => {
  for (const k of ['config_removed_or_renamed', 'manual_step_required', 'irreversible_migration', 'dropped_support', 'config_change_needed']) {
    assert.equal(decideScreen(ev(), answers({ [k]: THRESHOLDS.findingRisk }), 0).decision, 'finding', k)
  }
  assert.equal(decideScreen(ev(), answers({}, 1.6), 0).decision, 'finding', 'the Score alone')
  // Even on evidence that could never be routine: a finding is a finding.
  assert.equal(decideScreen(ev({ incomplete: true }), answers({ dropped_support: 0.9 }), 0).decision, 'finding')
})

test('evidence that is not whole can never be routine', () => {
  for (const o of [
    { magnitude: 'major' },
    { magnitude: 'digest' },
    { incomplete: true },
    { approximate: true },
    { missing: 1 },
    { omitted: 1 },
    { sourceCertain: false },
  ]) {
    assert.equal(decideScreen(ev(o), answers(), 0).decision, 'escalate', JSON.stringify(o))
  }
})

test('the gap between no and yes goes to the reader', () => {
  // Below the finding line, above the routine line: not sure enough either way.
  assert.equal(decideScreen(ev(), answers({ config_change_needed: 0.3 }), 0).decision, 'escalate')
  assert.equal(decideScreen(ev(), answers({}, 0.1, 0.45), 0).decision, 'escalate', 'a Score it was unsure of')
  // The Score's position holds only at "breaks without action"; its middle level fit
  // almost every release in the calibration.
  assert.equal(decideScreen(ev(), answers({}, 1.0, 0.8), 0).decision, 'routine')
  assert.equal(decideScreen(ev(), answers({}, 1.6, 0.8), 0).decision, 'finding')
  // A missing Score reads as the riskiest answer, never the safest.
  const noScore = answers()
  delete noScore.risk
  assert.notEqual(decideScreen(ev(), noScore, 0).decision, 'routine')
})

test('a wide range is always read', () => {
  assert.equal(decideScreen(ev({ notesInRange: THRESHOLDS.routineMaxNotes + 1 }), answers(), 0).decision, 'escalate')
  assert.equal(decideScreen(ev({ notesInRange: THRESHOLDS.routineMaxNotes }), answers(), 0).decision, 'routine')
})

test('touching this deployment is shown, not decisive on its own', () => {
  assert.equal(decideScreen(ev(), answers({ affects_this_deployment: 0.7 }), 0).decision, 'routine')
})

test('a changed default is reported, never a reason to hold', () => {
  // Jev reads it literally and almost every release changes some behaviour.
  assert.equal(decideScreen(ev(), answers({ default_changed: 0.95 }), 0).decision, 'routine')
})

test('notes with CRLF line endings still yield their lines', () => {
  const lines = extractLines([note('v1', '## Changes:\r\n\r\n* add hdvideo-api resolves #14294\r\n* concen: removed. resolves #5097\r\n')])
  assert.equal(lines.length, 2)
})

test('no notes is its own answer, and costs nothing', () => {
  assert.equal(decideScreen(ev({ notesInRange: 0 }), null, 0).decision, 'no-notes')
})

test('lines are split into actionable and notable, never both', () => {
  const a = { ...answers(), L0_actionable: n(0.9), L0_notable: n(0.9), L1_actionable: n(0.1), L1_notable: n(0.8), L2_actionable: n(0.1), L2_notable: n(0.1) }
  const r = decideScreen(ev(), a, 3)
  assert.deepEqual(r.actionable, [0])
  assert.deepEqual(r.notable, [1])
})
