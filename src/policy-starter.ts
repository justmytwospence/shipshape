/**
 * What a policy file starts as when none exists: every key the Settings page edits, at
 * its default, with a line on what it does. The first Settings save or Always ship writes
 * it into the repository as a commit. test/policy-file.test.ts pins the values to the
 * Settings defaults, so the two cannot drift.
 */
export const POLICY_STARTER = `# shipshape policy. Edit it from the Settings page (each save is a commit here) or by hand.
# Every key is written out at its default so this file is the one place the policy is visible.
# Delete a line to fall back to the default.

# The one switch: while true, nothing ships on its own. A ship you press still deploys.
paused: true

scan:
  cron: "0 0 3 * * *"        # seconds first: every day at 03:00 (TZ)

ship:
  cooldown_days: 7           # a release must be this old before it ships on its own
  max_per_run: 3             # ships per pass, so a mistake ships a few things, not the backlog

review:
  screen: off                # off | shadow | on : a fast model that screens every changelog
  # model:                   # the reader of changelogs; unset = the default for your provider, off = none
  # code_model:              # drafts config changes
  monthly_budget_usd: 40     # every model call together

propose:
  mode: auto                 # auto | off : draft config changes when a release needs more than its tag

restore_points:
  keep: 3                    # dumps kept per stateful service

deploy:
  probe: auto                # auto | off : ask a service over HTTP as well as asking docker
  rollback: auto             # auto | suggest | off : what to do when verification fails
  verify_window_s: 300       # how long a deploy has to prove itself
  soak_s: 1800               # a second look this long after; 0 skips it

notify:
  escalate_after_days: 7     # a decision still waiting after this long is announced once more
  sinks: []                  # where decisions and failures go: webhook, email, ntfy

sync:
  push_main: true            # publish the branch shipshape ships to (GIT_BRANCH, default main)
  poll_active_s: 60          # loop interval while work is in flight
  poll_idle_s: 600           # loop interval when idle

# rules: written by the Always ship button.
`
