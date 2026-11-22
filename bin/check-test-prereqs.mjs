/**
 * Fails fast, in words, when the machine cannot run the suite.
 *
 * The tests build real git repositories and several of them (ship, forks, label edits) let
 * the production code run `docker compose config` as its safety gate. Without `git` or
 * `docker compose` on PATH those tests fail with an assertion about a count, which reads
 * as a bug in the code under test. Run by `pretest`.
 */
import { execFileSync } from 'node:child_process'

const needs = [
  { name: 'git', argv: ['git', '--version'], why: 'every fixture is a real repository' },
  {
    name: 'docker compose',
    argv: ['docker', 'compose', 'version'],
    why: 'the edit gate runs `docker compose config`; only the CLI and plugin are needed, not a daemon',
  },
]

const missing = needs.filter(({ argv }) => {
  try {
    execFileSync(argv[0], argv.slice(1), { stdio: 'ignore' })
    return false
  } catch {
    return true
  }
})

if (missing.length > 0) {
  for (const m of missing) console.error(`npm test needs \`${m.argv.join(' ')}\` to work: ${m.why}.`)
  process.exit(1)
}
