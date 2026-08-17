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
| `manual` | A pull request opens. You merge it. |
| `on-request` | Nothing opens. The update is listed until you ask for a pull request. |
| `skip` | Not tracked at all. |

Majors and digest moves are **always** manual, and that is not configurable. A
`shipshape.policy` label on a service overrides the default for that service and always
wins; anything unrecognised narrows to `manual` rather than widening.

**Pause** is the one global switch: while it is on, shipshape merges and deploys nothing
on its own. Scanning, pull requests and changelog reviews continue; every step that would
change the host waits for a button. A merge *you* press still deploys — you are present.

## The stages

`Detected · Held on request · Waiting on you · Auto-merging · Ready to deploy ·
Deploying · Verifying · Verified · Failed · Rolled back · Skipped · Superseded`

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
| Waiting on you | **Merge & deploy** (confirm step) | Skip · Draft config changes · Re-run review · Open on GitHub |
| Held on request | **Open PR** | Skip |
| Ready to deploy | **Deploy** | Copy compose command |
| Rolling tag moved | **Redeploy** | Dismiss |
| Failed / Rolled back | **Try again** | Skip · Acknowledge |
| Verified / Degraded | **Roll back** | Acknowledge |
| Review failed | **Re-run review** | Skip |

A verb keeps its name through the whole flow: the button that says "Deploy" produces
"Deploying" and then "Deployed". Destructive-ish verbs (Merge & deploy, Roll back) are
only offered where the analysis is on screen, never as a bare row button.

## Where things live

- **Inbox** — what needs you, grouped by why, worst first; then what happened recently.
- **Updates** — every update by stage, filterable, searchable.
- **Services** — every service, its watch status, and its effective configuration with
  provenance (label / default / inferred / locked).
- **Activity** — the log, coalesced.
- **Settings** — the defaults, Pause, review, notifications, schedule; Advanced holds
  everything else; Status is the machine's own state; `/docs` explains the model.

## Two rules about configuration

**Per-service data lives as labels on the service**, so it travels with the thing it
describes, and shipshape reads it from the compose files in git rather than from running
containers — a label edit takes effect on the next scan with nothing recreated.

**Policy semantics live once, centrally**, in `policy.yaml`. This repo previously
copy-pasted a six-clause trigger string onto 94 services, and a deliberate carve-out got
silently reverted in a refactor because nobody could see the policy in one place. Do not
reintroduce per-service policy knobs beyond the one rung.
