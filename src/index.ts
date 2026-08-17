import { loadPolicy } from './config.ts'
import { getDb, logEvent } from './db.ts'
import { startScheduler } from './scheduler.ts'
import { startServer } from './web/server.ts'

function main(): void {
  getDb()
  const { policy, error } = loadPolicy()
  if (error) {
    logEvent({ level: 'error', kind: 'system', message: 'policy load failed', detail: error })
  }
  logEvent({
    level: 'info',
    kind: 'system',
    message: 'shipshape started',
    detail: `merge=${policy.merge_method} push_main=${policy.sync.push_main} claude=${policy.claude.mode}`,
  })

  startServer()

  // `bin/dev-ui.mjs` sets this. Working on the interface needs realistic data, which
  // means a configured REPO_DIR -- and that is also what arms the scheduler, whose jobs
  // rewrite git, poll GitHub and recreate containers. Serving without ever starting them
  // is the difference between a dev server and a second production instance.
  if (process.env.SHIPSHAPE_UI_DEV) {
    logEvent({
      level: 'info',
      kind: 'system',
      message: 'UI dev mode: scheduler not started',
      detail: 'no scanning, no pull requests, no deploys',
    })
  } else {
    startScheduler()
  }

  // The git sync loop and deploy queue land in M2/M4. Scanning is registry-read-only:
  // nothing here writes to git or Docker.
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    console.log(`[system] ${sig} received, shutting down`)
    process.exit(0)
  })
}

main()
