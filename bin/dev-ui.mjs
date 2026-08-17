/**
 * A UI dev server that cannot act on anything.
 *
 * Working on the interface needs realistic data -- 149 services, 41 live updates, real
 * verdicts -- but the app is not a viewer: `POST /settings` commits into REPO_DIR, and a
 * configured REPO_DIR + GITHUB_REPO arms the scheduler, which syncs git, polls GitHub and
 * deploys containers. So this builds a throwaway world and points the app at that:
 *
 *   .dev/data       an online-backup copy of the live SQLite database (never the file
 *                   itself -- it is WAL and being written to by the running container)
 *   .dev/checkout   `git archive` of the compose repo with its own throwaway git repo,
 *                   no remote, so a settings save commits into the sandbox and stops
 *
 * plus SHIPSHAPE_UI_DEV=1, which stops the scheduler from starting at all, and a
 * scrubbed environment with no tokens in it.
 *
 * Usage:
 *   node bin/dev-ui.mjs              # snapshot if missing, then serve on :8081
 *   node bin/dev-ui.mjs --fresh      # re-snapshot the database and checkout first
 *   node bin/dev-ui.mjs --empty      # empty database: the unconfigured/first-run state
 *   node bin/dev-ui.mjs --port 8082
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))
const DEV = join(ROOT, '.dev')
const DATA = join(DEV, 'data')
const CHECKOUT = join(DEV, 'checkout')

// The app lives at <repo>/shipshape/app; the compose repo is two levels up. In a git
// worktree that is the worktree, whose `data/` is gitignored and therefore empty -- the
// database only ever exists in the primary checkout, so look there too.
const REPO = resolve(ROOT, '..', '..')

function primaryCheckout() {
  try {
    // .git/worktrees/<name>/... in a linked worktree; <repo>/.git otherwise.
    const common = execFileSync('git', ['-C', REPO, 'rev-parse', '--absolute-git-dir'], {
      encoding: 'utf8',
    }).trim()
    const mainGitDir = common.split('/.git/')[0] + '/.git'
    return dirname(mainGitDir)
  } catch {
    return null
  }
}

const dbCandidates = () => {
  const primary = primaryCheckout()
  return [
    opt('--db', null),
    join(REPO, 'shipshape', 'data', 'shipshape.db'),
    join(REPO, 'shipshape', 'data', 'shipshape-backup.db'),
    ...(primary
      ? [
          join(primary, 'shipshape', 'data', 'shipshape.db'),
          join(primary, 'shipshape', 'data', 'shipshape-backup.db'),
        ]
      : []),
  ].filter(Boolean)
}

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const opt = (f, d) => {
  const i = args.indexOf(f)
  return i === -1 ? d : args[i + 1]
}
const PORT = opt('--port', '8081')
const fresh = has('--fresh')
const empty = has('--empty')

const run = (cmd, argv, opts = {}) =>
  execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })

function snapshotDb() {
  mkdirSync(DATA, { recursive: true })
  const target = join(DATA, 'shipshape.db')
  if (empty) {
    for (const f of ['shipshape.db', 'shipshape.db-wal', 'shipshape.db-shm']) {
      rmSync(join(DATA, f), { force: true })
    }
    console.log('· database: empty (first-run state)')
    return
  }
  if (existsSync(target) && !fresh) {
    console.log('· database: reusing .dev/data/shipshape.db (--fresh to re-snapshot)')
    return
  }
  const source = dbCandidates().find((p) => existsSync(p))
  if (!source) {
    console.log('· database: no live database found — starting empty')
    return
  }
  // SQLite's online backup API: consistent even while the container writes to the WAL.
  // A plain copy of a WAL database is not. Run it in a child so the native module is
  // loaded from the app's own node_modules with the app's cwd.
  const script = [
    "const { default: Database } = await import('better-sqlite3')",
    `const db = new Database(${JSON.stringify(source)}, { readonly: true })`,
    `await db.backup(${JSON.stringify(target)})`,
    'db.close()',
  ].join('\n')
  run(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT })
  console.log(`· database: snapshot of ${source}`)
}

function snapshotCheckout() {
  if (existsSync(CHECKOUT) && !fresh) {
    console.log('· checkout: reusing .dev/checkout (--fresh to re-archive)')
    return
  }
  rmSync(CHECKOUT, { recursive: true, force: true })
  mkdirSync(CHECKOUT, { recursive: true })
  // A sandbox copy of the compose files: the app scans these, and a settings save
  // commits into this throwaway repo instead of the real one. No remote, so nothing
  // it does can leave the directory.
  const tar = run('git', ['-C', REPO, 'archive', 'HEAD'], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 })
  writeFileSync(join(DEV, 'checkout.tar'), tar)
  run('tar', ['-xf', join(DEV, 'checkout.tar'), '-C', CHECKOUT])
  rmSync(join(DEV, 'checkout.tar'), { force: true })
  run('git', ['-C', CHECKOUT, 'init', '-q', '-b', 'main'])
  run('git', ['-C', CHECKOUT, 'add', '-A'])
  run('git', ['-C', CHECKOUT, '-c', 'user.email=dev@localhost', '-c', 'user.name=dev', 'commit', '-qm', 'scratch'])
  console.log('· checkout: git archive of the compose repo (throwaway repo, no remote)')
}

mkdirSync(DEV, { recursive: true })
writeFileSync(join(DEV, '.gitignore'), '*\n')
snapshotDb()
snapshotCheckout()

// Everything that could reach the outside world is removed rather than left to chance.
const env = { ...process.env }
for (const k of [
  'GITHUB_TOKEN',
  'ANTHROPIC_API_KEY',
  'NTFY_URL',
  'NTFY_TOPIC',
  'NTFY_TOKEN',
  'SMTP_URL',
  'MAIL_TO',
  'MAIL_FROM',
  'DOCKER_HUB_LOGIN',
  'DOCKER_HUB_PASSWORD',
]) {
  delete env[k]
}
Object.assign(env, {
  SHIPSHAPE_UI_DEV: '1',
  // The one thing the sandbox could still reach.
  //
  // Deleting the tokens stops it talking to GitHub and the model, and the scratch
  // checkout stops it committing anywhere real -- but the docker socket belongs to the
  // host, so pressing Deploy in a dev server would run `compose up` against live
  // containers. Most services here name their containers explicitly, so that would not
  // even land in a separate project: it would recreate the real one. Point the daemon at
  // a socket that does not exist and every deploy path fails loudly and harmlessly,
  // which is also a more honest thing to click on than a button that quietly works.
  DOCKER_HOST: 'unix:///nonexistent/docker.sock',
  DATA_DIR: DATA,
  REPO_DIR: CHECKOUT,
  // A display string only: with no token nothing can act on it, and PR links render.
  GITHUB_REPO: 'justmytwospence/homelab',
  PORT,
  TZ: env.TZ ?? 'America/Denver',
})

const children = []
const stop = () => {
  for (const c of children) c.kill('SIGTERM')
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

if (existsSync(join(ROOT, 'src', 'styles', 'app.css'))) {
  children.push(
    spawn('npx', ['@tailwindcss/cli', '-i', 'src/styles/app.css', '-o', 'public/app.css', '--watch'], {
      cwd: ROOT,
      env,
      stdio: 'inherit',
    }),
  )
}
children.push(spawn('npx', ['tsx', 'watch', 'src/index.ts'], { cwd: ROOT, env, stdio: 'inherit' }))

console.log(`\n  http://127.0.0.1:${PORT}   (scheduler disabled, sandbox data)`)
console.log(`  from the Mac: ssh -L ${PORT}:127.0.0.1:${PORT} nuc, then http://localhost:${PORT}\n`)
