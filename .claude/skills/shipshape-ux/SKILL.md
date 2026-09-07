---
name: shipshape-ux
description: The shipshape product model and the exact words the interface uses — lifecycle stages, verdict labels, policy rungs, the Pause switch, and which action each state offers. Read before writing or changing any user-facing copy, badge, filter, notification or page, so the vocabulary stays one vocabulary instead of being re-derived from config.ts.
---

# What shipshape is, in the words the UI uses

An update to one service travels one path. Every page names the same stage the same way;
if a word here is missing from the interface, or the interface has a word that is not
here, one of the two is wrong.

## The one axis

**How much happens without you**, chosen per image, defaulting per version magnitude:

| Rung | What happens |
|---|---|
| `auto` | A pull request opens and shipshape merges it, unless the changelog review objects. |
| `manual` | A pull request opens. You merge it, and the deploy follows. |
| `attended` | A pull request opens. You merge it, and **you** deploy it. |
| `on-request` | Nothing opens. The update is listed until you ask. You deploy it. |
| `skip` | Not tracked at all. |

Majors and digest moves are **always** manual, and that is not configurable. A
`shipshape.policy` label on a service overrides the default for that service and always
wins; anything unrecognised narrows to `manual` rather than widening.

**Pause** is the one global switch: while it is on, shipshape merges nothing on its own.
Scanning, pull requests and changelog reviews continue. A merge *you* press still deploys —
you are present, and that is the point: merging is the decision and deploying is carrying
it out, so the two are not negotiated separately.

**A merge always leads to a deploy shipshape watches**, so a failure is caught by the
health check and rolled back inside the soak window. Withholding the deploy never avoided
that risk, it only moved it — the merged version reaches the host anyway the next time
anything recreates the stack, and it arrives then with nothing watching. The exception is
named per service, on the `attended` and `on-request` rungs, rather than taken globally:
infrastructure that carries the way back in, datastores, anything a rollback could not put
back.

## The stages

`Detected · Held on request · Waiting on you · Auto-merging · Ready to deploy ·
Deploying · Verifying · Verified · Failed · Rolled back · Skipped · Superseded`

**Superseded** is a stage of the *update*, not of its pull request. When a newer version
appears the pull request is **retargeted** onto it -- same number, rebuilt branch, one
comment saying the target moved -- and is only closed when it cannot be moved, which is
when nothing live is left to move it onto or you have pushed to the branch yourself.
"Retargeted" is the word everywhere that event appears: the comment, the activity log and
the digest. Never say a pull request was "superseded"; its update was.

Merging always leads to a deploy: `compose up -d` → verify (health check, HTTP probe
where a port is declared, crash watch) → soak → **Verified**. A hard failure inside the
verify window rolls back automatically, once. After the soak nothing is rolled back
automatically: a database may have migrated by then, and undoing that is a person's call.

## The review

Claude reads the upstream changelog and returns a recommendation with a confidence. The
UI never shows the raw enum:

| Verdict | Say | Colour |
|---|---|---|
| `approve` | **Safe to apply** | success |
| `caution` | **Read first** | warning |
| `block` | **Breaking changes** | error |
| none yet | **Reading changelog…** | skeleton |
| failed | **Review failed** | error, with the attempt count |
| off / unavailable | **No review** | neutral |

Most releases carry **No review**, and the interface says so rather than leaving a gap.
Reviews are written against pull requests, so an update that applies on its own has none
to be written against. Minor and major updates that applied unattended are reviewed after
the fact so the Releases tab has something to say about them; patches are not, because
they are most of the volume and least of the interest, and every review costs a model
call. A release with no review still links to its changelog -- those links come from the
image reference, not from any analysis.

Confidence is always visible next to it, as text. It is the qualifier that changes the
decision — "Safe to apply" at low confidence is not the same claim — and a `title`
attribute does not exist on a phone.

**The review can only ever hold an update back, never cause one to happen.** Release
notes are untrusted text from the internet; the worst a hostile changelog can achieve is
a stopped update. Never write copy that implies the model approved, decided, or released
anything.

## One primary action per state

| State | Primary | Also available |
|---|---|---|
| Waiting on you | **Merge & deploy** (confirm step) | Skip · Draft config changes · Re-run review · Release hold · Open on GitHub |
| Held on request | **Open PR** | Skip |
| Ready to deploy | **Deploy** | Copy compose command |
| Rolling tag moved | **Redeploy** | Dismiss |
| Failed / Rolled back | **Try again** | Skip · Acknowledge |
| Verified / Degraded | **Roll back** | Acknowledge |
| Review failed | **Re-run review** | Skip |

A verb keeps its name through the whole flow: the button that says "Deploy" produces
"Deploying" and then "Deployed". Destructive-ish verbs (Merge & deploy, Roll back) are
only offered where the analysis is on screen, never as a bare row button.

## Your comments

Comment on an open pull request and shipshape reads it as an instruction. Any comment
counts -- there is no prefix -- and it replies to every one, including the ones it decides
need no change. `revise.mode` says how far it may go: `off`, `reply` (it answers, and may
hold, skip or re-read the changelog), or `act` (it may also write the change onto the
branch, as a second commit, which permanently disqualifies the pull request from
auto-merge like any other drafted change).

**It can never merge and never deploy from a comment, at any setting.** Never write copy
that suggests otherwise. A merge reaches the host through a real `compose up`, and that is
not something a reading of prose may start. Skipping is the other thing it will not infer:
that leaves a tombstone the scan never offers again, so it needs the literal `/skip` typed
in the comment. Everything reversible -- answering, editing, holding, re-reading -- is
prose-driven.

**Hold** and **Release hold** are the verbs. The sentence is "You asked shipshape to hold
this -- it will not merge on its own." Hold is not a button: somebody who does not want a
merge simply does not press Merge, so only the release half is offered.

**Hold is not Held.** `Held on request` is the `on-request` rung and means no pull request
has been opened yet. A hold is a pull request that exists and has been asked to wait. Same
English word, different stage, different button -- the badge word stays reserved for the
rung.

## Where things live

- **Inbox** — what needs you, grouped by why, worst first; then what happened recently.
- **Updates** — every update by stage, filterable, searchable. Its **Releases** tab is the
  same rows read rather than worked: newest first rather than biggest first, the review's
  summary on the row rather than behind a click, and a link out for every release. It is a
  tab, not a seventh destination -- the six below still stand.
- **Services** — every service, its watch status, and its effective configuration with
  provenance (label / default / inferred / locked).
- **Activity** — the log, coalesced.
- **Settings** — the defaults, Pause, review, your comments, notifications, schedule;
  Advanced holds everything else; `/docs` explains the model.
- **Status** — the machine's own state: its clocks, what it is wired to, what it has
  spent, and what would merge if nothing were holding it. Nothing on it is a decision,
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
reintroduce per-service policy knobs beyond the one rung.
