import type { FC } from 'hono/jsx'
import type { SectionName } from '../../settings.ts'
import { Table } from './layout.tsx'

/**
 * The mental model, told through the settings that implement it.
 *
 * This was its own page (`/about`) until it turned out to be describing the same nine
 * stages the Settings nav already lists, in the same order, with a test enforcing that
 * every one of its deep links named a real pane. Two surfaces stating one model is two
 * surfaces that can disagree, and the one you read was never the one you edited.
 *
 * So the prose moved here and is rendered inside the panes it describes. Read the nav top
 * to bottom with explanations on and you get the path an update takes; read it with them
 * off and you get an ordinary settings form. That is the whole design.
 *
 * ## Two rules for writing in this file
 *
 * 1. **Never restate a field's `about`.** All 32 settings already carry one, surfaced in
 *    the help dot inches away. A popover cannot say how one stage hands off to the next,
 *    and that -- not the individual knobs -- is what belongs here. Duplication that was
 *    tolerable across two pages is obvious noise within one pane.
 * 2. **Never interpolate a live policy value.** `/about` did, because it described a
 *    configuration you could not see from it. Here the control is on screen; printing the
 *    value beside its own input is worse than saying nothing. That is why nothing in this
 *    file takes a `Policy`.
 */

/** The one wrapper everything goes through, so the CSS gate has a single hook. */
export const Explain: FC<{ section: SectionName }> = ({ section }) => {
  const Body = SECTION_EXPLAIN[section]
  return (
    <div class="explain">
      <Body />
    </div>
  )
}

/**
 * Above the panes, not inside one.
 *
 * Panes are `display: none` except the active one, so anything filed under a section is
 * invisible from every other section. The damper rule is needed most on Changelog review
 * and Merging -- the two places you decide how far to trust a model -- and someone
 * arriving on `#merging` from a link would otherwise get no framing at all.
 */
export const ExplainIntro: FC<{ repo: string }> = ({ repo }) => (
  <div class="explain explain-intro">
    <p class="sub">
      shipshape reads the compose files in <code>{repo || 'your repo'}</code>, asks the
      registries what newer image tags exist, and turns each one into a pull request that
      bumps the <code>image:</code> line. A model finds and reads the release notes and
      writes its judgement into that pull request. What policy allows, it merges; what
      merges, it deploys with a real <code>docker compose up -d</code>.{' '}
      <strong>The sections on the left are that sequence, in order</strong> — nothing skips
      a step, and a step can only decide to stop.
    </p>
    <div class="rule">
      <strong>The one rule everything else hangs off.</strong> The model is a
      one-directional damper: its verdict can <em>withhold</em> a merge and can never{' '}
      <em>cause</em> one. Release notes are untrusted text from the internet, so the worst
      a hostile changelog can achieve is a stopped update.
    </div>
  </div>
)

const ScanningExplain: FC = () => (
  <p class="sub">
    Everything starts here: a sweep of the compose files in your repository, asking each
    registry which tags now exist that you are not running. A service is looked at only if
    it carries <code>shipshape.watch</code>, and comparing tags at all means knowing their
    shape — <code>shipshape.pattern</code>, inferred from the pinned tag when absent. The
    files in git are the source, never the running containers, so a label edit lands on the
    next sweep with nothing recreated. A sweep only produces candidates; what may happen to
    each one is the next question.
  </p>
)

const UpdatePolicyExplain: FC = () => (
  <>
    <p class="sub">
      This is the one axis in shipshape — how much may happen without you — answered by
      default from how large the version jump is. A <code>shipshape.policy</code> label on
      a service overrides that answer and always wins. What a rung decides is whether a
      pull request <em>opens</em> on its own; whether one <em>merges</em> on its own is a
      separate gate, three sections down, which a digest move never clears because there is
      no changelog to judge. From here the rung can only be lowered by what follows — the
      one exception that can raise it is in Merging.
    </p>
    <Table>
      <thead>
        <tr>
          <th>Rung</th>
          <th>Reach for it when</th>
        </tr>
      </thead>
      <tbody>
        <Rung name="auto" cls="ok" when="the service is disposable and its upstream is well behaved" />
        <Rung
          name="manual"
          cls="muted"
          when="a bad version would cost you an evening — infrastructure, anything load-bearing"
        />
        <Rung
          name="on-request"
          cls="warn"
          when="applying it is a migration, not a bump — every datastore lives here"
        />
        <Rung
          name="skip"
          cls="muted"
          when="you have deliberately pinned it and do not want to be told again"
        />
      </tbody>
    </Table>
  </>
)

const PullRequestsExplain: FC = () => (
  <p class="sub">
    Every change shipshape makes goes through a pull request — it is the review surface —
    and it opens before anything has been read. A branch off the true tip of{' '}
    <code>main</code>, one commit, nothing in the diff but the image line; services that
    must move together share one pull request (<code>shipshape.group</code>). The body
    links the release notes for the target version, the project, and the image's own
    documentation, so deciding does not start with a search. Push a commit to one of these
    branches and it becomes yours: shipshape comments from then on rather than
    force-pushing over you.
  </p>
)

