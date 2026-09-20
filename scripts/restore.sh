#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-second-brain}"
CURRENT_STATE_SCHEMA="${BRAIN_STATE_SCHEMA:-1}"
BACKUP_FORMAT="${BRAIN_BACKUP_FORMAT:-1}"
CHECK=0
ACKNOWLEDGE=0
START_STACK=0
PROJECT=""
PORT=""
POSITIONALS=()

USAGE="usage: restore.sh BACKUP NEW_ROOT [--check] [--acknowledge] [--start] [--project NAME] [--port N]"

fail() {
  printf 'restore: %s\n' "$1" >&2
  exit 1
}

note() {
  printf 'restore: %s\n' "$1"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --acknowledge) ACKNOWLEDGE=1 ;;
    --no-start) START_STACK=0 ;;
    --start) START_STACK=1 ;;
    --project) shift; PROJECT="${1:-}"; [ -n "$PROJECT" ] || fail "--project requires a value" ;;
    --project=*) PROJECT="${1#*=}" ;;
    --port) shift; PORT="${1:-}"; [ -n "$PORT" ] || fail "--port requires a value" ;;
    --port=*) PORT="${1#*=}" ;;
    -h | --help) printf '%s\n' "$USAGE"; exit 0 ;;
    -*) fail "unknown option $1" ;;
    *) POSITIONALS+=("$1") ;;
  esac
  shift
done

if [ "${#POSITIONALS[@]}" -lt 2 ]; then
  printf '%s\n' "$USAGE" >&2
  exit 2
fi

BACKUP="${POSITIONALS[0]}"
NEW_ROOT="${POSITIONALS[1]}"
PROJECT="${PROJECT:-${COMPOSE_PROJECT_NAME}-restore}"
PORT="${PORT:-17551}"

[ -d "$BACKUP" ] || fail "backup directory does not exist: $BACKUP"
BACKUP="$(cd "$BACKUP" && pwd -P)"
[ -f "$BACKUP/manifest.json" ] || fail "backup has no manifest.json: $BACKUP"
[ -f "$BACKUP/checksums.sha256" ] || fail "backup has no checksums.sha256: $BACKUP"

read_number_field() {
  local file="$1" key="$2" value
  value="$(grep -o "\"$key\"[[:space:]]*:[[:space:]]*[0-9]\+" "$file" | head -n1 | grep -o '[0-9]\+$' || true)"
  [ -n "$value" ] || return 1
  printf '%s' "$value"
}

FORMAT_VERSION="$(read_number_field "$BACKUP/manifest.json" format_version || true)"
[ -n "$FORMAT_VERSION" ] || fail "backup manifest.json has no readable format_version"
[ "$FORMAT_VERSION" = "$BACKUP_FORMAT" ] || fail "unsupported backup format version $FORMAT_VERSION (this release supports $BACKUP_FORMAT)"

STATE_SCHEMA="$(grep -o '"schema"[[:space:]]*:[[:space:]]*[0-9]\+' "$BACKUP/manifest.json" | head -n1 | grep -o '[0-9]\+$' || true)"
[ -n "$STATE_SCHEMA" ] || fail "backup manifest.json has no readable application-state schema version"
[ "$STATE_SCHEMA" -le "$CURRENT_STATE_SCHEMA" ] || fail "backup state schema version $STATE_SCHEMA is newer than this release supports ($CURRENT_STATE_SCHEMA)"

note "verifying stored file hashes"
if ! (cd "$BACKUP" && sha256sum --strict -c checksums.sha256 >/dev/null 2>&1); then
  fail "checksum verification failed; the backup is corrupt or incomplete"
fi

