import type { ServiceObservation, ServiceSnapshot } from './probe.ts'

/**
 * Deciding whether a deploy worked.
 *
 * The old check asked "is every container running?" and returned yes the first time the
 * answer was yes -- about a second after compose exited. For the ~40% of services here
 * that declare a healthcheck that was merely optimistic. For the other 60% it was
 * meaningless: `running` one second after start is what a container that is about to
 * crash also looks like. A verify window that can pass in one sample is not a window.
 *
 * So this samples, and every tool that does this seriously samples: Swarm watches for
 * `--update-monitor`, Kamal polls a health endpoint until `deploy_timeout`, Argo runs an
 * analysis `count` times at `interval` with a `failureLimit`. The shape they share is
 * the one implemented here -- repeated observation, an explicit pass condition, an
 * explicit fail condition, and a deadline that is a failure rather than a default pass.
 *
 * Three rules earned their own lines:
 *
 * 1. **A service with no healthcheck earns "up" by staying up.** It must be observed
 *    running continuously for a dwell period with no restarts, never by existing once.
 *    Kamal calls this `readiness_delay` and docker-rollout calls it `--wait`; both exist
 *    because "no health signal" means unknown, not healthy.
 * 2. **A probe that cannot connect is not a failing service.** Argo separates
 *    `consecutiveErrorLimit` from `failureLimit` for this reason: an instrument that is
 *    broken must not be read as the thing it measures being broken. Probe errors are
 *    recorded and never decide.
 * 3. **The image is checked once, explicitly.** A deploy that changed nothing -- because
 *    compose reused a container, or the pull silently failed -- is not a success, and it
 *    is the failure this lab has actually experienced.
 */

export interface VerifyConfig {
  /** Total deadline. Reaching it with anything unsettled is a failure, not a pass. */
  windowS: number
  intervalS: number
  /** Continuous running time a service with no healthcheck must accumulate. */
  minDwellS: number
  /** Consecutive healthy samples before a healthchecked service passes. */
  consecutiveOk: number
  /** Restarts since the deploy that mean a crash loop. */
  crashRestarts: number
}

export const DEFAULT_VERIFY: Omit<VerifyConfig, 'windowS'> = {
  intervalS: 5,
  minDwellS: 30,
  consecutiveOk: 2,
  crashRestarts: 2,
}

export type Severity = 'hard' | 'soft'

export interface Finding {
  service: string
  severity: Severity
  /** Short machine-ish reason, used in the deploy record and the alert subject line. */
  code: string
  detail: string
}

export type Verdict =
  | { kind: 'passed'; detail: string }
  | { kind: 'degraded'; findings: Finding[]; detail: string }
  | { kind: 'failed'; findings: Finding[]; detail: string }
  | { kind: 'error'; detail: string }

/** One service's accumulated evidence across samples. */
interface Track {
  okStreak: number
  runningSinceMs: number | null
  baselineRestarts: number | null
  firstId: string | null
  restartingStreak: number
  probe5xx: number
  probed: number
  settled: boolean
  findings: Finding[]
}

export interface Sample {
  obs: ServiceObservation
  /** Undefined when the service declares no port, or probing is off. */
  probe?: { status: number } | { error: string }
  /** The image reference the compose file now pins, for the one-shot match check. */
  expectedImageRef?: string | null
}

/**
 * The decision machine. Fed samples, returns a verdict when it has one.
 *
 * Pure and synchronous so the whole table above is testable against scripted sequences
 * without a docker daemon anywhere near it.
 */
export class Verifier {
  private tracks = new Map<string, Track>()
  private cliErrors = 0
  private elapsedMs = 0
  private imageChecked = false

  constructor(
    private readonly services: string[],
    private readonly snapshot: ServiceSnapshot[],
    private readonly cfg: VerifyConfig,
  ) {
    for (const s of services) {
      this.tracks.set(s, {
        okStreak: 0,
        runningSinceMs: null,
        baselineRestarts: null,
        firstId: null,
        restartingStreak: 0,
        probe5xx: 0,
        probed: 0,
        settled: false,
        findings: [],
      })
    }
  }

