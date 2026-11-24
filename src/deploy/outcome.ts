import type { DeployTrigger } from './queue.ts'
import { countsAsRunning } from './runstate.ts'
import type { DeployTarget, DeployOutcome } from './types.ts'
import { manualCommand } from './compose-cmd.ts'

/**
 * Whether a failed `up` left a service it meant to bring up not running.
 *
 * Docker's answer, read after the failure, and not the strategy's. Compose v2 recreates by
 * creating the new container, stopping and removing the old one, and only then starting the
 * new -- so a plain `up` that fails at start (a missing binary, a port already allocated, a
 * bind source that is not there) has already destroyed what was running. Probed on this
 * host, docker 26.1.4 and compose 2.27.1: "Recreated", then "OCI runtime create failed",
 * exit 1, and the one container left was `created`. The alert said "running whatever it
 * was" at priority 4.
 *
 * rm-first is DOWN unless docker says every service is running, because its removal
 * certainly ran; for a plain `up`, a read that could not be made proves nothing either way.
 */
export function downAfter(outcome: Extract<DeployOutcome, { ok: false }>, strategy: DeployTarget['strategy']): boolean {
  if (outcome.phase !== 'up') return false
  const after = outcome.after ?? []
  if (after.some((a) => a.state !== 'unknown' && !countsAsRunning(a.state))) return true
  return strategy === 'rm-first' && !(after.length > 0 && after.every((a) => countsAsRunning(a.state)))
}


/**
 * What a failed deploy left behind, in the operator's terms.
 *
 * A failed `up` is described from `downAfter`: DOWN when docker says so, a warning when it
 * could not say, and "running whatever it was" only when every service still is -- compose
 * failed before recreating anything. `inspect` never got as far as anything, whatever the
 * strategy -- the read comes before the removal -- and `pull` stopped before the removal too.
 */
export function failureState(outcome: Extract<DeployOutcome, { ok: false }>, strategy: DeployTarget['strategy']): string {
  if (outcome.phase === 'inspect') return 'Nothing was touched: shipshape does not guess whether a service is running.'
  if (outcome.phase === 'pull') return 'Nothing was removed or recreated; the service is running whatever it was.'
  if (outcome.phase === 'build') return 'The build failed before anything was removed or recreated; the service is running whatever it was.'
  if (outcome.phase === 'up') {
    if (downAfter(outcome, strategy)) {
      return strategy === 'rm-first'
        ? 'The old container was removed and the new one did not start — the service is DOWN.'
        : 'The old container was replaced and the new one did not start — the service is DOWN.'
    }
    if (outcome.after?.some((a) => a.state === 'unknown')) {
      return 'Compose may have replaced the old container before it failed — check whether the service is running.'
    }
  }
  if (outcome.phase === 'rm') {
    return 'The old container may be partly stopped; nothing was recreated.'
  }
  if (outcome.phase === 'refused') return 'Nothing was attempted.'
  return 'The change is in the checkout; the service is running whatever it was.'
}


/**
 * What the operator does about a failed deploy, as the last paragraph of its alert.
 *
 * Usually the command to run by hand, built for `target` -- which the caller has already
 * narrowed to what the deploy meant to bring up. Not when the deploy stopped in `inspect`:
 * running compose by hand while docker cannot say what is there is the very guess the
 * deploy declined to make, so what fixes it is docker answering. And not for an orphan
 * either, where docker did answer: pressing Try again finds the same container every time
 * until someone removes it or brings it up from the project that owns it.
 *
 * The button it names is the one the update will actually offer. A merge that did not land
 * goes back to merged and offers Try again; a Redeploy goes back to a moved rolling tag,
 * which offers Redeploy and nothing called Try again.
 */
export function nextStep(
  outcome: Extract<DeployOutcome, { ok: false }>,
  target: DeployTarget,
  trigger?: DeployTrigger,
): string {
  const again = trigger === 'redeploy' ? 'Redeploy' : 'Try again'
  if (outcome.phase === 'inspect' && outcome.cause === 'orphan') {
    const rm = outcome.container ? ` (docker rm -f ${outcome.container})` : ''
    return `Remove that container${rm} or bring it up from its own compose project, then press ${again} on the update.`
  }
  if (outcome.phase === 'inspect') return `Press ${again} on the update once docker answers.`
  return `Retry with:\n${manualCommand(target)}`
}