verify_archive() {
  local archive="$1" member
  [ -f "$archive" ] || fail "backup archive is missing: $archive"
  while IFS= read -r member; do
    [ -n "$member" ] || continue
    case "$member" in
      /* | \\* | [A-Za-z]:[\\/]*) fail "archive member is an absolute path: $member" ;;
    esac
    case "/$member/" in
      */../*) fail "archive member contains traversal: $member" ;;
    esac
  done < <(tar -tf "$archive")
  if tar -tvf "$archive" | grep -Eq '^l'; then
    fail "archive contains a symbolic link (symlink) member: $archive"
  fi
}

shopt -s nullglob
ARCHIVES=("$BACKUP"/*.tar "$BACKUP"/volumes/*.tar)
shopt -u nullglob
[ "${#ARCHIVES[@]}" -gt 0 ] || fail "backup contains no archives"

for archive in "${ARCHIVES[@]}"; do
  verify_archive "$archive"
done

if [ -e "$NEW_ROOT" ] && [ -n "$(ls -A "$NEW_ROOT" 2>/dev/null || true)" ]; then
  fail "destination already exists and is not empty: $NEW_ROOT"
fi

FILE_COUNT="$(grep -c '"path"' "$BACKUP/manifest.json" || true)"
note "backup is valid (format=$FORMAT_VERSION schema=$STATE_SCHEMA files=$FILE_COUNT)"

if [ "$CHECK" = "1" ]; then
  note "ok: --check completed without extracting or starting services"
  exit 0
fi

[ "$ACKNOWLEDGE" = "1" ] || fail "restoring writes a new root; re-run with --acknowledge to proceed"

note "extracting into fresh root $NEW_ROOT"
mkdir -p "$NEW_ROOT"
if [ -f "$BACKUP/vault.tar" ]; then
  mkdir -p "$NEW_ROOT/vault"
  tar -xf "$BACKUP/vault.tar" -C "$NEW_ROOT/vault" --no-same-owner --no-same-permissions
fi
for archive in "$BACKUP"/volumes/*.tar; do
  [ -e "$archive" ] || continue
  name="$(basename "$archive" .tar)"
  mkdir -p "$NEW_ROOT/volumes/$name"
  tar -xf "$archive" -C "$NEW_ROOT/volumes/$name" --no-same-owner --no-same-permissions
done
if [ -f "$BACKUP/secrets.tar" ]; then
  mkdir -p "$NEW_ROOT/secrets"
  tar -xf "$BACKUP/secrets.tar" -C "$NEW_ROOT/secrets" --no-same-owner --no-same-permissions
  chmod 700 "$NEW_ROOT/secrets" 2>/dev/null || true
fi

if [ "$START_STACK" != "1" ]; then
  note "restored into $NEW_ROOT"
  note "review the restored data; to smoke-test the restored stack under a separate project/port run:"
  note "  scripts/restore.sh '$BACKUP' '$NEW_ROOT' --acknowledge --start --project '$PROJECT' --port '$PORT'"
  exit 0
fi

[ -d "$NEW_ROOT/vault" ] || fail "the backup has no vault archive; nothing to smoke-test"
[ -d "$NEW_ROOT/volumes/brain-state" ] || fail "the backup has no brain-state volume; a gateway cannot be smoke-tested without its operation database"

note "starting the restored stack as Compose project $PROJECT on port $PORT before switching"
OVERRIDE="$(mktemp)"
{
  printf 'services:\n'
  printf '  brain:\n'
  printf '    ports:\n      - "127.0.0.1:%s:7331"\n' "$PORT"
  printf '    volumes: !reset\n'
  printf '      - %s:/vault:ro\n' "$NEW_ROOT/vault"
  printf '      - %s:/var/lib/second-brain\n' "$NEW_ROOT/volumes/brain-state"
  printf '      - ./config/brain.yaml:/run/brain/brain.yaml:ro\n'
  printf '  memory:\n'
  printf '    volumes: !reset\n'
  printf '      - %s:/app/data\n' "$NEW_ROOT/vault"
  if [ -d "$NEW_ROOT/volumes/memory-state" ]; then
    printf '      - %s:/home/appuser/.basic-memory\n' "$NEW_ROOT/volumes/memory-state"
  fi
  if [ -d "$NEW_ROOT/volumes/model-cache" ]; then
    printf '      - %s:/home/appuser/.basic-memory/fastembed_cache\n' "$NEW_ROOT/volumes/model-cache"
  fi
  printf 'volumes: !reset []\n'
} > "$OVERRIDE"

cleanup_stack() {
  docker compose -p "$PROJECT" -f compose.yaml -f "$OVERRIDE" down -v >/dev/null 2>&1 || true
  rm -f "$OVERRIDE"
}
trap cleanup_stack EXIT

VAULT_PATH="$NEW_ROOT/vault" docker compose -p "$PROJECT" -f compose.yaml -f "$OVERRIDE" up -d --build

deadline=$((SECONDS + 300))
healthy=0
while [ "$SECONDS" -lt "$deadline" ]; do
  if docker compose -p "$PROJECT" -f compose.yaml -f "$OVERRIDE" exec -T brain node dist/cli.js health >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 5
done

if [ "$healthy" != "1" ]; then
  fail "the restored stack did not become healthy; the working deployment was not switched"
fi

note "the restored stack is healthy on port $PORT"
note "review it, then switch by stopping the current project and re-running with --project $COMPOSE_PROJECT_NAME and the restored vault"
