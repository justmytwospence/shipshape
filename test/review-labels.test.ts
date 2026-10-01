import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Labels: `shipshape.review` replaces `shipshape.claude` (both read), and a key nothing
 * reads is reported rather than silently ignored.
 */

const repo = mkdtempSync(join(tmpdir(), 'shipshape-labels-'))
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'shipshape-labels-data-'))

const { scanComposeFile } = await import('../src/compose/scan.ts')

function stack(name: string, labels: string[]): string {
  mkdirSync(join(repo, name), { recursive: true })
  const file = join(repo, name, 'docker-compose.yaml')
  writeFileSync(
    file,
    `services:\n  ${name}:\n    image: example/${name}:1.0.0\n    labels:\n${labels.map((l) => `      ${l}`).join('\n')}\n`,
  )
  return file
}

test('shipshape.review: required is read, and shipshape.claude still is', () => {
  const a = scanComposeFile(repo, stack('a', ['shipshape.watch: "true"', 'shipshape.review: required']))[0]!
  assert.equal(a.claudeLabel, 'required')
  const b = scanComposeFile(repo, stack('b', ['shipshape.watch: "true"', 'shipshape.claude: required']))[0]!
  assert.equal(b.claudeLabel, 'required')
})

test('an unknown shipshape key is reported, by name', () => {
  const s = scanComposeFile(repo, stack('c', ['shipshape.watch: "true"', 'shipshape.polcy: manual', 'shipshape.pattern: semver']))[0]!
  assert.deepEqual(s.unknownLabels, ['polcy'])
})

test('the dockhand prefix is no longer read', () => {
  const s = scanComposeFile(repo, stack('d', ['dockhand.watch: "true"']))[0]!
  assert.equal(s.watched, false)
})

test('a traefik router named shipshape is not a shipshape label', () => {
  const s = scanComposeFile(repo, stack('e', ['traefik.http.routers.shipshape.rule: Host(`x`)']))[0]!
  assert.deepEqual(s.unknownLabels, [])
})
