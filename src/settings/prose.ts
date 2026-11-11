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
 *
 * Deploys breaks that rule with a third paragraph, on purpose. That a deploy leaves a
 * stopped service stopped is a rule about every setting in the section rather than one
 * control's detail, so no `about` is the right home for it; and there is no `/docs` page
 * to hold it instead, so this is the only place in the app that explains why an update
 * reads Left stopped and what `docker start` would do to it.
 */
export const SECTION_PROSE: Record<SectionName, string[]> = {
  Pause: [
    'While this is on, shipshape ships and deploys nothing on its own. It still scans and reads changelogs; what waits is every step that would change this host with nobody watching.',
    'A ship you press still deploys, because you are there to watch it. That is the whole distinction: not a switch between safe and unsafe, but one between the machine choosing the moment and you choosing it.',
  ],
  Scanning: [
    'Everything starts with a sweep of the compose files, asking each registry which tags exist that you are not running. Only services carrying `shipshape.watch` are asked about, and comparing tags at all means knowing their shape, which is inferred from the pinned tag unless a label says otherwise.',
    'The files in git are the source, never the running containers. A label edit lands on the next scan with nothing recreated, and a container whose labels were baked months ago cannot disagree with the file that describes it.',
  ],
  Shipping: [
    'An update ships on its own unless a hold says a person is needed. The holds are few and concrete: the service always asks (`shipshape.class: ask` or `lifeline`), the review found something to do or something unsafe, there is no release note behind a major jump or a stateful service, or a one-way migration has no restore point to fall back on. Nothing here predicts how risky a version looks; the verify window, the soak and the automatic rollback carry the rest.',
    'Shipping is a merge commit on main, built on a branch in shipshape\'s own clone and never pushed, so `git log` keeps the shape of the change and `git revert -m 1` undoes it. A decision that needs you is one card per image and target, with four answers: ship it, snooze a week, always ship (which writes a rule), or skip the version.',
  ],
  'Changelog review': [
    'Two stages. The screen -- Jev, a fraction of a cent a look -- reads the release notes shipshape already fetched and answers narrow questions: does a setting change, is there a manual step, does it touch anything this service uses. It picks the lines worth reading rather than writing a summary. The reader -- Opus -- reads the changelog properly, and only where a person will read what it writes.',
    'Either can hold an update for you and neither can cause one to ship. Release notes are untrusted text from the internet, so the worst a hostile changelog can achieve is a stopped update. Reaching the monthly budget pauses the reader and drafting; updates keep shipping on the evidence that is left, because an unreviewed update you can see beats an invisible one.',
  ],
  'Config proposals': [
    'Sometimes an update needs more than its tag: a renamed environment variable, a moved volume. A stronger model can draft the rest of the change onto the same local branch, within the boundary a service sets with `shipshape.propose`.',
    'A change carrying drafted edits never ships on its own: you read it on the card and ship it.',
  ],
  'Restore points': [
    'Before a stateful service is updated, shipshape runs the service\'s own `shipshape.snapshot` command inside its container (`pg_dump -U app app`) and keeps the gzipped output. An offsite copy can be requested through any MCP tool; it never blocks a ship.',
    'Restoring is deliberately manual. Putting data back blindly loses whatever was written after the dump, so a card that mentions a restore point names the file and leaves the decision to you.',
  ],
  Deploys: [
    'The checkout is fast-forwarded and the stack is brought up with a real `docker compose up -d`, which re-reads the whole file — labels, environment, networks — rather than cloning a running container and swapping its image. That difference is why this tool exists.',
    'Then it is verified: the container healthcheck where one exists, an HTTP probe where a port is already declared to traefik, and a crash watch that needs neither. Passing that window is not the same as being fine, so a deploy soaks before it reads verified. A hard failure inside the window is rolled back automatically, once; after the soak nothing is, because by then a database may have migrated and undoing that is your decision.',
    'A deploy never changes whether a service is running. One that is running is brought up on the new version and verified; one that is stopped, paused or removed is left exactly as it was and reads Left stopped — the compose file carries the new version, so compose brings it up on it, while docker start on the old container would resume the old one. If shipshape cannot ask Docker, the deploy fails and touches nothing.',
  ],
  Notifications: [
    'Shipshape emits messages and `notify.sinks` says where they go: a webhook (the homelab router, which keeps one live card per condition and is what Hermes replies to), email or ntfy. Each sink can list which events it wants: decision, broken, security, system.',
    'Silence means healthy. Nothing is announced on success; a condition that clears is a resolve, which only the webhook acts on. A decision still waiting after the escalation delay is announced once more, louder.',
  ],
  Rules: [
    'Every card exists because of one specific reason it was held, so a rule waives the reason, not the service. Pressing Always ship infers the narrowest scope that explains the card (one image across many stacks, or one service) and writes it here as a commit.',
    'A rule can never waive a lifeline service, an unsafe review or a list of work to do. Edit or delete a rule in policy.yaml like anything else; the commit is the record.',
  ],
  'Git sync': [
    'shipshape publishes main as part of its loop. A branch has to be based on the true tip of main, or merging it silently reverts whatever unpushed local commits touched the same file. There is no safe alternative base, which is why turning publishing off also stops shipping.',
    'It never fights you for the working tree: while the checkout is on another branch, or a git operation is in progress, the sync loop stands down.',
  ],
}
