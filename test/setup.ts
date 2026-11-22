import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Loaded before every test file (`node --import ./test/setup.ts`).
 *
 * The suite builds real git repositories and commits into them. A developer's own git
 * configuration must not reach those commands: a global commit-msg hook, `commit.gpgsign`
 * or `core.hooksPath` each fail dozens of fixtures that have nothing to do with the code
 * under test. And a machine with no git identity at all (a CI runner, a bare container)
 * makes `git commit` die with "unable to auto-detect email address".
 *
 * So git is pointed at a throwaway global config that carries only an identity, and the
 * system config is ignored. Child processes inherit this environment.
 *
 * The identity is a config file, not GIT_AUTHOR_* / GIT_COMMITTER_*: those variables
 * outrank the `-c user.name=...` flags the code under test passes, and would hide the
 * identity assertions (test/labels.test.ts, "a clean file is edited, committed, ...").
 */
const dir = mkdtempSync(join(tmpdir(), 'shipshape-gitconfig-'))
const file = join(dir, 'config')
writeFileSync(file, '[user]\n\tname = shipshape test\n\temail = test@example.com\n')
process.env.GIT_CONFIG_GLOBAL = file
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
