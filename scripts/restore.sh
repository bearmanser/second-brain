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

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  . "$ROOT_DIR/.env"
  set +a
fi
BRAIN_UID="${BRAIN_UID:-1000}"
BRAIN_GID="${BRAIN_GID:-1000}"

[ -d "$BACKUP" ] || fail "backup directory does not exist: $BACKUP"
BACKUP="$(cd "$BACKUP" && pwd -P)"
[ -f "$BACKUP/manifest.json" ] || fail "backup has no manifest.json: $BACKUP"

read_number_field() {
  local file="$1" key="$2" value
  value="$(grep -o "\"$key\"[[:space:]]*:[[:space:]]*[0-9]\+" "$file" | head -n1 | grep -o '[0-9]\+$' || true)"
  [ -n "$value" ] || return 1
  printf '%s' "$value"
}

run_verifier() {
  local manifest="$1" root="$2"
  if [ -n "${BRAIN_VERIFY_COMMAND:-}" ]; then
    ( cd "$ROOT_DIR" && $BRAIN_VERIFY_COMMAND verify-backup --root "$root" --manifest "$manifest" )
    return
  fi
  if [ -f "$ROOT_DIR/dist/cli.js" ] && command -v node >/dev/null 2>&1; then
    node "$ROOT_DIR/dist/cli.js" verify-backup --root "$root" --manifest "$manifest"
    return
  fi
  if command -v npx >/dev/null 2>&1 && [ -d "$ROOT_DIR/node_modules/tsx" ]; then
    ( cd "$ROOT_DIR" && npx --no-install tsx src/cli.ts verify-backup --root "$root" --manifest "$manifest" )
    return
  fi
  if command -v docker >/dev/null 2>&1 && docker image inspect second-brain:local >/dev/null 2>&1; then
    docker run --rm -v "$root":/backup --entrypoint node second-brain:local \
      /app/dist/cli.js verify-backup --root /backup --manifest "/backup/$(basename "$manifest")"
    return
  fi
  fail "no manifest verifier is available; run npm run build or set BRAIN_VERIFY_COMMAND"
}

FORMAT_VERSION="$(read_number_field "$BACKUP/manifest.json" format_version || true)"
[ -n "$FORMAT_VERSION" ] || fail "backup manifest.json has no readable format_version"
[ "$FORMAT_VERSION" = "$BACKUP_FORMAT" ] || fail "unsupported backup format version $FORMAT_VERSION (this release supports $BACKUP_FORMAT)"

STATE_SCHEMA="$(grep -o '"schema"[[:space:]]*:[[:space:]]*[0-9]\+' "$BACKUP/manifest.json" | head -n1 | grep -o '[0-9]\+$' || true)"
[ -n "$STATE_SCHEMA" ] || fail "backup manifest.json has no readable application-state schema version"
[ "$STATE_SCHEMA" -le "$CURRENT_STATE_SCHEMA" ] || fail "backup state schema version $STATE_SCHEMA is newer than this release supports ($CURRENT_STATE_SCHEMA)"

note "verifying every file declared in the manifest"
if ! VERIFY_OUTPUT="$(run_verifier "$BACKUP/manifest.json" "$BACKUP" 2>&1)"; then
  fail "the TypeScript backup verifier rejected the manifest or its files: $VERIFY_OUTPUT"
fi

if [ -f "$BACKUP/checksums.sha256" ]; then
  if ! (cd "$BACKUP" && sha256sum --strict -c checksums.sha256 >/dev/null 2>&1); then
    fail "checksum verification failed; the backup is corrupt or incomplete"
  fi
fi

