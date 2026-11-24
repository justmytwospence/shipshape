#!/usr/bin/env bash
# Smoke-tests a built shipshape image without a compose repository or a docker daemon
# inside it: it starts, reports healthy, loads its native module, and carries the tools
# it shells out to. Usage: smoke-image.sh <image> <platform>
set -euo pipefail
image=$1
platform=$2
name="smoke-${platform//\//-}-$$"
data=$(mktemp -d)
chmod 0777 "$data"
cleanup() { docker rm -f "$name" "$name-ro" >/dev/null 2>&1 || true; rm -rf "$data"; }
trap cleanup EXIT
run() { docker run --rm --platform "$platform" "$@"; }

wait_healthy() {
  for _ in $(seq 1 90); do
    case "$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null || echo gone)" in
      healthy) return 0 ;;
      gone) docker logs "$1" || true; echo "::error::$1 exited"; return 1 ;;
    esac
    sleep 2
  done
  docker logs "$1" || true
  echo "::error::$1 did not become healthy"
  return 1
}

echo "-- tools"
run "$image" node -v
run "$image" git --version
run "$image" docker --version
run "$image" docker compose version
run "$image" docker buildx version
run "$image" sqlite3 --version

echo "-- better-sqlite3 loads the prebuilt binary for this platform"
run --entrypoint node "$image" -e \
  "const D=require('/app/node_modules/better-sqlite3'); console.log('sqlite', new D(':memory:').prepare('select sqlite_version() v').get().v)"

echo "-- version and revision"
got=$(run --entrypoint node "$image" --input-type=module -e \
  "const m = await import('/app/dist/version.js'); console.log(m.version(), m.revision() ?? '-')")
echo "$got"
case "$got" in
  "0.0.0-dev "*|"unknown "*) echo "::error::the image does not know its version"; exit 1 ;;
esac

echo "-- starts as the default user and reports healthy"
docker run -d --name "$name" --platform "$platform" --health-interval 2s "$image" >/dev/null
wait_healthy "$name"
docker exec "$name" wget -qO- http://127.0.0.1:8080/health
echo

echo "-- starts as an arbitrary uid on a read-only root filesystem"
docker run -d --name "$name-ro" --platform "$platform" --health-interval 2s \
  --user 1234:1234 --read-only --tmpfs /tmp -v "$data:/data" "$image" >/dev/null
wait_healthy "$name-ro"
test -f "$data/shipshape.db"

echo "-- stops within the grace period"
start=$(date +%s)
docker stop -t 15 "$name" >/dev/null
elapsed=$(( $(date +%s) - start ))
echo "stopped in ${elapsed}s"
[ "$elapsed" -lt 10 ] || { echo "::error::stop took ${elapsed}s"; exit 1; }
echo "smoke test passed: $image ($platform)"
