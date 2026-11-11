# shipshape

A Docker image update bot for a single-host Docker Compose homelab.

It polls registries for new image tags, asks **Claude** to find and read the upstream
changelog, **ships** what nothing holds back -- a merge commit on `main` -- and deploys it
on the host with a true `docker compose up -d`, then verifies it, soaks it, and rolls it
back if it broke. What does need you arrives as **one card per decision** with four
answers: ship, snooze, always ship, skip.

Think Renovate, but scoped to one operator's compose repo, and with the part Renovate
structurally cannot do: an LLM that goes and finds the changelog when the image doesn't
tell you where it lives.

## Why it exists

The usual homelab updater (WUD, Diun, Watchtower) either just notifies you, or rewrites
the compose file and restarts the container behind your back. Renovate opens proper PRs
but has two problems here:

1. **No changelog for most homelab images.** Renovate finds release notes by reading the
   `org.opencontainers.image.source` OCI annotation. Measured across 37 images from the
   repo this was built against: only ~49% carry an annotation pointing at the real
   upstream project. ~27% point at a *packaging* repo (`traefik` →
   `traefik-library-image`, every linuxserver image → `linuxserver/docker-<app>`), which
   is technically correct and useless. ~24% carry nothing at all. Renovate has no
   override for this and simply renders an empty changelog section.