const ChangelogReviewExplain: FC = () => (
  <p class="sub">
    With the pull request open, a model goes and finds what was actually released and
    writes a verdict into its body: approve, caution, or block. Finding it is most of the
    work — about half of images either carry no source annotation or point at a packaging
    repository, which is what <code>shipshape.source</code> is for. A verdict is produced
    once per image and version pair, then reused everywhere that same bump appears. If the
    model is unreachable the pull request simply stands on the rung it already had, unless
    the service carries <code>shipshape.claude: required</code>, which would rather stall
    than proceed unread.
  </p>
)

const ConfigProposalsExplain: FC = () => (
  <p class="sub">
    Sometimes the tag is not the whole update — the verdict reports a renamed variable or a
    migration step — and a second commit can carry the rest. How far that commit may reach
    is bounded by where the compose file sits, and narrowed further by{' '}
    <code>shipshape.propose</code>. Any pull request carrying more than the image line then
    waits for a person, whoever wrote it: nothing has reviewed those changes. shipshape's
    own policy file sits outside every scope — a limit that can be configured away is not a
    limit.
  </p>
)

const MergingExplain: FC = () => (
  <>
    <p class="sub">
      This is the only place shipshape changes the repository with nobody watching, which
      makes it the narrowest gate in the system: a merge happens here only where every
      stage before it agreed. The one bounded exception is a service labelled{' '}
      <code>shipshape.policy: model</code>, which asks the review to decide whether an
      update is routine rather than deciding it by version magnitude. Promotion needs all
      four of:
    </p>
    <ul class="never">
      <li>the image resolves to a real upstream project;</li>
      <li>
        <em>every URL the verdict cited</em> lives under that repository;
      </li>
      <li>
        the verdict is <code>approve</code> at <code>high</code> confidence;
      </li>
      <li>it reported no breaking changes and no migration steps.</li>
    </ul>
    <p class="sub">
      Every one is a structural fact rather than a reading of the prose, so a release note
      claiming to be routine has no path to this outcome. Any failure falls back to a
      human.
    </p>
  </>
)

const DeploysExplain: FC = () => (
  <>
    <p class="sub">
      A change is not finished when it merges; it is finished when it is running and has
      proved it. The checkout fast-forwards, the stack comes up, and then verification
      watches — three ways, because no single one covers this lab: the container's own
      healthcheck where the image declares one, an HTTP probe on the port the service
      already tells traefik about, and a crash watch that needs neither. A service with
      no healthcheck earns its pass by staying up, not by existing for one sample.
    </p>
    <p class="sub">
      A deploy that passes is looked at once more after the soak, and only then reads{' '}
      <em>verified</em>. One that fails gets exactly one rollback — the previous version,
      restored by reverting the merge and bringing the stack back up, then announced with
      the container's own log lines. There is no second attempt and no setting that adds
      one; a machine that keeps trying to fix itself is worse than one that stops and
      says so. A pull request carrying more than an image line is never reverted without
      you, and neither is anything a verifier could not actually see.
    </p>
    <p class="sub">
      The version that failed is not offered again — only a newer one, or the same one if
      you ask for it deliberately. <code>shipshape.deploy: rm-first</code> recreates
      rather than updating, for images whose old environment would otherwise survive the
      bump. One stack is never brought up this way: shipshape's own.
    </p>
  </>
)

const NotificationsExplain: FC = () => (
  <p class="sub">
    Every stage above produces outcomes, and this is the only place they leave the machine.
    Which kind a thing is — a failure that pushes at once, or a routine outcome that waits
    for the digest — is fixed in the code and is not a setting, which is exactly what makes
    turning the digest on safe. Nothing is lost when it is off either: every routine item
    is on the <a href="/activity">Activity</a> page whether or not it was pushed, and the
    exact text of the next batch is two panes down.
  </p>
)

const GitSyncExplain: FC = () => (
  <>
    <p class="sub">
      Everything above runs across three git locations with strict roles, and keeping them
      in step is what this section is.
    </p>
    <Table kv>
      <tbody>
        <tr>
          <th>the live checkout</th>
          <td>The only place deploys run. Touched solely to fetch, fast-forward and bring services up.</td>
        </tr>
        <tr>
          <th>shipshape's own clone</th>
          <td>All branch, edit, commit and push work happens here.</td>
        </tr>
        <tr>
          <th>GitHub</th>
          <td>Where pull requests live and merge, and where <code>main</code> is published.</td>
        </tr>
      </tbody>
    </Table>
    <p class="sub">
      The part worth knowing: shipshape stands down completely whenever the live checkout
      is off <code>main</code> or has a git operation in progress, so it will never fight
      you for the working tree — and your uncommitted work is irrelevant to it regardless,
      because it does its own committing somewhere else.
    </p>
  </>
)

