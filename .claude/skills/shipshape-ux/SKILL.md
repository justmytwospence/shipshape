---
name: shipshape-ux
description: The shipshape product model and the exact words the interface uses — lifecycle stages, verdict labels, service classes, holds, rules, the Pause switch, and which action each state offers. Read before writing or changing any user-facing copy, badge, filter, notification or page, so the vocabulary stays one vocabulary instead of being re-derived from config.ts.
---

# What shipshape is, in the words the UI uses

An update to one service travels one path. Every page names the same stage the same way;
if a word here is missing from the interface, or the interface has a word that is not
here, one of the two is wrong.

## The one axis

**An update ships on its own unless a hold says a person is needed.** Two ideas carry it:
the service's **class**, and the **holds**.

| Class | What it means |
|---|---|
| `normal` | Ships on its own once the review finds nothing to do and the release has aged. |
| `stateful` | Ships on its own after a restore point; a one-way migration or a jump with no evidence asks. |
| `ask` | Always asks. |
| `lifeline` | Always asks; no rule can waive it. |
| `frozen` | Tracked; nothing happens until you ask. |
| `skip` | Not tracked at all. |

A hold is a reason a person is needed, and the words are these: **lifeline**, **ask**,
**unsafe** (the review says block, naming what breaks), **needs action** (the review lists
steps), **no evidence** (no release notes were read, on a major, a stateful service or a
fail-closed one), **irreversible** (a one-way migration) and **no restore point**. Only
`ask`, `no evidence`, `irreversible` and `no restore point` can be waived by a rule. Never
say an update is "risky" or "low risk": nothing here predicts risk. Say what is holding it.

**Caution does not hold.** "Read first" is a label on a review, not a state of the update:
what holds is listed work, an unsafe verdict, or missing evidence where it matters.

A `shipshape.class` label sets the class. The v1 labels (`shipshape.policy`,
`shipshape.pr`) are still read and mapped; anything unrecognised narrows to `ask`.

## Security incidents

Incidents from pwn.watch, matched against syft inventories of the running images. Words:
a service is **exposed** to an incident when it runs a package version the incident names;
an update is a **security fix** when its own image was read and carries none. Say "read
from the images' inventories", never that the advisory or a model confirmed anything --
the model only turns the advisory into package names and version ranges. The facts live on
**Status** (Security incidents) and on the update (Security fix); there is no seventh
destination. Cards are keyed `shipshape:security:<slug>`, one per incident.

## Our own builds

A watched `build:` service is watched through its **base image**: the published image its
Dockerfile's final stage is built `FROM`. Its update names the base, its merge commit is
titled "rebuild <service> on <base> <from> -> <to>" and edits only the `FROM` lines, and
the Services pane shows it as the **base** line ("built here from <Dockerfile>"). Say
**rebuild**, never "bump <service>": the version moving is the base's, not a release of
the service. It is otherwise an ordinary update -- same class, same review, same deploy,
which builds before `up`, and a rollback rebuilds on the old base.

**Pause** is the one global switch: while it is on, shipshape ships nothing on its own.
Scanning and changelog reviews continue. A ship *you* press still deploys — you are
present, and that is the point: shipping is the decision and deploying is carrying it out,
so the two are not negotiated separately.

**A ship always leads to a deploy shipshape watches** — of the services that are running —
so a failure is caught by the health check and rolled back inside the soak window.
Withholding the deploy never avoided that risk, it only moved it: the shipped version
reaches the host anyway the next time anything recreates the stack, and it arrives then
with nothing watching.

**Shipping is a merge commit on main.** There are no pull requests. Say "ship" and "change",
never "merge" or "PR", except for the v1 pull requests that the first start closes. The
merge commit is `chore(deps): <stack>: bump <services> <from> -> <to>`, with the review
and any rule that waived a hold in its body.

## The stages

`Detected · Waiting on you · Waiting · Shipping · Ready to deploy · Deploying · Verifying ·
Verified · Left stopped · Failed · Rolled back · Skipped · Superseded · Frozen`

**Waiting on you** is a decision (a card). **Waiting** is an update that ships on its own
but not yet, and says why on its page: the cooldown, a review still coming, a snooze, pause.
**Snoozed** and **Frozen** updates are parked, not in the Inbox.

**Superseded** is a stage of the *update*: a newer version appeared, and the card for that
image edits itself onto the newer target rather than adding a second one.