  /** Feed one round of observations. Returns null while it needs more. */
  push(samples: Sample[], elapsedMs: number): Verdict | null {
    this.elapsedMs = elapsedMs

    if (samples.length === 0) {
      this.cliErrors++
      // Three failures to observe anything is an instrument problem. Rolling back on it
      // would be acting on ignorance.
      if (this.cliErrors >= 3) {
        return { kind: 'error', detail: 'could not read container state three times running' }
      }
      return null
    }
    this.cliErrors = 0

    for (const s of samples) this.evaluate(s, elapsedMs)

    const hard = this.allFindings().filter((f) => f.severity === 'hard')
    if (hard.length > 0) {
      return { kind: 'failed', findings: hard, detail: hard.map((f) => `${f.service}: ${f.detail}`).join('; ') }
    }

    if ([...this.tracks.values()].every((t) => t.settled)) {
      const soft = this.allFindings().filter((f) => f.severity === 'soft')
      if (soft.length > 0) {
        return {
          kind: 'degraded',
          findings: soft,
          detail: soft.map((f) => `${f.service}: ${f.detail}`).join('; '),
        }
      }
      return { kind: 'passed', detail: `${this.services.join(', ')} settled` }
    }
    return null
  }

  /** Called once the deadline passes with no verdict. */
  timeout(): Verdict {
    const unsettled = [...this.tracks.entries()].filter(([, t]) => !t.settled)
    const findings: Finding[] = unsettled.map(([service, t]) => ({
      service,
      severity: 'hard' as const,
      code: 'timeout',
      detail:
        t.runningSinceMs === null
          ? `never came up within ${this.cfg.windowS}s`
          : `still not healthy after ${this.cfg.windowS}s`,
    }))
    return {
      kind: 'failed',
      findings,
      detail: findings.map((f) => `${f.service}: ${f.detail}`).join('; '),
    }
  }

  private allFindings(): Finding[] {
    return [...this.tracks.values()].flatMap((t) => t.findings)
  }

  private add(t: Track, f: Finding): void {
    if (!t.findings.some((x) => x.code === f.code)) t.findings.push(f)
  }

