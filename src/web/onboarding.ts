import { relative } from './views/ui/parts.tsx'
import { DOCS_URL } from '../links.ts'

/**
 * The getting-started checklist, as data: what a new install still needs, in order.
 *
 * Pure (no database, no env reads), so every state is testable with a literal. It lives
 * in the Inbox list and rides its poll, so a step ticks itself off as it happens.
 */

export type SetupStepKey = 'repo' | 'watch' | 'scan' | 'review' | 'pause'

export interface SetupStep {
  key: SetupStepKey
  done: boolean
  optional: boolean
  title: string
  body: string
  /** A link, or a button that posts with htmx. */
  action?: { kind: 'link'; href: string; label: string } | { kind: 'scan'; label: string }
}

export interface SetupInput {
  /** configured().missing; [] when ok. */
  missing: { name: string; why: string }[]
  repoDir: string
  composeFiles: number | null
  services: number
  stacks: number
  watched: number
  lastScanAt: string | null
  /** In words: "every day at 03:00", or the cron itself. */
  schedule: string
  reviewOff: string | null
  reader: string
  paused: boolean
  /** How many updates nothing holds but Pause. */
  wouldShip: number
}

export interface SetupState {
  complete: boolean
  done: number
  required: number
  steps: SetupStep[]
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function setupSteps(i: SetupInput): SetupState {
  const schedule = i.schedule ? i.schedule[0]!.toLowerCase() + i.schedule.slice(1) : i.schedule
  const steps: SetupStep[] = []

  const repoDone = i.missing.length === 0 && i.services > 0
  steps.push({
    key: 'repo',
    done: repoDone,
    optional: false,
    title: 'Connect your compose repository',
    ...(repoDone
      ? { body: `${plural(i.services, 'service', 'services')} in ${plural(i.stacks, 'stack', 'stacks')}, from ${i.repoDir}.` }
      : i.missing.length > 0
        ? {
            body: `Set ${i.missing.map((m) => m.name).join('; ')} on the shipshape container and restart it.`,
            action: { kind: 'link' as const, href: DOCS_URL, label: 'Setup guide' },
          }
        : i.composeFiles === 0
          ? {
              body: `No compose files were found in ${i.repoDir}. shipshape reads compose.yaml, compose.yml, docker-compose.yml or docker-compose.yaml at the top of the checkout and one directory down.`,
            }
          : { body: `The first scan reads the compose files in ${i.repoDir}.` }),
  })

  steps.push({
    key: 'watch',
    done: i.watched > 0,
    optional: false,
    title: 'Choose what to watch',
    ...(i.watched > 0
      ? { body: `${i.watched} of ${plural(i.services, 'service is', 'services are')} watched.` }
      : i.services === 0
        ? { body: 'Once the compose files are read, pick the services shipshape should keep up to date.' }
        : {
            body: `shipshape only looks at services labelled shipshape.watch: "true". None of the ${plural(i.services, 'service is', 'services are')} watched yet. Watching one writes that label into its compose file as a commit.`,
            action: { kind: 'link' as const, href: '/services?filter=unwatched', label: 'Choose services' },
          }),
  })

  steps.push({
    key: 'scan',
    done: i.lastScanAt !== null,
    optional: false,
    title: 'Run the first scan',
    ...(i.lastScanAt !== null
      ? { body: `Last scan ${relative(i.lastScanAt)}. Scans run ${schedule}.` }
      : {
          body: `A scan asks each registry which newer tags exist. Scans run ${schedule}; start one now to see what is out of date.`,
          action: { kind: 'scan' as const, label: 'Scan now' },
        }),
  })

  steps.push({
    key: 'review',
    done: i.reviewOff === null,
    optional: true,
    title: 'Changelog reviews',
    ...(i.reviewOff === null
      ? { body: `On: ${i.reader} reads the release notes where a person will read what it writes.` }
      : {
          body: `Off: ${i.reviewOff}. Updates still ship on the evidence that is left, but nothing reads their release notes.`,
          action: { kind: 'link' as const, href: '/status', label: 'What it needs' },
        }),
  })

  steps.push({
    key: 'pause',
    done: !i.paused,
    optional: true,
    title: 'Pause',
    ...(!i.paused
      ? { body: 'Off: what nothing holds ships on its own.' }
      : {
          body:
            'On: nothing ships on its own.' +
            (i.wouldShip > 0 ? ` ${i.wouldShip} ${i.wouldShip === 1 ? 'update is' : 'updates are'} waiting only on Pause.` : ''),
          action: { kind: 'link' as const, href: '/settings#pause', label: 'Review and unpause' },
        }),
  })

  const required = steps.filter((s) => !s.optional)
  const done = required.filter((s) => s.done).length
  return { complete: done === required.length, done, required: required.length, steps }
}