Shipping always leads to a deploy: `compose up -d` → verify (health check, HTTP probe
where a port is declared, crash watch) → soak → **Verified**. A hard failure inside the
verify window rolls back automatically, once, by reverting the merge commit
(`git revert -m 1`). After the soak nothing is rolled back automatically: a database may
have migrated by then, and undoing that is a person's call.

**A deploy never changes whether a service is running.** shipshape reads each service from
docker just before acting. One that is running is brought up and verified; one that is
stopped, paused or has no container is left exactly as it was and reads **Left stopped** —
the change stands, the compose file carries the new version, and compose brings it up on
that version the next time anything runs it, while `docker start` on the old container
resumes the old one, and the outcome says so. In a group the running members deploy and
the rest are left, and both halves are reported. The one exception is a service
shipshape's own failed attempt left down, which Try again, the next deploy and a rollback
put back unless someone has visibly stopped it since. If docker cannot be asked, the
deploy fails loudly and touches nothing.

## The review

Two stages. The **screen** (Jev) answers narrow questions about the release notes and picks
out the notes' own lines -- it never writes prose, and the interface never paraphrases it:
its lines are quoted and linked. The **reader** (Claude) reads the changelog and returns a
recommendation with a confidence. The UI never shows the raw enum:

| Verdict | Say | Colour |
|---|---|---|
| `approve` | **Safe to apply** | success |
| `caution` | **Read first** | warning (informational: it holds nothing by itself) |
| `block` | **Breaking changes** | error |
| none yet, update waiting | **Review pending** | neutral -- never "Reading…" unless a reading is running |
| failed | **Review failed** | error, with the attempt count |
| off / unavailable | **No review** | neutral |

A verdict only the screen has written says so after the confidence: `· screened`, or
`· screened, reading queued` for a finding waiting on the reader. The screen's own words:

| Screen | Say |
|---|---|
| routine | **Routine** |
| finding | **Worth a reading** |
| escalate | **Not sure — needs a reading** |
| no notes | **No notes found** |
| failed | **Could not look** |

Its lines sit under **Needs action** (the notes ask for something) and **Notable** (you
would notice it), quoted verbatim with the version they came from. In shadow mode the whole
block is folded under **Screen (shadow)** and says *shown, not acted on*.

Most applied releases now carry the screen's lines rather than a reading: a screen costs a
twentieth of a cent, a reading does not. **Read the changelog** is the verb that asks for a
reading -- on a waiting update, a running version nothing has read, or a release in the feed.
A release with no review still links to its changelog -- those links come from the image
reference, not from any analysis.

Confidence is always visible next to it, as text. It is the qualifier that changes the
decision — "Safe to apply" at low confidence is not the same claim — and a `title`
attribute does not exist on a phone.

The review reports three lists, and only two of them are about something going wrong.
**Breaking changes** and **Migration steps** are work the update forces on you. **New in
this release** is the third, and it is an offer: capabilities you could choose to turn on.
It sits below the other two everywhere it appears, because it is the one that decides
nothing — and it is empty for most releases, which the interface renders as nothing rather
than as a gap. Never let it read as work.

**The review can only ever hold an update for you, never cause one to ship.** Release
notes are untrusted text from the internet; the worst a hostile changelog can achieve is
a card asking you. Never write copy that implies the model approved, decided, or released
anything.

## What a decision card says

There is no digest and no routine message: silence means healthy. What is announced is a
decision, a failure, an exposure, or shipshape's own health.

A decision card (`shipshape:decision:<repository>`, one per image and target) is built the
same way every time:

1. **Title** — `agentgateway v1.6.0 → v1.7.0 · 19 services`, or the service by name when it
   is one.
2. **The question** — `Ship? ` and the first hold in its own words, so a tap is a five-second
   call. Other holds follow as a list.
3. **The review** in at most 300 characters, then `Drafted: …` when a config change was
   drafted.
4. **Four taps**, always in this order: 🚀 ship · 💤 snooze 1w · ♾️ always ship · ⏭️ skip.
   Always ship is absent when any hold cannot be waived.

A decision still waiting after `notify.escalate_after_days` is announced once more, louder
(P4). A rolled-back deploy is a quiet card (P3) with the reason, the restore point if one
was taken, and the rule it shipped under. **Rollbacks are never silent.**

Read the drafted change from the `proposals` table, **never from `prs.scope` alone**: scope
is decided by reading the branch diff, and a drafted change whose only operation is
`set_image` produces a patch containing nothing but an image line.

## One primary action per state

