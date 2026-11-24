import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `convert-v1` as an operator runs it, against a scratch repository: the dry run, the one
 * commit, and the refusals that must leave every byte where it was.
 */

const data = mkdtempSync(join(tmpdir(), 'shipshape-convert-data-'))
const repo = mkdtempSync(join(tmpdir(), 'shipshape-convert-repo-'))
after(() => {
  rmSync(data, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

const COMPOSE = `services:
  jellyfin:
    # the media server
    image: jellyfin/jellyfin:10.9.11
    labels:
      shipshape.watch: "true"
      shipshape.policy: auto
      shipshape.claude: required
`
const POLICY = `# shipshape policy
merge:
  auto: true
  cooldown_days: 3
deploy:
  mode: auto
`
const FILE = join(repo, 'media', 'docker-compose.yaml')
const g = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()

function run(...args: string[]) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATA_DIR: data,
    REPO_DIR: repo,
    GITHUB_REPO: 'you/repo',
    GIT_BRANCH: 'main',
  }
  for (const k of ['POLICY_FILE', 'NOTIFY_URL', 'GIT_REMOTE_URL', 'GITHUB_TOKEN', 'GIT_TOKEN']) delete env[k]
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/bin/convert-v1.ts', ...args], {
    env,
    encoding: 'utf8',
  })
  return { code: r.status, out: r.stdout + r.stderr }
}

beforeEach(() => {
  rmSync(repo, { recursive: true, force: true })
  mkdirSync(join(repo, 'media'), { recursive: true })
  writeFileSync(FILE, COMPOSE)
  writeFileSync(join(repo, 'shipshape.yaml'), POLICY)
  g(['init', '-q'])
  g(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  g(['add', '-A'])
  g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture'])
})

test('a dry run changes nothing and exits 1', () => {
  const head = g(['rev-parse', 'HEAD'])
  const r = run()
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /jellyfin: \(none\) -> shipshape\.class: normal/)
  assert.match(r.out, /jellyfin: shipshape\.claude: required removed/)
  assert.match(r.out, /paused: false {2}\(from merge\.auto and deploy\.mode\)/)
  assert.match(r.out, /Dry run: nothing was changed/)
  assert.equal(g(['rev-parse', 'HEAD']), head)
  assert.equal(g(['status', '--porcelain']), '')
})

test('--write makes one commit and a second run says Nothing to convert', () => {
  const r = run('--write')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /Committed [0-9a-f]+/)
  assert.equal(g(['log', '-1', '--pretty=%s']), 'chore(shipshape): convert v1 labels and policy keys')
  assert.equal(g(['log', '-1', '--pretty=%an']), 'shipshape')
  assert.equal(g(['rev-list', '--count', 'HEAD']), '2')
  assert.equal(g(['status', '--porcelain']), '')

  const compose = readFileSync(FILE, 'utf8')
  assert.ok(compose.includes('      shipshape.class: normal\n'))
  assert.ok(compose.includes('      shipshape.review: required\n'))
  assert.ok(!/shipshape\.(policy|claude):/.test(compose))
  assert.ok(compose.includes('# the media server'))
  const policy = readFileSync(join(repo, 'shipshape.yaml'), 'utf8')
  assert.ok(policy.startsWith('# shipshape policy\n'))
  assert.match(policy, /^paused: false$/m)
  assert.match(policy, /^ {2}cooldown_days: 3$/m)
  assert.ok(!/^(merge|deploy):/m.test(policy), policy)

  const again = run()
  assert.equal(again.code, 0, again.out)
  assert.match(again.out, /Nothing to convert\./)
})

test('a dirty compose file is refused with exit 2 and nothing written', () => {
  const dirty = COMPOSE + '# a hand edit in flight\n'
  writeFileSync(FILE, dirty)
  const head = g(['rev-parse', 'HEAD'])
  const r = run('--write')
  assert.equal(r.code, 2, r.out)
  assert.match(r.out, /media\/docker-compose\.yaml has uncommitted changes/)
  assert.equal(readFileSync(FILE, 'utf8'), dirty)
  assert.equal(readFileSync(join(repo, 'shipshape.yaml'), 'utf8'), POLICY)
  assert.equal(g(['rev-parse', 'HEAD']), head)
})

test('off the configured branch, nothing happens', () => {
  g(['checkout', '-q', '-b', 'elsewhere'])
  const r = run('--write')
  assert.equal(r.code, 2, r.out)
  assert.match(r.out, /The checkout is on "elsewhere", not main/)
  assert.equal(readFileSync(FILE, 'utf8'), COMPOSE)
  assert.equal(g(['rev-list', '--count', 'HEAD']), '1')
})
