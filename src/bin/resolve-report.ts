/**
 * Where each watched image's release notes come from: the answer now, and what a fresh look
 * would say.
 *
 *   npm run resolve-report -- --snapshot
 *   npm run resolve-report -- --dry-run [--allow-billed] [--only <text>] [--without-overrides] [--why]
 *   npm run resolve-report -- --write [--allow-billed] [--only <text>]
 *
 * In the container: `node dist/bin/resolve-report.js ...`.
 *
 * `--dry-run` writes no resolutions. It still spends what a lookup spends -- GitHub requests
 * and, with `--allow-billed`, Docker Hub pulls -- and warms the HTTP cache as it goes.
 * `--without-overrides` shows what the automatic tiers find for images the curated map
 * answers today, which is how to tell which entries the map still needs.
 */
import { getDb } from '../db.ts'
import { lookUpImage, sourceFor, sourceForSync, type Lookup, type SourceInfo } from '../resolver/index.ts'

const args = process.argv.slice(2)
const has = (flag: string) => args.includes(flag)
const valueOf = (flag: string) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

const mode = has('--write') ? 'write' : has('--dry-run') ? 'dry-run' : has('--snapshot') ? 'snapshot' : null
if (!mode) {
  console.error('usage: resolve-report --snapshot | --dry-run [--allow-billed] [--only <text>] [--without-overrides] [--why] | --write [--allow-billed] [--only <text>]')
  process.exit(2)
}
const only = valueOf('--only')
const allowBilled = has('--allow-billed')

const images = (
  getDb()
    .prepare(
      `SELECT DISTINCT i.registry, i.repository,
              (SELECT j.current_tag FROM images j
                WHERE j.registry = i.registry AND j.repository = i.repository
                  AND j.current_tag IS NOT NULL AND j.current_tag != ''
                ORDER BY j.stack, j.service LIMIT 1) AS tag
         FROM images i
        WHERE i.watched = 1 AND i.repository IS NOT NULL AND i.repository != ''
        ORDER BY i.registry, i.repository`,
    )
    .all() as { registry: string; repository: string; tag: string | null }[]
).filter((i) => !only || only.split(',').some((o) => `${i.registry}/${i.repository}`.includes(o)))

const answer = (repo: string | null, tier: string, confidence: string | null) =>
  repo ? `${tier}/${confidence ?? '?'} ${repo}` : 'none'

const nowOf = (s: SourceInfo) => (s.inferred ? answer(s.inferred.repo, s.inferred.tier, s.inferred.confidence) : 'not looked up')

const extras = (o: { packagingRepo: string | null; error?: string | null; failure?: string | null; label?: string | null }) =>
  [
    o.label ? `label=${o.label}` : '',
    o.packagingRepo ? `packaging=${o.packagingRepo}` : '',
    o.error ? `error=${o.error}` : '',
    o.failure ? `failure=${o.failure}` : '',
  ]
    .filter(Boolean)
    .join('  ')

const tally = new Map<string, number>()
const count = (k: string) => tally.set(k, (tally.get(k) ?? 0) + 1)

for (const image of images) {
  const key = `${image.registry}/${image.repository}`
  const before = sourceForSync(image)

  if (mode === 'snapshot') {
    count(before.repo ? `${before.tier}/${before.confidence}` : before.inferred ? 'none' : 'not looked up')
    console.log(`${key}\t${nowOf(before)}\t${extras({ ...before, label: before.label?.repo })}`)
    continue
  }

  if (mode === 'write') {
    const after = await sourceFor(image, { force: true, allowBilled, tag: image.tag })
    count(after.inferred?.repo ? `${after.inferred.tier}/${after.inferred.confidence}` : 'none')
    console.log(`${key}\t${nowOf(before)} -> ${nowOf(after)}\t${extras({ ...after, label: after.label?.repo })}`)
    continue
  }

  const l: Lookup = await lookUpImage(image, image.tag, { allowBilled, ignoreOverrides: has('--without-overrides') })
  const after = answer(l.repo, l.tier, l.confidence)
  count(l.repo ? `${l.tier}/${l.confidence}` : 'none')
  const changed = nowOf(before) !== after ? '*' : ' '
  console.log(`${changed} ${key}\t${nowOf(before)} -> ${after}\t${extras({ ...l, label: before.label?.repo })}`)
  if (has('--why')) {
    for (const c of l.evidence.candidates) console.log(`      ${c.tier} ${c.repo}: ${c.confidence ?? 'rejected'} -- ${c.why}`)
    for (const s of l.evidence.skipped) console.log(`      skipped ${s}`)
    if (l.detail) console.log(`      detail: ${l.detail}`)
  }
}

console.log(`\n${images.length} images: ${[...tally].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(', ')}`)
