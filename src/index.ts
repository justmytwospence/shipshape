import { env, loadPolicy, policyFileState } from './config.ts'
import { getDb, logEvent } from './db.ts'
import { reclaimInterrupted } from './deploy/queue.ts'
import { startScheduler } from './scheduler.ts'
import { startServer } from './web/server.ts'
import { startMcpServer } from './mcp/listen.ts'

function main(): void {
  getDb()
  // Whatever was running when the last process stopped is not running now.
  reclaimInterrupted()
  const { policy, error, missing } = loadPolicy()
  if (error) {
    logEvent({ level: 'error', kind: 'system', message: 'policy load failed', detail: error })
  } else if (missing) {
    logEvent({
      level: 'info',
      kind: 'system',
      message: 'no policy file yet',
      detail: `defaults apply and shipshape is paused. The first change made in Settings creates ${policyFileState().rel}.`,
    })
  }
  logEvent({
    level: 'info',
    kind: 'system',
    message: 'shipshape started',
    detail: `ships=merge-commits push_main=${policy.sync.push_main} screen=${policy.review.screen} reader=${policy.review.model} branch=${env.gitBranch} remote=${env.gitRemote.host || env.gitRemote.kind}`,
  })

  startServer()
  startMcpServer()

  // `bin/dev-ui.mjs` sets this. Working on the interface needs realistic data, which
  // means a configured REPO_DIR -- and that is also what arms the scheduler, whose jobs
  // rewrite git, poll GitHub and recreate containers. Serving without ever starting them
  // is the difference between a dev server and a second production instance.
  if (env.uiDev) {
    logEvent({
      level: 'info',
      kind: 'system',
      message: 'UI dev mode: scheduler not started',
      detail: 'no scanning, no shipping, no deploys',
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