validate_volume_links() {
  local root link target
  root="$(cd "$1" && pwd -P)"
  while IFS= read -r -d '' link; do
    target="$(readlink -f "$link" 2>/dev/null || true)"
    if [ -z "$target" ]; then
      printf 'restore: broken symbolic link in a restored volume: %s\n' "$link" >&2
      return 1
    fi
    case "$target" in
      "$root" | "$root"/*) ;;
      *)
        printf 'restore: symbolic link escapes the restored volume: %s -> %s\n' "$link" "$target" >&2
        return 1
        ;;
    esac
  done < <(find "$root" -type l -print0)
  return 0
}

verify_archive() {
  local archive="$1" mode="$2" member
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
    if [ "$mode" = "vault" ]; then
      fail "the vault archive contains a symbolic link member: $archive"
    fi
  fi
}

shopt -s nullglob
ARCHIVES=("$BACKUP"/*.tar "$BACKUP"/volumes/*.tar)
shopt -u nullglob
[ "${#ARCHIVES[@]}" -gt 0 ] || fail "backup contains no archives"

declared_archive() {
  local relative="$1"
  grep -F '"path"' "$BACKUP/manifest.json" | grep -Fq "\"$relative\""
}

for archive in "${ARCHIVES[@]}"; do
  relative="${archive#"$BACKUP"/}"
  declared_archive "$relative" || fail "backup contains an undeclared archive: $relative"
  mode="other"
  [ "$relative" = "vault.tar" ] && mode="vault"
  case "$relative" in
    volumes/*.tar) mode="volume" ;;
  esac
  verify_archive "$archive" "$mode"
  if [ "$mode" = "volume" ] && tar -tvf "$archive" | grep -Eq '^l'; then
    temporary="$(mktemp -d)"
    if ! tar -xf "$archive" -C "$temporary" --no-same-owner --no-same-permissions; then
      rm -rf "$temporary"
      fail "a named-volume archive could not be inspected: $relative"
    fi
    if ! validate_volume_links "$temporary" >/dev/null 2>&1; then
      validate_volume_links "$temporary" || true
      rm -rf "$temporary"
      fail "a named-volume archive contains a symbolic link that escapes the volume root: $relative"
    fi
    rm -rf "$temporary"
  fi
done

if [ -e "$NEW_ROOT" ] || [ -L "$NEW_ROOT" ]; then
  fail "destination already exists; restore extracts only into a fresh root: $NEW_ROOT"
fi
NEW_ROOT_PARENT="$(dirname "$NEW_ROOT")"
[ -d "$NEW_ROOT_PARENT" ] || fail "destination parent does not exist: $NEW_ROOT_PARENT"
if [ -L "$NEW_ROOT_PARENT" ]; then
  fail "destination parent is a symbolic link: $NEW_ROOT_PARENT"
fi
[ -w "$NEW_ROOT_PARENT" ] || fail "destination parent is not writable: $NEW_ROOT_PARENT"

FILE_COUNT="$(grep -c '"path"' "$BACKUP/manifest.json" || true)"
note "backup is valid (format=$FORMAT_VERSION schema=$STATE_SCHEMA files=$FILE_COUNT)"

if [ "$CHECK" = "1" ]; then
  note "ok: --check completed without extracting or starting services"
  exit 0
fi

[ "$ACKNOWLEDGE" = "1" ] || fail "restoring writes a new root; re-run with --acknowledge to proceed"

note "extracting into fresh root $NEW_ROOT"
mkdir "$NEW_ROOT"
if [ -f "$BACKUP/vault.tar" ]; then
  mkdir -p "$NEW_ROOT/vault"
  tar -xf "$BACKUP/vault.tar" -C "$NEW_ROOT/vault" --no-same-owner --no-same-permissions
fi
for archive in "$BACKUP"/volumes/*.tar; do
  [ -e "$archive" ] || continue
  key="$(basename "$archive" .tar)"
  mkdir -p "$NEW_ROOT/volumes/$key"
  tar -xf "$archive" -C "$NEW_ROOT/volumes/$key" --no-same-owner --no-same-permissions
  if ! validate_volume_links "$NEW_ROOT/volumes/$key"; then
    rm -rf "$NEW_ROOT"
    fail "the restored volume $key contains a symbolic link that escapes its root; the restore was discarded"
  fi
done
if [ -f "$BACKUP/secrets.tar" ]; then
  mkdir -p "$NEW_ROOT/secrets"
  tar -xf "$BACKUP/secrets.tar" -C "$NEW_ROOT/secrets" --no-same-owner --no-same-permissions
  chmod 700 "$NEW_ROOT/secrets" 2>/dev/null || true
fi

if [ "$(id -u)" = "0" ]; then
  chown -R "$BRAIN_UID:$BRAIN_GID" "$NEW_ROOT"
else
  note "not running as root; ensure $NEW_ROOT is writable by uid $BRAIN_UID before starting the restored stack"
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
  printf '    ports: !override\n'
  printf '      - "127.0.0.1:%s:7331"\n' "$PORT"
  printf '    volumes: !override\n'
  printf '      - %s:/vault:ro\n' "$NEW_ROOT/vault"
  printf '      - %s:/var/lib/second-brain\n' "$NEW_ROOT/volumes/brain-state"
  printf '      - %s/config/brain.yaml:/run/brain/brain.yaml:ro\n' "$ROOT_DIR"
  printf '  memory:\n'
  printf '    volumes: !override\n'
  printf '      - %s:/app/data\n' "$NEW_ROOT/vault"
  if [ -d "$NEW_ROOT/volumes/memory-state" ]; then
    printf '      - %s:/home/appuser/.basic-memory\n' "$NEW_ROOT/volumes/memory-state"
  fi
  if [ -d "$NEW_ROOT/volumes/model-cache" ]; then
    printf '      - %s:/home/appuser/.basic-memory/fastembed_cache\n' "$NEW_ROOT/volumes/model-cache"
  fi
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
  note "the restored stack is not healthy; recent service state and logs follow"
  docker compose -p "$PROJECT" -f compose.yaml -f "$OVERRIDE" ps >&2 || true
  docker compose -p "$PROJECT" -f compose.yaml -f "$OVERRIDE" logs --no-color --tail 120 >&2 || true
  fail "the restored stack did not become healthy; the working deployment was not switched"
fi

note "the restored stack is healthy on port $PORT"
note "review it, then switch by stopping the current project and re-running with --project $COMPOSE_PROJECT_NAME and the restored vault"
