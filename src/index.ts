import { env, loadPolicy, policyFileState } from './config.ts'
import { closeDb, getDb, logEvent } from './db.ts'
import { reclaimInterrupted } from './deploy/queue.ts'
import { deploysIdle } from './deploy/runner.ts'
import { gitIdle } from './gitops/repo.ts'
import { drain, inFlight, type ServerHandle } from './lifecycle.ts'
import { schedulerIdle, startScheduler, stopScheduler } from './scheduler.ts'
import { createShutdown } from './shutdown.ts'
import { startServer } from './web/server.ts'
import { startMcpServer } from './mcp/listen.ts'

let web: ServerHandle | null = null
let mcp: ServerHandle | null = null

async function main(): Promise<void> {
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

  web = startServer()
  mcp = startMcpServer()

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
}

const shutdown = createShutdown({
  closeListeners: () => Promise.allSettled([web?.close(), mcp?.close()]),
  stopScheduler,
  idle: () => [schedulerIdle(), drain(), deploysIdle(), gitIdle()],
  inFlight,
  closeDb,
  exit: (code) => process.exit(code),
  log: logEvent,
})

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => void shutdown(sig))
}

process.on('unhandledRejection', (r) => {
  try {
    logEvent({
      level: 'error',
      kind: 'system',
      message: 'unhandled promise rejection',
      detail: r instanceof Error ? `${r.message}\n${r.stack ?? ''}`.slice(0, 600) : String(r),
    })
  } catch {
    console.error(r)
  }
})

process.on('uncaughtException', (e) => {
  try {
    logEvent({
      level: 'error',
      kind: 'system',
      message: 'uncaught exception; restarting',
      detail: `${e.message}\n${e.stack ?? ''}`.slice(0, 600),
    })
  } catch {
    console.error(e)
  }
  process.exit(1)
})

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
