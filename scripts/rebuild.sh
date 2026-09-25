#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-second-brain}"
ACKNOWLEDGE="${BRAIN_REBUILD_ACKNOWLEDGE:-}"
ACCEPT_LOSS="${BRAIN_REBUILD_ACCEPT_OPERATIONAL_LOSS:-}"
USAGE="usage: rebuild.sh [--acknowledge] [--accept-operational-loss] [--project NAME]"

fail() {
  printf 'rebuild: %s\n' "$1" >&2
  exit 1
}

note() {
  printf 'rebuild: %s\n' "$1" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --acknowledge) ACKNOWLEDGE=yes ;;
    --accept-operational-loss) ACCEPT_LOSS=yes ;;
    --project) shift; COMPOSE_PROJECT_NAME="${1:-}"; [ -n "$COMPOSE_PROJECT_NAME" ] || fail "--project requires a value" ;;
    --project=*) COMPOSE_PROJECT_NAME="${1#*=}" ;;
    -h | --help) printf '%s\n' "$USAGE"; exit 0 ;;
    *) fail "unknown or unsupported option $1" ;;
  esac
  shift
done

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  . "$ROOT_DIR/.env"
  set +a
fi

if [ -z "${NODE_IMAGE:-}" ] && [ -f "$ROOT_DIR/config/images.env" ]; then
  NODE_IMAGE="$(sed -n 's/^NODE_IMAGE=//p' "$ROOT_DIR/config/images.env" | head -n1)"
fi
[ -n "${NODE_IMAGE:-}" ] || fail "NODE_IMAGE could not be resolved from .env or config/images.env"
export NODE_IMAGE

resolve_volume() {
  local key="$1" name
  name="$(docker volume ls -q \
    --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
    --filter "label=com.docker.compose.volume=$key" | head -n1)"
  [ -n "$name" ] || fail "could not resolve the Compose volume for key '$key' in project $COMPOSE_PROJECT_NAME"
  printf '%s' "$name"
}

state_volume="$(resolve_volume brain-state)"

JOURNAL_LOST=0
note "checking that the durable operation journal is present"
if ! docker run --rm --user 0:0 -v "$state_volume":/state:ro --entrypoint test "$NODE_IMAGE" -f /state/journal.db; then
  if [ "$ACCEPT_LOSS" != "yes" ]; then
    fail "the operation database (journal.db) is missing from volume $state_volume; restore it from a backup first, or re-run with --accept-operational-loss to permanently discard retry and feedback history"
  fi
  JOURNAL_LOST=1
  note "WARNING: journal.db is missing and operational loss was explicitly accepted; retry and feedback history is permanently discarded and this rebuild is NOT full operational recovery"
fi

if [ "$ACKNOWLEDGE" != "yes" ]; then
  fail "refusing to rebuild without explicit owner acknowledgment: set BRAIN_REBUILD_ACKNOWLEDGE=yes (or pass --acknowledge). An index/catalogue rebuild is not full operational recovery"
fi

BRAIN_RUNNING=0
if [ -n "$(docker compose -p "$COMPOSE_PROJECT_NAME" ps -q brain 2>/dev/null || true)" ]; then
  BRAIN_RUNNING=1
fi

restart_services() {
  if [ "$BRAIN_RUNNING" = "1" ]; then
    note "restarting the gateway via the exit trap"
    docker compose -p "$COMPOSE_PROJECT_NAME" up -d >&2 || note "warning: the gateway could not be restarted automatically; run docker compose up -d"
  fi
}
trap restart_services EXIT

if [ "$BRAIN_RUNNING" = "1" ]; then
  note "pausing gateway mutations (stopping the application container)"
  docker compose -p "$COMPOSE_PROJECT_NAME" stop brain
else
  note "the gateway is not running; no pause needed"
fi

if [ "$JOURNAL_LOST" = "1" ]; then
  note "rebuilding the current catalogue from Markdown with a freshly initialized operation journal"
  if ! REBUILD_OUTPUT="$(docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps brain rebuild-catalogue --accept-operational-loss 2>&1)"; then
    fail "the catalogue rebuild failed: $REBUILD_OUTPUT"
  fi
  printf '%s\n' "$REBUILD_OUTPUT" >&2
fi

note "rebuilding the disposable search index from current Markdown"
if ! INDEX_OUTPUT="$(docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps brain rebuild-index 2>&1)"; then
  fail "the search index rebuild failed: $INDEX_OUTPUT"
fi
printf '%s\n' "$INDEX_OUTPUT" >&2
printf '%s' "$INDEX_OUTPUT" | grep -q 'index rebuilt' || fail "the search index rebuild did not report success"

note "rebuild complete; the search index was rebuilt from Markdown, not restored from backup"
note "reminder: this is an index/catalogue rebuild, NOT full operational recovery"
