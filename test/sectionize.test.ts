import { test } from 'node:test'
import assert from 'node:assert/strict'
import { headingVersion, sectionize, sectionsInRange, SECTION_CAP } from '../src/notes/sectionize.ts'
import { versionKey } from '../src/versions/key.ts'

/**
 * Changelog files, cut by version, in the shapes real projects write them.
 */

const key = (t: string) => versionKey(t)!

test('minuspod: a Keep a Changelog file gives exactly the versions an update skips over', () => {
  const text = [
    '# Changelog',
    '',
    'All notable changes to this project will be documented in this file.',
    '',
    '## [2.96.18] - 2026-09-11',
    '### Fixed',
    '- Later fix',
    '',
    '## [2.96.17] - 2026-09-10',
    '### Added',
    '- Transcript cache',
    '### Fixed',
    '- Feed refresh',
    '',
    '## [2.96.16] - 2026-09-10',
    '### Changed',
    '- Default model',
    '',
    '## [2.96.15] - 2026-09-09',
    '### Fixed',
    '- Earlier fix',
  ].join('\n')
  const sections = sectionize(text, { filename: 'CHANGELOG.md' })
  assert.deepEqual(sections.map((s) => s.heading), ['[2.96.18] - 2026-09-11', '[2.96.17] - 2026-09-10', '[2.96.16] - 2026-09-10', '[2.96.15] - 2026-09-09'])

  // The image tags carry a variant; the versions in the file do not.
  const { sections: inRange } = sectionsInRange(sections, key('2.96.15-cpu'), key('2.96.17-cpu'))
  assert.deepEqual(inRange.map((s) => s.heading), ['[2.96.17] - 2026-09-10', '[2.96.16] - 2026-09-10'])
  // Subsections stay inside their version.
  assert.match(inRange[0]!.body, /### Added\n- Transcript cache\n### Fixed\n- Feed refresh/)
})

test('ddclient: a date before the version, and an unreleased section that is no version at all', () => {
  const text = [
    '# ChangeLog',
    '## v4.0.1-rc.2 (unreleased work-in-progress)',
    '### Bug fixes',
    '- not shipped',
    '## 2026-05-16 v4.0.1-rc.1',
    '### Provider updates',
    '- rc one',
    '## 2025-01-19 v4.0.0',
    '### Breaking changes',
    '- the big one',
  ].join('\n')
  const sections = sectionize(text)
  assert.equal(sections[0]!.unreleased, true)
  assert.equal(sections[0]!.key, null)
  assert.equal(sections[1]!.key?.pre, 'rc.1')
  assert.deepEqual(sections[2]!.key?.core, [4, 0, 0])
  const { sections: picked } = sectionsInRange(sections, key('v3.11.2'), key('v4.0.0'))
  assert.deepEqual(picked.map((s) => s.heading), ['2025-01-19 v4.0.0'])
})

test('glances: an RST file, whose title shares its versions\' adornment and is not one of them', () => {
  const text = [
    '==============================================================================',
    '                              Glances ChangeLog',
    '==============================================================================',
    '',
    '=============',
    'Version 4.5.6',
    '=============',
    '',
    'Bugs corrected:',
    '',
    '* A thing',
    '',
    '=============',
    'Version 4.5.5',
    '=============',
    '',
    'Enhancements:',
    '',
    '* Another thing',
    '',
    '=============',
    'Version 4.5.4',
    '=============',
    '',
    '* Older',
  ].join('\n')
  const sections = sectionize(text, { filename: 'NEWS.rst' })
  assert.deepEqual(sections.map((s) => s.key?.core.join('.')), ['4.5.6', '4.5.5', '4.5.4'])
  assert.match(sections[0]!.body, /Bugs corrected:\n\n\* A thing/)
  assert.doesNotMatch(sections[0]!.body, /Version 4\.5\.5/)
})

test("n8n: an H1 per version, and the compare link's older version is not the heading's", () => {
  const text = [
    '# [2.39.0](https://github.com/n8n-io/n8n/compare/n8n@2.38.1...n8n@2.39.0) (2026-09-08)',
    '### Bug Fixes',
    '* one',
    '# [2.38.1](https://github.com/n8n-io/n8n/compare/n8n@2.37.0...n8n@2.38.1) (2026-09-01)',
    '### Features',
    '* two',
  ].join('\n')
  const sections = sectionize(text)
  assert.deepEqual(sections.map((s) => s.key?.core.join('.')), ['2.39.0', '2.38.1'])
})

test('a dated heading names its version, not its date', () => {
  assert.deepEqual(headingVersion('v2.18.1 (2026-08-26)').key?.core, [2, 18, 1])
  assert.deepEqual(headingVersion('[4.137.0](https://github.com/coder/code-server/releases/tag/v4.137.0) - 2026-09-11').key?.core, [4, 137, 0])
  // A date-versioned project keeps its dates.
  assert.equal(headingVersion('2026.07.2', 'date').key?.family, 'date')
  assert.equal(headingVersion('[Unreleased]').unreleased, true)
  // A link whose text is not a version: its target's versions are not the heading's.
  assert.deepEqual(headingVersion('[Full changelog](https://github.com/o/r/compare/v1.1.0...v1.2.0) 1.2.0').key?.core, [1, 2, 0])
  assert.deepEqual(headingVersion('[Diff](https://github.com/o/r/compare/1.1.0...1.2.0) - 1.2.0').key?.core, [1, 2, 0])
})

test('headings inside a code fence are not headings, and a file with no versions is not a changelog', () => {
  const fenced = ['# Changelog', '```md', '## 1.0.0', '## 0.9.0', '```', '## 2.0.0', 'real', '## 1.9.0', 'also real'].join('\n')
  assert.deepEqual(sectionize(fenced).map((s) => s.heading), ['2.0.0', '1.9.0'])
  // postgres keeps a file called HISTORY that points somewhere else.
  const pointer = 'Release notes for all versions of PostgreSQL can be found on-line at\nhttps://www.postgresql.org/docs/current/release.html\n'
  assert.deepEqual(sectionize(pointer, { filename: 'HISTORY' }), [])
})

test('a huge section is cut, and past the total the rest are named rather than dropped', () => {
  const big = 'x'.repeat(SECTION_CAP + 500)
  const text = ['## 1.3.0', big, '## 1.2.0', 'y'.repeat(12_000), '## 1.1.0', 'z'.repeat(12_000), '## 1.0.0', 'old'].join('\n')
  const sections = sectionize(text)
  assert.ok(sections[0]!.body.length < SECTION_CAP + 100)
  assert.match(sections[0]!.body, /the rest of this section was cut/)
  const { sections: kept, omitted } = sectionsInRange(sections, key('1.0.0'), key('1.3.0'))
  assert.deepEqual(kept.map((s) => s.heading), ['1.3.0'])
  assert.deepEqual(omitted, ['1.2.0', '1.1.0'])
})