  private evaluate(s: Sample, elapsedMs: number): void {
    const t = this.tracks.get(s.obs.service)
    if (!t) return
    const o = s.obs
    const snap = this.snapshot.find((x) => x.service === o.service)

    // --- gone -------------------------------------------------------------------
    if (!o.found) {
      // Compose may not have created it yet; only a persistent absence is a failure.
      if (elapsedMs > 10_000) {
        this.add(t, { service: o.service, severity: 'hard', code: 'absent', detail: 'no container' })
      }
      return
    }

    // --- did the deploy actually change anything --------------------------------
    if (!this.imageChecked && s.expectedImageRef && o.imageRef) {
      this.imageChecked = true
      if (o.imageRef !== s.expectedImageRef) {
        this.add(t, {
          service: o.service,
          severity: 'hard',
          code: 'image-mismatch',
          detail: `running ${o.imageRef}, compose says ${s.expectedImageRef}`,
        })
        return
      }
    }

    // --- crash detection --------------------------------------------------------
    if (t.firstId === null) t.firstId = o.id
    else if (o.id && t.firstId !== o.id) {
      this.add(t, {
        service: o.service,
        severity: 'hard',
        code: 'recreated',
        detail: 'the container was replaced mid-verify',
      })
      return
    }
    if (t.baselineRestarts === null) t.baselineRestarts = o.restartCount
    if (o.restartCount - t.baselineRestarts >= this.cfg.crashRestarts) {
      this.add(t, {
        service: o.service,
        severity: 'hard',
        code: 'crash-loop',
        detail: `restarted ${o.restartCount - t.baselineRestarts} times since deploy`,
      })
      return
    }

    // --- states -----------------------------------------------------------------
    if (o.state === 'restarting') {
      t.restartingStreak++
      if (t.restartingStreak >= 2) {
        this.add(t, { service: o.service, severity: 'hard', code: 'crash-loop', detail: 'restart loop' })
      }
      return
    }
    t.restartingStreak = 0

    if (o.state === 'exited') {
      // A one-shot that finished is a success, not a corpse. The restart policy is what
      // distinguishes them, which is better than the hard-coded service list this
      // repository keeps elsewhere.
      const oneShot = o.restartPolicy === '' || o.restartPolicy === 'no' || o.restartPolicy === 'on-failure'
      if (o.exitCode === 0 && oneShot) {
        t.settled = true
        return
      }
      this.add(t, {
        service: o.service,
        severity: 'hard',
        code: 'exited',
        detail: `exited (${o.exitCode ?? '?'})`,
      })
      return
    }

    if (o.state !== 'running') {
      t.runningSinceMs = null
      return
    }

    // --- probe (soft only) ------------------------------------------------------
    if (s.probe) {
      t.probed++
      if ('status' in s.probe && s.probe.status >= 500) {
        t.probe5xx++
        // Only a sustained pattern counts, and only ever as a warning: a service can
        // answer 500 for reasons that have nothing to do with the version change.
        if (t.probe5xx >= 3) {
          this.add(t, {
            service: o.service,
            severity: 'soft',
            code: 'probe-5xx',
            detail: `answered ${s.probe.status} on ${t.probe5xx} samples`,
          })
        }
      }
    }

    // --- pass conditions --------------------------------------------------------
    if (o.health === 'unhealthy') {
      this.add(t, { service: o.service, severity: 'hard', code: 'unhealthy', detail: 'healthcheck failing' })
      return
    }
    if (o.health === 'starting') {
      t.okStreak = 0
      return
    }
    if (o.health === 'healthy') {
      t.okStreak++
      if (t.okStreak >= this.cfg.consecutiveOk) t.settled = true
      return
    }

    // health === 'none': it has to stay up to count.
    if (snap?.hadHealthcheck) {
      // It had a healthcheck before and does not now: the new image dropped it. Not a
      // failure, but the verification just got weaker and that is worth saying.
      this.add(t, {
        service: o.service,
        severity: 'soft',
        code: 'healthcheck-gone',
        detail: 'the new image declares no healthcheck',
      })
    }
    if (t.runningSinceMs === null) t.runningSinceMs = elapsedMs
    if (elapsedMs - t.runningSinceMs >= this.cfg.minDwellS * 1000) t.settled = true
  }
}

export interface VerifyIo {
  observe(service: string): Promise<ServiceObservation>
  probe(obs: ServiceObservation): Promise<{ status: number } | { error: string } | undefined>
  expectedImageRef(service: string): string | null
  sleep(ms: number): Promise<void>
  now(): number
}

/**
 * Run the machine until it decides or the window closes.
 *
 * I/O is injected so the tests drive the whole table with scripted observations and no
 * docker daemon. The loop itself has no judgement in it at all -- that is the point of
 * keeping `Verifier` pure.
 */
export async function runVerify(
  services: string[],
  snapshot: ServiceSnapshot[],
  cfg: VerifyConfig,
  io: VerifyIo,
): Promise<Verdict> {
  const v = new Verifier(services, snapshot, cfg)
  const started = io.now()
  const deadline = started + cfg.windowS * 1000

  for (;;) {
    const elapsed = io.now() - started
    let samples: Sample[] = []
    try {
      samples = await Promise.all(
        services.map(async (service) => {
          const obs = await io.observe(service)
          const probe = obs.state === 'running' ? await io.probe(obs) : undefined
          return { obs, probe, expectedImageRef: io.expectedImageRef(service) }
        }),
      )
    } catch {
      // Treated as "saw nothing this round"; three of these in a row is an error verdict
      // rather than a failure, because a blind verifier must not condemn a deploy.
      samples = []
    }

    const verdict = v.push(samples, elapsed)
    if (verdict) return verdict
    if (io.now() >= deadline) return v.timeout()
    await io.sleep(cfg.intervalS * 1000)
  }
}
