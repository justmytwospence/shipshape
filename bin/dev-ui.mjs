/**
 * A UI dev server that cannot act on anything.
 *
 * Working on the interface needs realistic data, but the app is not a viewer: `POST
 * /settings` commits into REPO_DIR, and a configured REPO_DIR + GITHUB_REPO arms the
 * scheduler, which syncs git, polls GitHub and deploys containers. So this builds a
 * throwaway world and points the app at that:
 *
 *   .dev/data       the app's database. Empty unless you hand it one with --db, which is an
 *                   online-backup copy (never the file itself: a live database is WAL and
 *                   its owner is still writing to it)
 *   .dev/checkout   the compose repository. An empty scratch git repo unless you hand it a
 *                   real one with --repo, which is a `git archive` of its HEAD in a
 *                   throwaway repo with no remote, so a settings save commits into the
 *                   sandbox and stops there
 *
 * plus SHIPSHAPE_UI_DEV=1, which stops the scheduler from starting at all, a scrubbed
 * environment with no credentials in it, and a DOCKER_HOST that points nowhere.
 *
 * The app refuses every request that does not come from its trusted proxy with the
 * configured user header, and it has no development bypass. So the app listens on PORT+1
 * and this script runs the smallest possible stand-in for that proxy on PORT: it forwards
 * everything to the app and adds `Remote-User: dev`. Browse PORT, never PORT+1.
 *
 * Usage:
 *   node bin/dev-ui.mjs                        # empty database and checkout: the first-run state
 *   node bin/dev-ui.mjs --repo ~/compose       # a sandbox copy of a compose repository's HEAD
 *   node bin/dev-ui.mjs --db ~/shipshape.db    # a sandbox copy of a real database
 *   node bin/dev-ui.mjs --fresh                # rebuild .dev/ from --repo / --db first
 *   node bin/dev-ui.mjs --empty                # drop the database: the first-run state again
 *   node bin/dev-ui.mjs --port 8082            # where you browse (default 8081)
 *   node bin/dev-ui.mjs --origin http://localhost:8081
 *       the browser origin the app accepts on POST. Default http://127.0.0.1:<port>; pass
 *       this when you browse by another name, such as localhost through an SSH tunnel.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { createServer, request } from 'node:http'

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))
const DEV = join(ROOT, '.dev')
const DATA = join(DEV, 'data')
const CHECKOUT = join(DEV, 'checkout')

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const opt = (f, d) => {
  const i = args.indexOf(f)
  return i === -1 ? d : args[i + 1]
}
const fail = (msg) => {
  console.error(`dev-ui: ${msg}`)
  process.exit(1)
}

const PORT = Number(opt('--port', '8081'))
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65534) fail('--port must be a port number below 65535')
const APP_PORT = PORT + 1
const ORIGIN = opt('--origin', `http://127.0.0.1:${PORT}`)
const fresh = has('--fresh')
const empty = has('--empty')
const repoArg = opt('--repo', null)
const dbArg = opt('--db', null)
if (repoArg !== null && !existsSync(repoArg)) fail(`--repo ${repoArg} does not exist`)
if (dbArg !== null && !existsSync(dbArg)) fail(`--db ${dbArg} does not exist`)

const run = (cmd, argv, opts = {}) =>
  execFileSync(cmd, argv, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // A developer's own git config (a commit hook, signing) must not reach the sandbox.
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    ...opts,
  })

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
  if (existsSync(target) && !(fresh && dbArg)) {
    console.log('· database: reusing .dev/data/shipshape.db (--empty to drop it, --db <file> --fresh to replace it)')
    return
  }
  if (!dbArg) {
    console.log('· database: empty (pass --db <file> for a copy of a real one)')
    return
  }
  // SQLite's online backup API: consistent even while another process writes to the WAL.
  // A plain copy of a WAL database is not. Run it in a child so the native module is
  // loaded from the app's own node_modules with the app's cwd.
  const script = [
    "const { default: Database } = await import('better-sqlite3')",
    `const db = new Database(${JSON.stringify(resolve(dbArg))}, { readonly: true })`,
    `await db.backup(${JSON.stringify(target)})`,
    'db.close()',
  ].join('\n')
  run(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT })
  console.log(`· database: snapshot of ${dbArg}`)
}

function snapshotCheckout() {
  if (existsSync(CHECKOUT) && !(fresh && repoArg)) {
    console.log('· checkout: reusing .dev/checkout (--repo <path> --fresh to re-archive)')
    return
  }
  rmSync(CHECKOUT, { recursive: true, force: true })
  mkdirSync(CHECKOUT, { recursive: true })
  const identity = ['-c', 'user.email=dev@localhost', '-c', 'user.name=dev']
  if (!repoArg) {
    run('git', ['-C', CHECKOUT, 'init', '-q', '-b', 'main'])
    run('git', ['-C', CHECKOUT, ...identity, 'commit', '-q', '--allow-empty', '-m', 'chore: scratch checkout'])
    console.log('· checkout: empty scratch repository (pass --repo <path> for a copy of a real one)')
    return
  }
  try {
    run('git', ['-C', repoArg, 'rev-parse', '--is-inside-work-tree'])
  } catch {
    fail(`--repo ${repoArg} is not a git repository: the sandbox is a \`git archive\` of its HEAD`)
  }
  // A sandbox copy of the compose files: the app scans these, and a settings save
  // commits into this throwaway repo instead of the real one. No remote, so nothing it
  // does can leave the directory.
  const tar = run('git', ['-C', repoArg, 'archive', 'HEAD'], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 })
  writeFileSync(join(DEV, 'checkout.tar'), tar)
  run('tar', ['-xf', join(DEV, 'checkout.tar'), '-C', CHECKOUT])
  rmSync(join(DEV, 'checkout.tar'), { force: true })
  run('git', ['-C', CHECKOUT, 'init', '-q', '-b', 'main'])
  run('git', ['-C', CHECKOUT, 'add', '-A'])
  run('git', ['-C', CHECKOUT, ...identity, 'commit', '-qm', 'chore: scratch copy'])
  console.log(`· checkout: git archive of ${repoArg} (throwaway repo, no remote)`)
}

mkdirSync(DEV, { recursive: true })
writeFileSync(join(DEV, '.gitignore'), '*\n')
snapshotDb()
snapshotCheckout()

// Everything that could reach the outside world is removed rather than left to chance.
const env = { ...process.env }
for (const k of [
  'GITHUB_TOKEN',
  'GITHUB_REPO',
  'GIT_REMOTE_URL',
  'GIT_TOKEN',
  'GIT_USERNAME',
  'GIT_BRANCH',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'NOTIFY_URL',
  'NOTIFY_TOKEN',
  'SMTP_URL',
  'MAIL_TO',
  'MAIL_FROM',
  'DOCKER_HUB_LOGIN',
  'DOCKER_HUB_PASSWORD',
  'SHIPSHAPE_ACTION_SECRET',
  'SHIPSHAPE_PASSWORD',
  'SHIPSHAPE_PASSWORD_FILE',
  'SHIPSHAPE_USER_HEADER',
  'MCP_PORT',
  'MCP_TOKEN',
  'MCP_HOST',
  'POLICY_FILE',
  'SELF_STACK',
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
  // containers. Point the daemon at a socket that does not exist and every deploy path
  // fails loudly and harmlessly, which is also a more honest thing to click on than a
  // button that quietly works.
  DOCKER_HOST: 'unix:///nonexistent/docker.sock',
  DATA_DIR: DATA,
  REPO_DIR: CHECKOUT,
  // A display string only: with no token nothing can act on it.
  GITHUB_REPO: 'you/compose-repo',
  // The app answers only the proxy below, as the user below, on the origin below.
  PORT: String(APP_PORT),
  SHIPSHAPE_TRUSTED_PROXY: '127.0.0.1',
  SHIPSHAPE_ALLOWED_USER: 'dev',
  SHIPSHAPE_ALLOWED_ORIGIN: ORIGIN,
  TZ: env.TZ ?? 'UTC',
})

// The stand-in for the authenticating reverse proxy: forward everything to the app and
// assert the identity it was configured to trust. Bound to loopback, so it is only as
// reachable as the machine you are sitting at (or the SSH tunnel you opened).
const proxy = createServer((req, res) => {
  const up = request(
    {
      host: '127.0.0.1',
      port: APP_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, 'remote-user': 'dev' },
    },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    },
  )
  up.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
    res.end(`dev proxy: the app on :${APP_PORT} is not answering yet (${e.message})`)
  })
  req.pipe(up)
})
proxy.listen(PORT, '127.0.0.1')

// The children are process-group leaders (detached): npx forks the real process, so
// signalling the wrapper alone would leave the app running behind it.
const children = []
const killGroup = (c) => {
  try {
    process.kill(-c.pid, 'SIGTERM')
  } catch {
    // already gone
  }
}
const stop = () => {
  proxy.close()
  for (const c of children) killGroup(c)
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

if (existsSync(join(ROOT, 'src', 'styles', 'app.css'))) {
  children.push(
    spawn('npx', ['@tailwindcss/cli', '-i', 'src/styles/app.css', '-o', 'public/app.css', '--watch=always'], {
      cwd: ROOT,
      env,
      stdio: 'inherit',
      detached: true,
    }),
  )
}
children.push(spawn('npx', ['tsx', 'watch', 'src/index.ts'], { cwd: ROOT, env, stdio: 'inherit', detached: true }))

console.log(`\n  ${ORIGIN.replace('localhost', '127.0.0.1')}   (scheduler disabled, sandbox data, signed in as "dev")`)
console.log(`  another machine: ssh -L ${PORT}:127.0.0.1:${PORT} <this-host>, browse http://localhost:${PORT},`)
console.log(`  and start this script with --origin http://localhost:${PORT}\n`)
