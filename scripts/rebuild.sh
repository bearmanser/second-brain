#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-second-brain}"
ACKNOWLEDGE="${BRAIN_REBUILD_ACKNOWLEDGE:-}"
REINDEX_MODE="default"
USAGE="usage: rebuild.sh [--acknowledge] [--full] [--embeddings] [--project NAME]"

fail() {
  printf 'rebuild: %s\n' "$1" >&2
  exit 1
}

note() {
  printf 'rebuild: %s\n' "$1" >&2
}

REINDEX_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --acknowledge) ACKNOWLEDGE=yes ;;
    --full) REINDEX_ARGS+=(--full) ;;
    --embeddings) REINDEX_ARGS+=(--embeddings) ;;
    --search) REINDEX_ARGS+=(--search) ;;
    --project) shift; COMPOSE_PROJECT_NAME="${1:-}"; [ -n "$COMPOSE_PROJECT_NAME" ] || fail "--project requires a value" ;;
    --project=*) COMPOSE_PROJECT_NAME="${1#*=}" ;;
    -h | --help) printf '%s\n' "$USAGE"; exit 0 ;;
    -*) fail "unknown option $1" ;;
    *) fail "unexpected argument $1" ;;
  esac
  shift
done

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT_DIR/.env"
  set +a
fi

NODE_IMAGE=""
BASIC_MEMORY_IMAGE=""
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    NODE_IMAGE=*) NODE_IMAGE="${line#NODE_IMAGE=}" ;;
    BASIC_MEMORY_IMAGE=*) BASIC_MEMORY_IMAGE="${line#BASIC_MEMORY_IMAGE=}" ;;
  esac
done < "$ROOT_DIR/config/images.env"
[ -n "$NODE_IMAGE" ] || fail "NODE_IMAGE is missing from config/images.env"
export NODE_IMAGE BASIC_MEMORY_IMAGE

resolve_volume() {
  local key="$1" name
  name="$(docker volume ls -q \
    --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
    --filter "label=com.docker.compose.volume=$key" | head -n1)"
  [ -n "$name" ] || fail "could not resolve the Compose volume for key '$key' in project $COMPOSE_PROJECT_NAME"
  printf '%s' "$name"
}

state_volume="$(resolve_volume brain-state)"

note "checking that the operation journal and feedback store are present"
if ! docker run --rm --user 0:0 -v "$state_volume":/state:ro --entrypoint test "$NODE_IMAGE" -f /state/journal.db; then
  fail "the operation database (journal.db) is missing from volume $state_volume; restore it from a backup before rebuilding — an index rebuild cannot reconstruct retry or feedback history"
fi

if [ "$ACKNOWLEDGE" != "yes" ]; then
  fail "refusing to rebuild without explicit owner acknowledgment: set BRAIN_REBUILD_ACKNOWLEDGE=yes (or pass --acknowledge). An index/catalogue rebuild is not full operational recovery; historical retry and feedback state is preserved only because journal.db is left untouched"
fi

STACK_STOPPED=0
restart_services() {
  if [ "$STACK_STOPPED" = "1" ]; then
    note "restarting the gateway via the exit trap"
    docker compose -p "$COMPOSE_PROJECT_NAME" up -d >&2 || note "warning: the gateway could not be restarted automatically; run docker compose up -d"
  fi
}
trap restart_services EXIT

note "pausing gateway mutations (stopping brain; Basic Memory stays up)"
docker compose -p "$COMPOSE_PROJECT_NAME" stop brain
STACK_STOPPED=1

note "running the supported Basic Memory reindex inside its container"
docker compose -p "$COMPOSE_PROJECT_NAME" exec -T memory basic-memory reindex ${REINDEX_ARGS[@]+"${REINDEX_ARGS[@]}"}

note "rebuilding the gateway catalogue from Markdown (operation journal and feedback are preserved)"
docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps brain rebuild-catalogue

note "confirming the operation journal and feedback tables were preserved"
if docker run --rm --user 0:0 -v "$state_volume":/state:ro --entrypoint node second-brain:local -e '
const Database = require("/app/node_modules/better-sqlite3");
const db = new Database("/state/journal.db", { readonly: true });
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name IN (?, ?)")
  .all("table", "operations", "feedback_records")
  .map((row) => row.name);
db.close();
process.stdout.write(tables.sort().join(","));
' > /dev/null 2>&1; then
  note "operation journal and feedback records are intact"
else
  note "warning: could not verify the preserved tables; confirm journal.db and feedback_records manually"
fi

note "rebuild complete; the catalogue was rebuilt from Markdown, not restored from backup"
note "reminder: this is an index/catalogue rebuild, NOT full operational recovery"