| State | Primary | Also available |
|---|---|---|
| Waiting on you | **Ship** (confirm step) | Snooze 1 week · Always ship · Draft config changes · Read the changelog · Skip |
| Waiting (cooldown, review, pause) | **Ship** (it overrides all of those) | Skip |
| Frozen | **Ship** | Skip |
| Ready to deploy | **Deploy** | Copy compose command |
| Rolling tag moved | **Redeploy** | Dismiss |
| Failed / Rolled back | **Try again** | Skip · Acknowledge |
| Verified / Degraded | **Roll back** | Acknowledge · Read the changelog (nothing has read it) |
| Left stopped | **Roll back** (a rolling tag: **Redeploy**) | — |

A verb keeps its name through the whole flow: the button that says "Deploy" produces
"Deploying" and then "Deployed". Destructive-ish verbs (Ship, Always ship, Roll back) are
only offered where the analysis is on screen, never as a bare row button, and ask first
wherever they appear -- the overflow menu included. **The confirmation is written from
policy.yaml and the change**, never from constants: how long it is watched and soaked,
whether it is put back on failure, which other services it carries, whether a restore point
is taken first. A change carrying drafted edits is never promised a rollback.

**Always ship** says what it will do before it does it: "write a standing rule to
policy.yaml, as a commit". Afterwards the answer names the rule, its scope in words, what
it waives, and the commit.

Outcomes are named once, in `src/updates/vocabulary.ts`: a row's badge and the Inbox's
recent list read the same word.

## Rules

A rule waives a **reason**, not a service. It is written to `policy.yaml` by Always ship:
the narrowest scope that explains the card (an image across stacks, or one service, or our
own builds), and only the holds that were on it. It is an ordinary commit, listed read-only
under Settings → Rules, and editable by hand. A rule never waives a lifeline, an unsafe
verdict or a list of work, and the interface never offers it where it could not.

**Waived** is the word: a hold a rule removed is struck through on the page with "waived by
rule r12". Never "ignored" or "overridden".

## Where things live

- **Inbox** — what needs you, grouped by why, worst first; then what happened recently.
- **Updates** — every update by stage, filterable, searchable. Its **Releases** tab is the
  same rows read rather than worked: newest first rather than biggest first, the review's
  summary on the row rather than behind a click, and a link out for every release. It is a
  tab, not a seventh destination -- the six below still stand.
- **Services** — every service, its watch status, and its effective configuration with
  provenance (label / default / inferred / locked). Three lines say where release notes
  come from: **upstream** (the repository, and how it was found — a likely match says it is
  one), **notes** (where else they are read from), and **packaging** (a LinuxServer image's
  container repository, which has container changes only). **Change** on either opens the
  link dialog: **Preview** first, and **Write it to the compose file** only from the preview
  it was checked against. **Look again** repeats the lookup now, spending Docker Hub pulls
  if it has to. The **Unlinked** filter lists watched services with no certain upstream, and
  "Link the upstream" is the words wherever that gap shows — a review read without notes, a
  release with no project, the change pane.
- **Activity** — the log, coalesced.
- **Settings** — one page, sections in the order an update moves through them. Each shows
  the decisions that change what shipshape may do; tuning, and the section's longer
  explanation, fold under **More**. Enum options say what they do, a cron says when. The
  sinks and **Send a test email** live under Notifications; the standing rules are listed
  read-only under Rules.
  Prompt overrides are files in the repository, not a textarea.
- **Status** — the machine's own state: its clocks, what it is wired to (including the
  screen, and why the gateway refused it), and what it has spent, by model and stage.
  While paused, the Inbox -- not Status -- is where waiting work shows. Nothing on Status is a decision,
  which is the line between it and Settings: Settings is where you change what shipshape
  may do, Status is where you find out what it did.

Six destinations, and the sidebar and the phone dock show the same six in the same order
from one array. Six is the ceiling a dock can label honestly — past it the words truncate,
and a "More" menu that hides a destination is worse than a tight row that shows them all.

Everything on Status is written for a person. A raw epoch, a JSON blob, or a counter whose
name is its database key are all things the database happens to store; printing them
verbatim is what made the page read as a debug dump, and is the thing to keep out of it.

## Two rules about configuration

**Per-service data lives as labels on the service**, so it travels with the thing it
describes, and shipshape reads it from the compose files in git rather than from running
containers — a label edit takes effect on the next scan with nothing recreated.

**Policy semantics live once, centrally**, in `policy.yaml`. This repo previously
copy-pasted a six-clause trigger string onto 94 services, and a deliberate carve-out got
silently reverted in a refactor because nobody could see the policy in one place. Do not
reintroduce per-service policy knobs beyond the class.