/**
 * Total by construction: `SectionName` is a literal union of the nine `SECTIONS` names, so
 * adding a tenth section without prose for it fails `tsc --noEmit` rather than rendering a
 * silently empty explanation.
 */
const SECTION_EXPLAIN = {
  Scanning: ScanningExplain,
  'Update policy': UpdatePolicyExplain,
  'Pull requests': PullRequestsExplain,
  'Changelog review': ChangelogReviewExplain,
  'Config proposals': ConfigProposalsExplain,
  Merging: MergingExplain,
  Deploys: DeploysExplain,
  Notifications: NotificationsExplain,
  'Git sync': GitSyncExplain,
} satisfies Record<SectionName, FC>

/**
 * The two things on this page that are not settings, and so are shown whether or not
 * explanations are on.
 *
 * Labels especially: they live in compose files rather than policy.yaml, so no control on
 * this page can ever hold them, and with `/about` gone this is their only documentation in
 * the running app. Hiding them behind the toggle would make it a data switch rather than a
 * prose switch.
 */
export const ReferenceTables: FC = () => (
  <>
    <p class="sub">
      On the service, in its compose file. Only <code>shipshape.watch</code> is required.
    </p>
    <Table>
      <thead>
        <tr>
          <th>Label</th>
          <th>Values</th>
          <th>What it does</th>
        </tr>
      </thead>
      <tbody>
        <Label name="shipshape.watch" values='"true"' what="Opt this service in. Nothing else is watched." />
        <Label
          name="shipshape.pattern"
          values="semver, v-semver, semver-minor, semver-quad, major-only, semver-variant, lsio-ls, date, digest, latest, regex…"
          what="The shape of this image's tags, so a comparison is possible at all. Inferred from the pinned tag when absent."
        />
        <Label
          name="shipshape.tag.include"
          values="a regex"
          what="Narrow the candidates — hold a major, or keep to one flavour. A newer release it suppresses is shown as constrained rather than hidden."
        />
        <Label
          name="shipshape.policy"
          values="auto | manual | on-request | skip | model"
          what="This service's rung, overriding the magnitude defaults. gated is still accepted and means manual."
        />
        <Label
          name="shipshape.pr"
          values="on-request"
          what="The original spelling of the on-request rung. Still honoured; shipshape.policy now expresses the whole ladder in one label."
        />
        <Label
          name="shipshape.source"
          values="a GitHub URL"
          what="Where the release notes actually live, for the ~half of images whose OCI annotation is missing or points at a packaging repo."
        />
        <Label
          name="shipshape.claude"
          values="required"
          what="Fail closed: refuse to auto-merge this service without a verdict, rather than falling back to static policy."
        />
        <Label
          name="shipshape.propose"
          values="none | service | compose-file | compose-dir | repo"
          what="How far a drafted config change may reach, derived from where the compose file sits. Defaults to this service's own block."
        />
        <Label
          name="shipshape.group"
          values="a name"
          what="Force services into one pull request when the shared-upstream heuristic misses them."
        />
        <Label
          name="shipshape.deploy"
          values="rm-first"
          what="Remove and recreate rather than update, so environment baked into the old image cannot survive the bump."
        />
      </tbody>
    </Table>

    <p class="sub">
      And the four layers configuration arrives on. Policy is stated once, centrally; data
      is stated where it belongs.
    </p>
    <Table>
      <thead>
        <tr>
          <th>Layer</th>
          <th>Holds</th>
          <th>Takes effect</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="mono nowrap">environment</td>
          <td>
            Which repository, where it is on disk, and the credentials. Things that
            identify this deployment.
          </td>
          <td class="sub">on restart</td>
        </tr>
        <tr>
          <td class="mono nowrap">policy.yaml</td>
          <td>
            Every semantic decision, declared once — this page. Saving writes the file in
            place and commits it, so a change here shows up in <code>git log</code> like
            any other.
          </td>
          <td class="sub">immediately</td>
        </tr>
        <tr>
          <td class="mono nowrap">shipshape.* labels</td>
          <td>
            Per-service data and exceptions, so they travel with the thing they describe.
            Read from the compose <em>files</em>, never from running containers.
          </td>
          <td class="sub">next scan — nothing recreated</td>
        </tr>
        <tr>
          <td class="mono nowrap">prompts</td>
          <td>
            What the models are actually told. Stored separately so upgrades keep shipping
            new defaults you can return to.
          </td>
          <td class="sub">next call</td>
        </tr>
      </tbody>
    </Table>
  </>
)

const Rung: FC<{ name: string; cls: string; when: string }> = ({ name, cls, when }) => (
  <tr>
    <td class="nowrap">
      <span class={`pill ${cls}`}>{name}</span>
    </td>
    <td class="sub">{when}</td>
  </tr>
)

const Label: FC<{ name: string; values: string; what: string }> = ({ name, values, what }) => (
  <tr>
    <td class="mono nowrap">{name}</td>
    <td class="mono sub">{values}</td>
    <td>{what}</td>
  </tr>
)
