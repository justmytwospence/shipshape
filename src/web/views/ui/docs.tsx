import type { FC } from 'hono/jsx'
import { slug } from './settings.tsx'

/**
 * How the thing works, as a document.
 *
 * This prose used to be interleaved with the settings form behind an "Explain" switch,
 * which made the form either an essay or a grid of unexplained enums depending on a
 * toggle nobody remembered the state of. It is one thing to read once and refer back to,
 * so it is one page, and each settings section links to its part.
 */

interface Chapter {
  title: string
  paras: string[]
  rule?: string
}

const CHAPTERS: Chapter[] = [
  {
    title: 'The one rule',
    paras: [
      'shipshape reads the compose files in your repository, asks the registries which newer image tags exist, and turns each one into a pull request that bumps the image line. A model finds and reads the release notes and writes its judgement into that pull request. What policy allows, it merges; what merges, it brings up with a real `docker compose up -d`, watches, and puts back if it fails.',
    ],
    rule: 'The changelog review is a one-directional damper: its verdict can withhold a merge and can never cause one. Release notes are untrusted text from the internet, so the worst a hostile changelog can achieve is a stopped update.',
  },
  {
    title: 'Scanning',
    paras: [
      'Everything starts with a sweep of the compose files, asking each registry which tags exist that you are not running. Only services carrying `shipshape.watch` are asked about, and comparing tags at all means knowing their shape — `shipshape.pattern`, inferred from the pinned tag when absent.',
      'The files in git are the source, never the running containers. A label edit therefore lands on the next scan with nothing recreated, and a container whose labels were baked months ago cannot disagree with the file that describes it.',
    ],
  },
  {
    title: 'Update policy',
    paras: [
      'One axis — how much happens without you — answered by default from how large the version jump is, and overridden per service by a `shipshape.policy` label. `auto` means a pull request opens and shipshape merges it; `manual` means it opens and you merge it; `on-request` means nothing opens until you ask; `skip` means it is not tracked.',
      'Majors and digest moves always wait for a person, whatever the defaults say. That is not configurable, and a label nobody recognises narrows to `manual` rather than widening — a typo must never grant reach.',
    ],
  },
  {
    title: 'Pull requests',
    paras: [
      'Every change goes through one, because it is the review surface. A branch off main, one commit, nothing in the diff but the image line; services that must move together share one pull request. The body links the release notes for the target version, the project, and the image documentation, so deciding does not start with a search.',
      'Push to one of those branches and shipshape stops force-pushing it: it is yours now, and it comments instead of regenerating.',
    ],
  },
  {
    title: 'Changelog review',
    paras: [
      'A model looks for the upstream changelog — through the image OCI annotations, a curated override list, or a search — reads it, and returns a recommendation with a confidence, the breaking changes it found, and any migration steps. Everything it cites is recorded.',
      'It costs what it reads, which is why there is a monthly budget. Reaching the budget pauses reviews and drafting; it never stops a pull request opening, because an unreviewed update you can see beats an invisible one.',
    ],
  },
  {
    title: 'Config proposals',
    paras: [
      'Sometimes an update needs more than its tag: a renamed environment variable, a moved volume. A stronger model can draft the rest of the change onto the same pull request, within a boundary set by `shipshape.propose`.',
      'A pull request carrying drafted changes can never merge automatically, whatever the rung says.',
    ],
  },
  {
    title: 'Merging',
    paras: [
      'Merging is where the repository changes. While shipshape is paused, only you do it. Unpaused, it will merge what static policy allows — tag-only pull requests on the auto rung, at patch or minor, with no verdict withholding them — and nothing else.',
    ],
  },
  {
    title: 'Deploys',
    paras: [
      'A merge leads to a deploy, because the version in git and the version running are the same claim. The checkout is fast-forwarded and the stack is brought up with a real `docker compose up -d`, which re-reads the whole file — labels, environment, networks — rather than cloning a running container and swapping its image.',
      'Then it is verified: the container healthcheck where one exists, an HTTP probe where a port is already declared to traefik, and a crash watch that needs neither. Passing that window is not the same as being fine, so a deploy soaks for half an hour before it reads verified.',
      'A hard failure inside the window is rolled back automatically, once: a revert commit on main, deployed immediately, then announced with the service own log lines. After the soak nothing is rolled back automatically — by then a database may have migrated, and undoing that is a person decision.',
    ],
  },
  {
    title: 'Notifications',
    paras: [
      'Two kinds of message, and which is which is not configurable. Alerts — a deploy failed, a service came up unhealthy, sync is stuck — always send immediately. Routine outcomes — opened, merged, deployed, drafted, held — batch into one digest per schedule.',
      'So turning digests on can delay a success and can never hide a failure. Each channel then says what it wants, which is why the useful split is one line each: the phone buzzes for what broke, the mail carries the morning summary.',
    ],
  },
  {
    title: 'Git sync',
    paras: [
      'shipshape publishes main as part of its loop. A pull request branch has to be based on the true tip of main, or merging it silently reverts whatever unpushed local commits touched the same file. There is no safe alternative base, which is why turning publishing off also turns pull requests off.',
      'It never fights you for the working tree: while the checkout is on another branch or a git operation is in progress, the sync loop stands down.',
    ],
  },
]

export const Docs: FC = () => (
  <>
    <p class="lead">
      The sections below are the order an update actually moves through. Nothing skips a
      step, and a step can only ever decide to stop.
    </p>
    {CHAPTERS.map((ch) => (
      <section id={slug(ch.title)}>
        <h2>{ch.title}</h2>
        {ch.paras.map((p) => (
          <p>{p}</p>
        ))}
        {ch.rule ? (
          <blockquote>
            <strong>The one rule everything else hangs off.</strong> {ch.rule}
          </blockquote>
        ) : null}
      </section>
    ))}
  </>
)

/** The settings sections that have a chapter here, so a link can be trusted to land. */
export const DOC_ANCHORS = new Set(CHAPTERS.map((c) => slug(c.title)))
