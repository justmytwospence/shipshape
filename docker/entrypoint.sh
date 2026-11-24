#!/bin/sh
# Trust exactly the two repositories shipshape runs git in, whatever uid it runs as.
#
# git refuses a repository owned by another uid ("dubious ownership") unless
# `safe.directory` names it in protected configuration. The image used to set
# `safe.directory '*'` system-wide; this names only the compose checkout (REPO_DIR)
# and shipshape's own work clone, through git's environment configuration
# (GIT_CONFIG_COUNT/KEY_n/VALUE_n, the "command" scope), which every git process
# shipshape starts inherits -- including the one that reads the branch at startup.
# Nothing is written to disk, so the root filesystem can stay read-only.
set -eu

n=${GIT_CONFIG_COUNT:-0}
trust() {
  dir=${1%/}
  [ -n "$dir" ] || return 0
  export "GIT_CONFIG_KEY_$n=safe.directory" "GIT_CONFIG_VALUE_$n=$dir"
  n=$((n + 1))
}
trust "${REPO_DIR:-}"
trust "${DATA_DIR:-/data}/repo"
export GIT_CONFIG_COUNT="$n"

exec "$@"
