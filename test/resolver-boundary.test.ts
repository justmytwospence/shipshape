import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * Only the resolver decides which repository an image comes from.
 *
 * Five places used to answer it for themselves -- three by joining the resolution cache,
 * two by calling the resolver without the service's label -- and they disagreed: a
 * `shipshape.source` label linked the pull request body and nothing else. A grep is a blunt
 * instrument, and that is the point: the next direct join fails here rather than quietly
 * reintroducing the disagreement.
 */

const SRC = join(import.meta.dirname, '..', 'src')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return files(p)
    return /\.(ts|tsx)$/.test(name) ? [relative(SRC, p).split(sep).join('/')] : []
  })
}

const ALL = files(SRC)
const read = (f: string) => readFileSync(join(SRC, f), 'utf8')

test('nothing outside the resolver reads or writes the resolution cache', () => {
  const offenders = ALL.filter((f) => !f.startsWith('resolver/') && f !== 'db.ts').filter((f) =>
    /\b(FROM|JOIN|INTO|UPDATE)\s+resolutions\b/.test(read(f)),
  )
  assert.deepEqual(offenders, [])
})

test('nothing outside the resolver and the scan reads shipshape.source out of the database', () => {
  const offenders = ALL.filter(
    (f) => !f.startsWith('resolver/') && f !== 'scan.ts' && f !== 'db.ts',
  ).filter((f) => /\bsource_label\b/.test(read(f)))
  assert.deepEqual(offenders, [])
})