2. **No extension point for an LLM.** Renovate has no hook that can write to a PR body,
   so any AI summary has to be a separate bot commenting afterwards. (shipshape has no
   pull requests at all now: the review is in the merge commit and on the update's page.)

shipshape finds the source repository by asking, most certain first: a short curated map
for Docker Official Images; LinuxServer's API and, where that names a website, the
repository their build file reads releases from; the image's own OCI annotation; its
ghcr.io path; a GitHub link on its Docker Hub, Quay or GitLab page; a source label in its
config, unless it was inherited from a base image; and a GitHub repository with the
image's own owner and name. Every inferred repository is checked against GitHub, and a
packaging repository is never the answer. One authoritative signal, or two agreeing, make
it certain; anything else is only likely. A found repository is kept, a lookup that failed
is retried with backoff rather than remembered as "nothing", and a clean "nothing found"
is looked at again after a week. The scan looks up every watched image this way, without
spending Docker Hub pulls. What no signal reaches, `shipshape.source` and
`shipshape.changelog` say — and the service's page writes them, after previewing what the
link leads to.

It also fixes a subtler thing. WUD's compose trigger recreates a container by cloning the
*running* container's config and swapping only the image, so it never re-reads the
compose file. Label and image-env changes silently never apply. shipshape deploys with a
real `docker compose up -d`, and reads its own configuration from the compose files in
git rather than from live container labels, so that failure class cannot occur.

## Web authentication

All web routes except `GET /health` require `SHIPSHAPE_TRUSTED_PROXY` (one exact
IP address) and `SHIPSHAPE_ALLOWED_USER` (the exact authenticated username).
The Node socket peer must match the proxy IP and its `Remote-User` header must
match the user. `X-Forwarded-For` is never an authentication source. Missing
configuration returns 503; missing/forged identity or a different peer returns 403.
There is no development/test bypass.

Set `SHIPSHAPE_ALLOWED_ORIGIN=https://shipshape.${DOMAIN}` to the UI's exact browser
origin, with `${DOMAIN}` expanded by your deployment (the app does not expand it).
It must be one canonical HTTP(S) origin: scheme, hostname, and optional non-default
port only. No trailing slash, path, credentials, query, fragment, wildcard, list,
or surrounding whitespace. HTTPS is the production setting; HTTP origins are also
accepted when explicitly configured. Configuration is captured at app creation;
restart the app after changing these variables.

Every unsafe request (`POST`, `PUT`, `PATCH`, `DELETE`, and any method other than
`GET`/`HEAD`/`OPTIONS`) and every WebSocket upgrade attempt must carry an `Origin`
header exactly equal to `SHIPSHAPE_ALLOWED_ORIGIN`, **in addition to** the trusted
socket peer and exact username. Missing/invalid Origin configuration returns 503
for these requests; a missing, `null`, malformed, multiple, or foreign request
Origin returns 403. Denials are `Cache-Control: no-store` and run before handlers.
The check applies to all content types, including browser forms and HTMX requests;
neither `HX-Request` nor `Sec-Fetch-Site` bypasses it. The proxy must preserve the
browser's `Origin`, not synthesize or overwrite it. `Host`, the request URL,
`Referer`, `Forwarded`, and `X-Forwarded-*` never determine the allowed Origin.

Safe `GET`/`HEAD`/`OPTIONS` requests without a WebSocket upgrade do not require
Origin configuration or a request Origin, but keep the same authentication rules.
Only exact `GET /health` (query strings allowed, no upgrade) remains anonymous;
`HEAD /health` is still authenticated. There are currently no WebSocket routes.

Put the app on a dedicated proxy network, not a shared application network, and
have the trusted proxy authenticate every routed request before setting identity
headers. A holder of the Docker socket is already a host operator and can bypass
network isolation; this does not sandbox that authority.

## How it works

```
registry poll ──▶ new tag ──▶ resolve source repo ──▶ fetch changelog ──▶ Claude verdict
                                                                              │
                              ┌───────────────────────────────────────────────┘
                              ▼
                  holds? ── none ──▶ cooldown ──▶ restore point? ──▶ merge commit on main
                    │                                                     │
                    └─ some ──▶ one card: ship · snooze · always ship · skip
                                                                          │
                              sync into the live checkout ◀───────────────┘
                                          │
                                          ▼
                       docker compose up -d ──▶ verify ──▶ soak ──▶ verified
                                                    └─ failed ──▶ revert -m 1, redeploy, tell you
```

An update ships on its own unless a **hold** says a person is needed. There are only a few,
and each is concrete (see [The policy model](#the-policy-model)). Nothing predicts how
risky a version looks; verifying, soaking and rolling back carry that.

**Shipping is a merge commit.** Shipshape builds a branch in its own work clone, merges it
into `main` with `git merge --no-ff`, and pushes `main`. The branch is never pushed and
there is no pull request, so `git log --graph` keeps the shape of each change, the merge
commit's message carries the review (what moved, what the reader said, which rule waived
a hold), and `git revert -m 1` undoes it. The one thing that still travels as a branch is
a drafted config change, because it is a diff you should read before shipping.

A service that is not running when its update lands is not started: the change stands and
the update reads Left stopped. Compose brings it up on the new version the next time it
runs; `docker start` on the old container would resume the old one.

Three git locations, with strict roles:

| Location | Role |
|---|---|
| the live checkout | the **only** place deploys run; touched solely to fetch, fast-forward, and `compose up` |
| the tool's own clone (`/data/repo`) | all branch, edit, merge and push work — immune to your uncommitted WIP |
| GitHub | where `main` is published; nothing else lives there |

### One decision, four answers

A decision is a stack: everything in it that is waiting on you, answered with one tap and
shipped as one merge commit and one deploy. The card lists each update with what holds it:

> **payments: 3 updates**
> Ship these together? One merge commit, one deploy of payments.
> - btcpayserver 2.1.0 → 2.2.0: this service always asks
> - nbxplorer 2.5.26 → 2.5.30: this service always asks
> - payments-db 17 → 18: Unsafe: a major PostgreSQL upgrade needs a dump and restore
> 🚀 ship · 💤 snooze 1w · ⏭️ skip

The exception is one bump fanned out across stacks that have nothing else waiting: nineteen
sidecars on one agentgateway release are one card keyed by the image, not nineteen.

> **agentgateway v1.6.0 → v1.7.0 · 19 services**
> Ship? this service always asks
> Session ids are now encrypted; clients reconnect once.
> 🚀 ship · 💤 snooze 1w · ♾️ always ship · ⏭️ skip

Once answered (or superseded, or no longer waiting) a card is removed from the room rather
than left as a resolved line: the record of what was decided is git and the Activity page.
A sink that cannot remove a message resolves it instead.

- **Ship** merges it now, whatever is holding it, the cooldown and pause included.
- **Snooze** puts it off a week; the card comes back with its escalation clock restarted.
- **Skip** dismisses that version for good (and the drafted change that carried it).
- **Always ship** does what ship does, and also writes a **rule** to `policy.yaml` as a
  commit: the narrowest scope that explains the card (one image across many stacks, or one
  service), waiving only the reasons that were on it. A model picks the scope when it can; a
  deterministic default stands in when it cannot. It is never offered for a hold no rule may
  waive, so there is nothing quiet to regret: a lifeline service, an unsafe verdict and a list
  of work to do always ask.

The same four verbs are on the update page, in the MCP (`update_action`), and behind signed
links in email and ntfy messages. A decision waiting a week is announced once more, louder.

## Configuration

Two layers, deliberately.

**Per-service data** lives as labels on the service itself, so it travels with the thing
it describes — and is read from the compose files rather than from running containers,
so editing one takes effect on the next scan with nothing recreated.

**Policy semantics** live once, centrally, in `policy.yaml`, never restated per service.
That separation matters more than it looks: the repository this was built against had
previously copy-pasted a six-clause trigger string onto 94 services, and a deliberate
carve-out got silently reverted in a refactor because nobody could see the policy in one
place.

Both are covered with examples under [Running it yourself](#running-it-yourself), and
the policy file is editable from the Settings page — which writes it in place, keeping
your comments, and commits the change. Write out every key you care about even where it
equals the default: the file is meant to be the one place these semantics are declared,
and a key it omits is one nobody reading it knows exists.

## The policy model

One sentence: **an update ships on its own unless a hold says a person is needed.** The
model has three parts -- a class per service, the holds, and the rules that waive some of
them.

### Classes

A service has a class, set rarely, with `shipshape.class`:

| Class | What it means |
|---|---|
| `normal` (the default) | Ships on its own once the review finds nothing to do and the release has aged. |
| `stateful` | Ships on its own **after a restore point**; a one-way migration, or a jump with no release notes behind it, asks. Databases and the services that own data. |
| `ask` | Always asks. Crypto nodes, docker-socket proxies, anything you want to look at. |
| `lifeline` | Always asks, and **no rule can waive it**: the way back in (traefik, authelia, wireguard, pihole). |
| `frozen` | Tracked; nothing happens until you ask. A disabled stack is frozen automatically. |
| `skip` | Not tracked at all (`shipshape.policy: skip`). |

The v1 labels still work: `shipshape.policy: auto|manual|attended|on-request` and
`shipshape.pr: on-request` map onto these, and a `shipshape.class` beside them wins.
Anything unrecognised narrows to `ask`, so a typo never grants reach. The Services page
writes the class and removes the v1 labels in the same commit.

### Holds

A hold is a reason a person is needed. These are all of them:

| Hold | When | A rule may waive it |
|---|---|---|
| `lifeline` | the service is a lifeline | no |
| `ask` | the service always asks | yes |
| `unsafe` | the review says block, naming what breaks | no |
| `needs-action` | the review lists steps this deployment must take (or a breaking change) | no |
| `no-evidence` | no release notes were read, *and* it is a major, a stateful service, or `shipshape.review: required` -- never for a digest rebuild of the running tag | yes |
| `irreversible` | the review says it migrates stored data one-way | yes |
| `no-restore-point` | a stateful service with neither a `shipshape.snapshot` nor an offsite backup job, or one whose restore point failed -- never for a digest rebuild of the running tag | yes |

**"Caution" no longer holds anything.** It held 43 of 75 open updates, none of which listed
a single breaking change or step; it had quietly become a second "you merge it" setting.
Missing release notes on a patch or minor are fine: rollback covers it. What the reader says
is now concrete -- work to do, something unsafe, a one-way migration -- or it is nothing.
A verified security fix lifts `ask` and `no-evidence` and nothing that is a real warning.

Anything that is still waiting is, in order: **ready** (you said ship), **waiting** (a review
still coming, a snooze, the cooldown, pause), or a **decision** (a card).

**Cooldown.** Nothing ships on its own until its release is `ship.cooldown_days` old
(default 7): the registry's publish date where it gives one, else when shipshape first saw
the tag; a digest move counts from when it was seen. A broken or hijacked release usually
surfaces within days, and a week of nothing shipping is cheap. A ship you press is not held.
A verified security fix waits `security.fix_cooldown_days` (default 2) instead, and one for
a critical, KEV-listed or exploited incident does not wait at all. Release notes never
shorten the wait -- "security release" is exactly what a hostile release would say.

### Rules

Pressing **Always ship** writes a rule:

```yaml
rules:
  - { id: r1, match: { image: ghcr.io/agentgateway/agentgateway }, waive: [ask], because: "2026-11-11, agentgateway v1.7.0 card: always ship" }
```

`match` keys all have to match: `image` (a repository, any stack), `stack`, `service`, or
`base_build: true` for our own builds. `waive` is the reasons it removes, from the table
above. Rules are an ordinary commit, readable and editable like anything else; the Settings
page lists them. A rule can never waive what is not waivable, even if the file says so.

### Restore points

Before a `stateful` service is updated -- or any update the review calls irreversible --
shipshape runs the service's own `shipshape.snapshot` command inside its container (a
command that prints a dump to stdout: `pg_dump -U app app`), gzips the output under
`DATA_DIR/restore-points/<stack>/`, and keeps the newest `restore_points.keep` per service.
It also optionally asks any MCP tool for an offsite copy (`restore_points.offsite`: here
backup-mcp's `run_backup`, which re-runs the stack's backup job); beside a dump, a failure
there is recorded and never blocks a ship. A failed local dump does: the update waits with a
`no-restore-point` hold that says why.

A stack with no snapshot label but a job on the offsite server (`list_tool`, read hourly)
gets that backup as its restore point instead: shipshape runs it, polls `status_tool` until
it finishes (up to `wait_minutes`), and ships only if it succeeded. It is recorded as
`offsite:<job>`. A digest rebuild of the tag already running takes no restore point and
asks for none: there is no version change to migrate data.

**Restoring is deliberately manual.** Putting data back blindly loses whatever was written
after the dump. A card for a rolled-back update names the file, and you decide.

This is also the prompt-injection boundary: release notes are untrusted input, and the
worst a hostile changelog can achieve is a card asking you.

### The review, in two stages

- **The screen** — Jev, a System One model from TypeSafe, through OpenRouter's Decisions
  API. It does not write; it answers. For each update it is given the release notes
  shipshape already fetched (cleaned and capped in code), the deployment's environment
  variable *names*, volume paths and dependencies, and the notes' own bullet lines, and
  asked a set of narrow yes/no questions — a setting removed or renamed, a manual step, a
  one-way migration, dropped support, a changed default, a configuration edit, whether any
  of it touches this deployment — plus a risk score and, per line, whether it asks for
  action or would be noticed. Code turns the probabilities into **routine**, **finding**,
  **escalate** or **no notes**: routine needs every risk answer to be a clear no *and* the
  evidence to be whole (a patch or minor, notes for every version in range, nothing
  truncated, an upstream identified with certainty). About $0.0005 a look.
- **The reader** — Claude, reading the changelog properly, with web search confined to
  the upstream's own documentation. It writes the summary, breaking changes, migration
  steps and new features.

`review.screen: shadow` runs the screen on every update and shows its answers on the
update page without acting on them. `on` lets a routine update through on the screen's
approval, sends everything else to the reader, and still reads one routine update in ten
as an audit — an alert fires if the reader finds work the screen called routine. A
finding holds the update *provisionally* until the reader has looked; once the reader has
had a reasonable wait (six hours), an update it could not read is treated as having no
evidence. `npm run jev-replay` calibrates the screen against verdicts the
reader already wrote.

The whole model is also rendered in the running app: each section of the Settings page
says what that stage does, in the order an update moves through them.

### Security incidents

shipshape can follow [pwn.watch](https://pwn.watch)'s incident index and say which running
services carry a version an incident names -- and which update removes it.

1. **Feed.** `incidents.json` is read every `security.interval_m` minutes with a
   conditional GET; live incidents in the followed categories (`patch`, `supply-chain`)
   are stored, and re-stored only when their `updatedAt` moves.
2. **Extract.** The screen asks whether anything named could be inside a container at all
   (appliances, phones and hosted services fall out here). For the rest, the reader turns
   the advisory's affected/fixed text into package targets -- ecosystem, names, version
   intervals -- once per version text (`src/prompts/security.md`, overridable like the
   others). This is the only judgement in the path.
3. **Inventory.** [syft](https://github.com/anchore/syft), pinned by digest
   (`security.syft_image`), runs as its own short-lived container against the host's docker
   socket and lists every package in each running image -- runtimes such as `node` by their
   binary, npm, PyPI, Debian and Alpine packages. Inventories are keyed by image id, so each
   image is read once. For an *exposed* service only, the image an open update would bring
   in is pulled and inventoried too.
4. **Match.** No model: a package either is in an inventory with a version inside an
   affected interval, or it is not. An update is a **verified fix** for an incident when
   its own image carries every exposed package, and none of them -- nor anything else the
   incident names -- in an affected version. A package that vanished verifies nothing.
5. **Act.** `security.mode: shadow` records all of this (Status page, the MCP's
   `list_exposures`) and says nothing. `on` adds one card per incident
   (`shipshape:security:<slug>`, loudness by severity, exploitation and whether the service
   has a public router) for exposure no verified fix is about to remove.

**The one place an outside signal widens what ships.** With `security.mode: on` and
`security.auto_merge: true`, a verified fix lifts the `ask` and `no-evidence` holds and
ships after `security.fix_cooldown_days`. It never passes a `lifeline`, an `unsafe` review,
a list of work to do, a review still on its way, a frozen or dormant service, the per-run
ceiling or `paused`. The advisory cannot cause this on its own: it only says which versions
are bad, and the evidence that an update removes one is both images' own inventories, read
here. The worst a hostile feed achieves is shipping a real upstream release that
demonstrably changes a package it named.

## Running it yourself

shipshape watches a git repository full of Docker Compose files, so it needs to know
which repository and where that checkout lives on disk. Nothing else is required to
start.

### Environment

| Variable | Required | Default | What it is |
|---|---|---|---|
| `REPO_DIR` | **yes** | — | The checkout of your compose repository. Must be bind-mounted at the *identical* path inside the container (see below). |
| `GITHUB_REPO` | **yes** | — | `owner/repo` of that repository, where `main` is published. |
| `GITHUB_TOKEN` | to publish | — | Fine-grained PAT scoped to that repo: **Contents** read+write. (Pull requests: read+write only for the one-time cleanup of v1's open ones.) |
| `ANTHROPIC_API_KEY` | for analysis | — | One of this or `OPENROUTER_API_KEY`. Without either, updates still ship, on the evidence that is left (no reading counts as no evidence). |
| `OPENROUTER_API_KEY` | for analysis | — | Routes every model call through OpenRouter's Anthropic-compatible endpoint instead, and is the only way to run the screen (Jev, via the Decisions API). Wins when both are set; the two are never sent together. Model ids then carry a vendor prefix — `anthropic/claude-opus-5.5`. The workspace guardrail must allow the TypeSafe provider for the screen. |
| `LLM_BASE_URL` | no | OpenRouter's base | Only for a self-hosted Anthropic-compatible gateway. |
| `POLICY_FILE` | no | `$REPO_DIR/shipshape/config/policy.yaml` | Where the tracked policy file lives. |
| `SELF_STACK` | no | `shipshape` | Stack directory holding shipshape, excluded so it never updates itself. |
| `BOT_EMAIL` | no | `shipshape@localhost` | Git author for shipshape's commits. |
| `DATA_DIR` | no | `/data` | SQLite database and shipshape's own working clone. |
| `PORT` / `TZ` | no | `8080` / `UTC` | |
| `NOTIFY_URL`, `NOTIFY_TOKEN` | no | — | What the default `webhook` sink reads (`notify.sinks` can name other variables): incidents, as JSON with a bearer, to a notification router (here n8n's `/webhook/notify`). |
| `GIT_REMOTE_URL` | no | `https://github.com/$GITHUB_REPO.git` | Where git fetches and pushes, for a self-hosted forge. |
| `SHIPSHAPE_ACTION_SECRET` | no | — | Signs the action links in email and ntfy messages (with `SHIPSHAPE_ALLOWED_ORIGIN`). Unset: those sinks send no links. |
| `MCP_PORT` | no | — | An MCP server (Streamable HTTP at `/mcp`) for agents: the dashboard's reads plus the operator verbs (`update_action`, `stack_action`, `scan_now`, `check_service`), each checked by `actionsFor` exactly like a button. It has **no auth of its own**: put an OAuth gateway in front and keep the port on a network only that gateway shares. Unset: no listener. |

The MCP also publishes `shipshape://usage`, cached `shipshape://status`, and bounded
`shipshape://updates/{id}` / `shipshape://services/{stack}/{service}` context templates.
`review-update` is a read-first planning prompt, not permission to run an action.
`api_usage` exposes the same zero-upstream-call budget observations as the status resource:
Docker Hub's last reported count and timestamp, its deploy reserve, unknown GitHub quota,
and the shared local model-spend ledger. Cached observations are not a fresh quota probe
or a per-agent allowance. `scan_now`, `check_service`, paid readings and deployment actions
can contact upstreams or spend money; inspect existing work before repeating them. Every
tool has explicit behavioral hints, and results retain text while also supplying structured
data. Resource/prompt discovery never triggers a scan, reading, ship or deployment.
| `SMTP_URL`, `MAIL_TO` | no | — | Email. Both are needed; either alone counts as off. `MAIL_FROM` defaults to `BOT_EMAIL`. |
| `DOCKER_HUB_LOGIN` / `_PASSWORD` | no | — | Doubles the Docker Hub pull allowance (100→200 per 6h). |

Start it with nothing set and it will tell you what is missing rather than crash-loop.

### Why the mount path must match

`docker compose` resolves relative volume paths (`./data`) and derives the project name
**client-side**, before it talks to the daemon. If shipshape saw your repo at a different
path than the host does, it would hand the daemon paths that do not exist. So the bind
mount is `/your/path:/your/path`, not `/your/path:/repo`.

```yaml
services:
  shipshape:
    build: ./app          # or image: ghcr.io/justmytwospence/shipshape:latest
    restart: unless-stopped
    user: "1000:1000"     # match the owner of the checkout
    environment:
      REPO_DIR: /srv/compose
      GITHUB_REPO: you/your-compose-repo
      GITHUB_TOKEN: ${GITHUB_TOKEN}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}   # or OPENROUTER_API_KEY: ${OPENROUTER_API_KEY}
    volumes:
      - /srv/compose:/srv/compose                  # identical path, read-write
      - ./data:/data                               # create it first: mkdir -p data
      - /var/run/docker.sock:/var/run/docker.sock  # deploys run compose
    ports:
      - "8080:8080"
```

Put a web server with authentication in front of it. The UI has no login of its own,
because it is designed to sit behind one you already run.

### Labelling services

shipshape only watches services that opt in, via labels on the service in your compose
file. It reads them from the **files**, not from running containers, so a label change
takes effect on the next scan without recreating anything.

```yaml
    labels:
      shipshape.watch: "true"
      shipshape.pattern: semver     # semver | v-semver | semver-minor | v-semver-minor
                                   #  | semver-quad | major-only | v-major-only
                                   #  | semver-variant | semver-minor-variant
                                   #  | major-variant | lsio-ls | lsio-r-ls | date
                                   #  | digest | latest | regex
      # Optional:
      shipshape.tag.include: '^\d{1,3}\.\d+\.\d+$$'  # narrow the candidates ($$ escapes $)
      shipshape.class: stateful     # normal | stateful | ask | lifeline | frozen
                                   #   how much this service asks of you. Anything
                                   #   unrecognised narrows to `ask`. The v1 labels are
                                   #   still read and mapped (`shipshape.policy: auto |
                                   #   manual | attended | on-request | skip`, and
                                   #   `shipshape.pr: on-request`); the class wins.
      shipshape.snapshot: pg_dump -U app app
                                   # a command that prints a dump of this service's data to
                                   #   stdout, run inside its container before a stateful
                                   #   update. Write compose's `$$` where the shell needs `$`.
      shipshape.backup-job: app-nightly  # the offsite backup job to trigger alongside it
      shipshape.source: owner/repo  # the upstream repository, when shipshape cannot find it;
                                   #   a github.com link works too, and is written as owner/repo
      shipshape.changelog: https://example.com/release-notes
                                   # where the notes are when GitHub releases do not have
                                   #   them: an https page, or a path in the repository
                                   #   such as CHANGELOG.md. Read alongside any releases.
      shipshape.propose: service    # none | service | compose-file | compose-dir | repo
                                   #   how far a drafted change may reach, derived from
                                   #   where the compose file sits. Any text file inside
                                   #   the boundary is editable. Default `service`.
      shipshape.review: required    # a major or a thin reading asks, rather than ships
                                   #   (`shipshape.claude` is the old spelling)
      shipshape.group: mygroup      # force services to ship together
      shipshape.deploy: rm-first    # recreate rather than update (re-reads image env)
```

A `shipshape.*` key the scanner does not read is logged as a warning on every scan, so a
typo is not silently a label that does nothing.

### Images you build yourself

A service with `build:` runs an image no registry publishes, so there is nothing to poll for
it -- but its base image is published, and that is where most of what it carries comes
from: the distribution's packages, the language runtime, OpenSSL. Left alone, a local build
keeps the base it was last built on for as long as nobody rebuilds it, because `compose up
-d` reuses the cached image.

So `shipshape.watch: "true"` on a `build:` service watches it through the base of its
Dockerfile's **final stage** (followed back through any earlier stage it names):

```dockerfile
FROM python:3.13-slim@sha256:...   # what shipshape watches and moves
```

- The other `shipshape.*` labels describe that base, as they describe the upstream for a
  fork. Pin it by digest and leave `shipshape.pattern` unset: every move of the tag (a
  distribution security rebuild, a runtime patch) is then a digest update. Or give it a
  version pattern to follow releases instead -- a tag without a digest can still move by
  edit. A floating base (`latest`, no tag, or a `latest`/`digest` pattern without a pin) is
  refused, because the file would say the same thing after the move.
- The change edits the `FROM` lines that name the base -- a builder stage on the same
  image moves with the final one -- and nothing else, so it is as clean as an image line
  and merges, deploys and rolls back like one. A digest pin is kept on a version bump.
- Deploying builds the service before `up`. A rollback reverts the line and **rebuilds** on
  the old base: the image keeps one local name whatever it is built on, so no previous
  image is on disk under a name a revert could point at. The old base and the layers built
  on it usually are, so the rebuild is quick.
- The Dockerfile must be a file in this repository. A remote context (a git URL), an
  inline Dockerfile, an `escape` directive, a `FROM` continued across lines or a base set by
  a build argument are refused, and said on the service's activity line.
- Digest moves are manual like any other. The security pass already inventories the
  running build, so an incident in a base package finds it, and a digest move whose new
  base carries the fixed version is a verified fix -- the one way a digest move merges on
  its own.

The build's own dependencies -- a version in an `ARG`, a `pip install` -- are not watched.

### Where the release notes come from

For each update, shipshape reads the notes for exactly the versions it crosses — after the
running version, up to and including the proposed one: the upstream's GitHub releases in
that range, prereleases marked; the sections of its changelog file for those versions
(`CHANGELOG`, `CHANGES`, `HISTORY`, `NEWS`, `RELEASE_NOTES`, or a directory of one file per
version), leaving out what a release already says; the notes linked by
`shipshape.changelog`; and the newest commits between the two tags. Image tags and release
names are matched by the version they name, so `2.96.22-cpu` meets `v2.96.22` and
`4.137.0-ls364` meets `v4.137.0`. The review is told where the repository came from, how
sure that is, and what was and was not found. A rate limit or an outage marks the reading
incomplete; the verdict stands, and is read again later.

Prereleases follow the stream a service is on. A service running a stable release is not
offered a prerelease; one already on a prerelease line — minuspod's maintainer marks most
releases as prereleases — keeps moving along it.

### Policy

A starter `policy.yaml`, which the Settings page also edits for you:

```yaml
paused: true                  # nothing ships on its own. A ship you press still deploys.
ship:
  cooldown_days: 7            # a release must be this old before it ships on its own
  max_per_run: 3
review:
  screen: shadow              # off | shadow | on -- Jev, needs OPENROUTER_API_KEY
  model: anthropic/claude-opus-5.5        # the reader; `off` for none
  code_model: anthropic/claude-opus-5.5   # drafts config changes, picks a rule's scope
  monthly_budget_usd: 40      # every model call together
propose:
  mode: auto                  # auto | off (the verb works either way)
restore_points:
  keep: 3                     # dumps kept per service
  offsite:                    # optional: ask any MCP tool for an offsite copy too
    type: mcp
    url: http://backup-mcp:8000/mcp
    tool: run_backup
    job: "{stack}"
    status_tool: run_status   # polled when the backup is the restore point itself
    list_tool: list_jobs      # which stacks have a job
    wait_minutes: 30
    poll_seconds: 10
deploy:
  verify_window_s: 300        # how long a deploy has to prove itself
  soak_s: 1800                # a second look before it reads verified
  rollback: auto              # auto | suggest | off
notify:
  sinks:                      # where messages go; each may list the events it wants
    - type: webhook           # decision | broken | security | system
  escalate_after_days: 7      # a waiting decision is announced once more, louder
rules: []                     # written by the Always ship button
sync:
  push_main: true             # false: alert-only, nothing ships
scan:
  cron: "0 0 3 * * *"         # seconds first
```

An older file still loads. `claude:` folds into `review:`, `merge.cooldown_days` and
`merge.max_per_run` fill `ship:`, and `notify.incidents` / `notify.email` become sinks. The
keys v2 no longer reads (`merge_method`, `merge`, `prs`, `revise`, `defaults`,
`notify.routine`, `notify.cron`, `model_tier`, `sync.blackout`) load without error at any
value and are named once per scan in the Activity log, so they get removed rather than
believed.

Prompt overrides are files beside `policy.yaml`: `prompts/verdict.md`,
`prompts/proposal.md`, `prompts/rule.md`. Absent means the shipped default.

### Notifications

Shipshape emits messages; `notify.sinks` says where they go. Each sink may list the
`events` it wants (`decision`, `broken`, `security`, `system`; none listed means all):

| Sink | What it is |
|---|---|
| `webhook` | The homelab's notification router: `{key, source, title, message, priority, status, click, actions}` to `NOTIFY_URL` with a bearer (`url_env` / `token_env` name other variables). The router keeps one live card per `key`, edits it in place, and turns `actions` into one-tap reactions that call back through the MCP. |
| `email` | One mail on a first fire and on an escalation; never on edits or resolves. Actions become signed links. Needs `SMTP_URL` and `MAIL_TO`. |
| `ntfy` | One JSON publish per first fire or escalation, with the card's actions as view buttons on signed links (`url`, `topic`, optional `token_env`). |

Silence means healthy. Nothing is announced on success, completion or recovery; what is
announced is something that needs you:

- **A decision** (`decision`): one card per image and target, P3, re-sent once at P4 after
  `notify.escalate_after_days`. Key `shipshape:decision:<repository>`; it resolves when the
  update ships, is skipped, snoozed or superseded.
- **Something broke** (`broken`): key `shipshape:deploy:<stack>`. A deploy that failed
  verification and was **rolled back cleanly** is a quiet card (P3) with the reason, the
  restore point if one was taken, and the rule it shipped under -- worth knowing, nothing
  to do. A rollback that left something down, or failed, is louder (P4, P5). A later
  verified deploy of the stack resolves it.
- **An exposure** (`security`): `shipshape:security:<slug>`, loudness by severity.
- **Shipshape itself** (`system`): sync stuck, credentials refused, budget spent.

The links in email and ntfy point at `/act/<token>`: a signed, expiring token naming one
verb on one update, which shows a confirmation page and only then acts, behind the same web
authentication as everything else. A leaked link alone does nothing.

A send the router cannot take is kept in the database and retried every tick.

### One-time repository settings

Shipshape pushes `main` as part of its loop: a branch cut from a stale `origin/main`
silently reverts unpushed local commits when it merges, so publishing is a precondition,
not a preference. `sync.push_main: false` disables it, which also stops shipping. The
token needs **Contents** read+write only. Nothing is opened or merged on GitHub any more;
the first start after upgrading from v1 closes the pull requests v1 left open, with a note
saying where each update went.

## Status

Working today: detection across every registry, digest watching, changelog analysis with
evidence-based holds, local merge-commit shipping, restore points, standing rules, one
decision card per image, drafted config changes, a deploy engine with verification, soak
and rollback, configurable notification sinks, and a web UI you can run the whole thing
from -- including the phone.

`paused: true` ships on, because turning the unattended path on should be a decision
rather than a consequence of upgrading. Paused, shipshape still scans and reads
changelogs; what waits for you is every step that would change the host. A ship you press
still deploys. `merge.auto` and `deploy.mode` are still read and fold into it.

## License

[Functional Source License, Version 1.1, ALv2 Future License](LICENSE.md) (FSL-1.1-ALv2). You may use, modify and self-host it for any purpose except offering a competing commercial product or service; each release becomes available under Apache-2.0 two years after it ships. Earlier releases published under MIT remain available under MIT.

Outside contributions require agreeing to a contributor license agreement; open an issue before sending a pull request.
