import type { SectionName } from '../settings.ts'

/**
 * Why each setting exists, next to the setting.
 *
 * This prose has moved twice: it was interleaved with the form behind an "Explain"
 * switch, which made the page either an essay or a grid of unexplained enums depending
 * on a toggle nobody remembered the state of; then it was a separate document, which
 * meant answering "what does this do" cost a page load and a scroll back. It lives here
 * now, in the section it explains, short enough to read every time.
 *
 * The rule for length: one paragraph on what this stage does, and one on the thing that
 * is surprising or load-bearing about it. Anything longer belongs in a service's own
 * `about`, which sits under the control it concerns.
 */
export const SECTION_PROSE: Record<SectionName, string[]> = {
  Scanning: [
    'Everything starts with a sweep of the compose files, asking each registry which tags exist that you are not running. Only services carrying `shipshape.watch` are asked about, and comparing tags at all means knowing their shape, which is inferred from the pinned tag unless a label says otherwise.',
    'The files in git are the source, never the running containers. A label edit lands on the next scan with nothing recreated, and a container whose labels were baked months ago cannot disagree with the file that describes it.',
  ],
  'Update policy': [
    'One axis — how much happens without you — answered by default from how large the version jump is, and overridden for one service by a `shipshape.policy` label. `auto` opens a pull request and merges it; `manual` opens one and leaves it to you; `on-request` opens nothing until you ask; `skip` stops tracking it.',
    'Majors and digest moves always wait for a person, whatever these say, and a label nobody recognises narrows to `manual` rather than widening. A typo must never grant reach.',
  ],
  'Pull requests': [
    'Every change goes through one, because it is the review surface. A branch off main, one commit, nothing in the diff but the image line; services that must move together share a pull request. The body links the release notes for the target version, so deciding does not start with a search.',
    'Push to one of those branches and shipshape stops force-pushing it. It is yours from then on, and it comments rather than regenerating.',
  ],
  'Changelog review': [
    'A model looks for the upstream changelog — through the image OCI annotations, a curated override list, or a search — reads it, and returns a recommendation with a confidence, the breaking changes it found, and any migration steps. Everything it cites is recorded.',
    'Its verdict can withhold a merge and can never cause one. Release notes are untrusted text from the internet, so the worst a hostile changelog can achieve is a stopped update. Reaching the monthly budget pauses reviews and drafting; it never stops a pull request opening, because an unreviewed update you can see beats an invisible one.',
  ],
  'Config proposals': [
    'Sometimes an update needs more than its tag: a renamed environment variable, a moved volume. A stronger model can draft the rest of the change onto the same pull request, within the boundary a service sets with `shipshape.propose`.',
    'A pull request carrying drafted changes can never merge automatically, whatever the rung says.',
  ],
  Merging: [
    'Merging is where the repository changes, and where a change starts becoming a running one: a merge leads to a deploy, because the version in git and the version on the host are meant to be the same claim.',
    'Paused, only you merge, and a merge you press still deploys — you are there to watch it. Unpaused, shipshape will merge what static policy allows: tag-only pull requests on the auto rung, at patch or minor, with no verdict withholding them, and nothing else.',
  ],
  Deploys: [
    'The checkout is fast-forwarded and the stack is brought up with a real `docker compose up -d`, which re-reads the whole file — labels, environment, networks — rather than cloning a running container and swapping its image. That difference is why this tool exists.',
    'Then it is verified: the container healthcheck where one exists, an HTTP probe where a port is already declared to traefik, and a crash watch that needs neither. Passing that window is not the same as being fine, so a deploy soaks before it reads verified. A hard failure inside the window is rolled back automatically, once; after the soak nothing is, because by then a database may have migrated and undoing that is your decision.',
  ],
  Notifications: [
    'Two kinds of message, and which is which is not configurable. Alerts — a deploy failed, a service came up unhealthy, sync is stuck — always send immediately. Routine outcomes — opened, merged, deployed, drafted, held — batch into one digest.',
    'So turning digests on can delay a success and can never hide a failure. Each channel then says what it wants, which is why the useful split is usually one line each: the phone buzzes for what broke, the mail carries the morning summary.',
  ],
  'Git sync': [
    'shipshape publishes main as part of its loop. A pull request branch has to be based on the true tip of main, or merging it silently reverts whatever unpushed local commits touched the same file. There is no safe alternative base, which is why turning publishing off also turns pull requests off.',
    'It never fights you for the working tree: while the checkout is on another branch, or a git operation is in progress, the sync loop stands down.',
  ],
}
