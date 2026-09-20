#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-second-brain}"
ACKNOWLEDGE="${BRAIN_REBUILD_ACKNOWLEDGE:-}"
ACCEPT_LOSS="${BRAIN_REBUILD_ACCEPT_OPERATIONAL_LOSS:-}"
USAGE="usage: rebuild.sh [--acknowledge] [--accept-operational-loss] [--full] [--embeddings] [--search] [--project NAME]"

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
    --accept-operational-loss) ACCEPT_LOSS=yes ;;
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

JOURNAL_LOST=0
note "checking that the operation journal and feedback store are present"
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

VAULT_PATH="${VAULT_PATH:-./vault}"
[ -d "$VAULT_PATH" ] || fail "vault path does not exist: $VAULT_PATH"
VAULT_ABS="$(cd "$VAULT_PATH" && pwd -P)"
MARKDOWN_COUNT="$(find "$VAULT_ABS" -type f -name '*.md' -exec grep -l '^brain_revision_id:' {} + 2>/dev/null | wc -l | tr -d ' ')"
note "Markdown revision files visible before rebuild: $MARKDOWN_COUNT"

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
  note "pausing gateway mutations (stopping brain; Basic Memory stays up)"
  docker compose -p "$COMPOSE_PROJECT_NAME" stop brain
else
  note "the gateway is not running; no pause needed"
fi

note "running the supported Basic Memory reindex inside its container"
if ! REINDEX_OUTPUT="$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T memory basic-memory reindex ${REINDEX_ARGS[@]+"${REINDEX_ARGS[@]}"} 2>&1)"; then
  fail "the Basic Memory reindex failed: $REINDEX_OUTPUT"
fi
printf '%s\n' "$REINDEX_OUTPUT" >&2

OBSERVED="$(printf '%s' "$REINDEX_OUTPUT" | grep -o 'project index: [0-9]\+ observed' | awk '{print $3}' | awk '{s+=$1} END {print s+0}')"
if [ "$OBSERVED" -lt "$MARKDOWN_COUNT" ]; then
  fail "rebuilt index observed $OBSERVED files but the vault contains $MARKDOWN_COUNT Markdown revisions"
fi
printf '%s' "$REINDEX_OUTPUT" | grep -q 'Reindex complete!' || fail "the Basic Memory reindex did not report completion"
note "rebuilt index observed $OBSERVED files"

if [ "$MARKDOWN_COUNT" -gt 0 ]; then
  if ! INDEX_STATUS="$(docker compose -p "$COMPOSE_PROJECT_NAME" exec -T memory basic-memory status 2>&1)"; then
    fail "the rebuilt Basic Memory index could not be inspected: $INDEX_STATUS"
  fi
  printf '%s\n' "$INDEX_STATUS" >&2
else
  note "no Markdown revisions are present; skipping the Basic Memory status inspection"
fi

note "rebuilding the gateway catalogue from Markdown (operation journal and feedback are preserved)"
if ! REBUILD_OUTPUT="$(docker compose -p "$COMPOSE_PROJECT_NAME" run --rm --no-deps brain rebuild-catalogue 2>&1)"; then
  fail "the gateway catalogue rebuild failed: $REBUILD_OUTPUT"
fi
printf '%s\n' "$REBUILD_OUTPUT" >&2

SCANNED="$(printf '%s' "$REBUILD_OUTPUT" | grep -o 'scanned [0-9]\+' | grep -o '[0-9]\+' | head -n1 || true)"
CONFLICTS="$(printf '%s' "$REBUILD_OUTPUT" | grep -o 'conflicts [0-9]\+' | grep -o '[0-9]\+' | head -n1 || true)"
MALFORMED="$(printf '%s' "$REBUILD_OUTPUT" | grep -o 'malformed [0-9]\+' | grep -o '[0-9]\+' | head -n1 || true)"
UNSUPPORTED="$(printf '%s' "$REBUILD_OUTPUT" | grep -o 'unsupported [0-9]\+' | grep -o '[0-9]\+' | head -n1 || true)"
[ -n "$SCANNED" ] || fail "the catalogue rebuild did not report a scanned count"
[ -n "$CONFLICTS" ] || fail "the catalogue rebuild did not report a conflict count"
[ -n "$MALFORMED" ] || fail "the catalogue rebuild did not report a malformed count"
[ -n "$UNSUPPORTED" ] || fail "the catalogue rebuild did not report an unsupported-schema count"

if [ "$SCANNED" != "$MARKDOWN_COUNT" ]; then
  fail "catalogue rebuild is inconsistent: scanned $SCANNED Markdown revisions but found $MARKDOWN_COUNT revision files"
fi
if [ "$CONFLICTS" != "0" ] || [ "$MALFORMED" != "0" ] || [ "$UNSUPPORTED" != "0" ]; then
  fail "catalogue rebuild found head-graph problems (conflicts $CONFLICTS, malformed $MALFORMED, unsupported $UNSUPPORTED); resolve them before relying on the rebuild"
fi

if [ "$JOURNAL_LOST" = "0" ]; then
  note "confirming the operation journal and feedback tables were preserved"
  if ! PRESERVE_OUTPUT="$(docker run --rm -i --user 0:0 -v "$state_volume":/state:ro --entrypoint node second-brain:local - <<'JOURNAL_CHECK'
const fs = require('node:fs');
const Database = require('/app/node_modules/better-sqlite3');
const directory = '/tmp/journal-check';
fs.mkdirSync(directory, { recursive: true });
for (const name of ['journal.db', 'journal.db-wal', 'journal.db-shm']) {
  const source = `/state/${name}`;
  if (fs.existsSync(source)) fs.copyFileSync(source, `${directory}/${name}`);
}
const db = new Database(`${directory}/journal.db`, { readonly: true });
const tables = db
  .prepare('SELECT name FROM sqlite_master WHERE type = ? AND name IN (?, ?)')
  .all('table', 'operations', 'feedback_records')
  .map((row) => row.name);
db.close();
process.stdout.write(tables.sort().join(','));
JOURNAL_CHECK
  )"; then
    fail "could not confirm the operation journal and feedback records survived the rebuild: $PRESERVE_OUTPUT"
  fi
  [ "$PRESERVE_OUTPUT" = "feedback_records,operations" ] || fail "the operation journal and feedback tables are incomplete after the rebuild: $PRESERVE_OUTPUT"
  note "operation journal and feedback records are intact"
else
  note "WARNING: journal.db was missing; retry and feedback history is gone, and this rebuild is not full operational recovery"
fi

note "rebuild complete; the catalogue was rebuilt from Markdown, not restored from backup"
note "reminder: this is an index/catalogue rebuild, NOT full operational recovery"
