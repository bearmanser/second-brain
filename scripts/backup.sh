#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-second-brain}"
INCLUDE_SECRETS=0
NOTES_ONLY=0
ASSUME_YES=0
EXCLUDED_VOLUMES=""
DESTINATION=""
POSITIONALS=()
USAGE="usage: backup.sh DESTINATION [--yes] [--notes-only] [--include-secrets] [--exclude-volume NAME[,NAME]] [--project NAME]"

fail() {
  printf 'backup: %s\n' "$1" >&2
  exit 1
}

note() {
  printf 'backup: %s\n' "$1" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --yes | -y) ASSUME_YES=1 ;;
    --notes-only) NOTES_ONLY=1 ;;
    --include-secrets) INCLUDE_SECRETS=1 ;;
    --exclude-volume) shift; EXCLUDED_VOLUMES="${1:-}"; [ -n "$EXCLUDED_VOLUMES" ] || fail "--exclude-volume requires a value" ;;
    --exclude-volume=*) EXCLUDED_VOLUMES="${1#*=}" ;;
    --project) shift; COMPOSE_PROJECT_NAME="${1:-}"; [ -n "$COMPOSE_PROJECT_NAME" ] || fail "--project requires a value" ;;
    --project=*) COMPOSE_PROJECT_NAME="${1#*=}" ;;
    -h | --help) printf '%s\n' "$USAGE"; exit 0 ;;
    -*) fail "unknown option $1" ;;
    *) POSITIONALS+=("$1") ;;
  esac
  shift
done

[ "${#POSITIONALS[@]}" -eq 1 ] || { printf '%s\n' "$USAGE" >&2; exit 2; }
DESTINATION="${POSITIONALS[0]}"
[ -n "$DESTINATION" ] || fail "a destination directory is required"

is_excluded_volume() {
  local candidate="$1" item
  local IFS=','
  for item in $EXCLUDED_VOLUMES; do
    [ -n "$item" ] || continue
    [ "$item" = "$candidate" ] && return 0
  done
  return 1
}

if [ -L "$DESTINATION" ]; then
  fail "destination must not be a symbolic link: $DESTINATION"
fi
if [ -e "$DESTINATION" ]; then
  [ -d "$DESTINATION" ] || fail "destination exists and is not a directory: $DESTINATION"
  [ -z "$(ls -A "$DESTINATION" 2>/dev/null || true)" ] || fail "destination is not new/empty: $DESTINATION"
fi

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  . "$ROOT_DIR/.env"
  set +a
fi

read_images_env() {
  local file="$ROOT_DIR/config/images.env" line
  [ -f "$file" ] || fail "missing pinned image file $file"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      NODE_IMAGE=*) NODE_IMAGE="${line#NODE_IMAGE=}" ;;
      BASIC_MEMORY_IMAGE=*) BASIC_MEMORY_IMAGE="${line#BASIC_MEMORY_IMAGE=}" ;;
    esac
  done < "$file"
  [ -n "${NODE_IMAGE:-}" ] || fail "NODE_IMAGE is missing from $file"
  [ -n "${BASIC_MEMORY_IMAGE:-}" ] || fail "BASIC_MEMORY_IMAGE is missing from $file"
}
NODE_IMAGE=""
BASIC_MEMORY_IMAGE=""
read_images_env
export NODE_IMAGE BASIC_MEMORY_IMAGE

if [ "$ASSUME_YES" != "1" ]; then
  if [ -t 0 ]; then
    printf 'Pause Obsidian edits and external synchronization, then type "yes" to continue: ' >&2
    read -r answer
    [ "$answer" = "yes" ] || fail "aborted; Obsidian/sync must be paused before a cold backup"
  else
    fail "non-interactive run: pause Obsidian edits and external sync first, then re-run with --yes"
  fi
fi

VAULT_PATH="${VAULT_PATH:-./vault}"
[ -d "$VAULT_PATH" ] || fail "vault path does not exist: $VAULT_PATH"
VAULT_ABS="$(cd "$VAULT_PATH" && pwd -P)"

resolve_compose_volumes() {
  local key name
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    name="$(docker volume ls -q \
      --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
      --filter "label=com.docker.compose.volume=$key" | head -n1)"
    [ -n "$name" ] || fail "could not resolve the Compose volume for key '$key' in project $COMPOSE_PROJECT_NAME"
    printf '%s\t%s\n' "$key" "$name"
  done < <(docker compose -p "$COMPOSE_PROJECT_NAME" config --volumes)
}

SELECTED_VOLUMES=()
if [ "$NOTES_ONLY" = "0" ]; then
  while IFS=$'\t' read -r key volume; do
    [ -n "$key" ] || continue
    if is_excluded_volume "$key"; then
      note "excluding named volume $key at the operator's request"
      continue
    fi
    SELECTED_VOLUMES+=("$key"$'\t'"$volume")
  done < <(resolve_compose_volumes)
fi

DESTINATION_PARENT="$(dirname "$DESTINATION")"
[ -d "$DESTINATION_PARENT" ] || fail "destination parent does not exist: $DESTINATION_PARENT"
mkdir -p "$DESTINATION"
DESTINATION="$(cd "$DESTINATION" && pwd -P)"
mkdir -p "$DESTINATION/volumes"

STACK_STOPPED=0
restart_services() {
  if [ "$STACK_STOPPED" = "1" ]; then
    note "restarting both services via the exit trap"
    docker compose -p "$COMPOSE_PROJECT_NAME" up -d >&2 || note "warning: services could not be restarted automatically; run docker compose up -d"
  fi
}
trap restart_services EXIT

RUNNING_SERVICES="$(docker compose -p "$COMPOSE_PROJECT_NAME" ps -q 2>/dev/null || true)"
if [ -n "$RUNNING_SERVICES" ]; then
  note "stopping both services (project $COMPOSE_PROJECT_NAME)"
  STACK_STOPPED=1
  docker compose -p "$COMPOSE_PROJECT_NAME" stop brain memory
else
  note "no running services in project $COMPOSE_PROJECT_NAME; nothing to stop"
fi

snapshot_dir() {
  ( cd "$1" && {
      find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum
      find . -type l -print0 | LC_ALL=C sort -z | while IFS= read -r -d '' link; do
        printf 'L %s -> %s\n' "$link" "$(readlink "$link")"
      done
    } )
}

volume_snapshot() {
  docker run --rm -i --user 0:0 -v "$1":/volume:ro --entrypoint node second-brain:local - <<'VOLUME_SNAPSHOT'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = '/volume';
const lines = [];
const walk = (directory) => {
  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    const info = fs.lstatSync(absolute);
    if (info.isSymbolicLink()) {
      const target = fs.readlinkSync(absolute);
      lines.push(`L ${relative} -> ${target}`);
      continue;
    }
    if (info.isDirectory()) {
      walk(absolute);
      continue;
    }
    if (info.isFile()) {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
      lines.push(`${hash}  ${relative}`);
    }
  }
};
walk(root);
process.stdout.write(lines.join('\n'));
VOLUME_SNAPSHOT
}

if ! docker image inspect second-brain:local >/dev/null 2>&1; then
  fail "the second-brain:local image is required for volume snapshots and the versioned manifest; run scripts/setup.sh"
fi

validate_live_store() {
  docker run --rm --user 0:0 -v "$1":/store:ro --entrypoint node second-brain:local \
    /app/dist/cli.js validate-store-links --root /store --mode "$2"
}

validate_created_archive() {
  local archive="$1" mode="$2" store="$3" relative output
  relative="${archive#"$DESTINATION"/}"
  if [ -n "$ARCHIVE_TEST_INJECT" ]; then
    if ! BRAIN_BACKUP_ARCHIVE="$archive" BRAIN_BACKUP_STORE="$store" sh -c "$ARCHIVE_TEST_INJECT"; then
      rm -f "$archive"
      fail "test archive injection failed for $store"
    fi
  fi
  if ! output="$(docker run --rm --user 0:0 -v "$DESTINATION":/backup:ro --entrypoint node second-brain:local \
    /app/dist/cli.js validate-archive --archive "/backup/$relative" --mode "$mode" 2>&1)"; then
    rm -f "$archive"
    fail "produced archive is inconsistent for $store: $output"
  fi
}

note "validating vault links"
if ! VAULT_LINKS="$(validate_live_store "$VAULT_ABS" vault 2>&1)"; then
  fail "the vault cannot be archived: $VAULT_LINKS"
fi

STORES=("vault")
VOLUME_MAP=""
TEST_INJECT="${BRAIN_BACKUP_TEST_INJECT:-}"
ARCHIVE_TEST_INJECT="${BRAIN_BACKUP_TEST_ARCHIVE_INJECT:-}"

note "archiving the host vault"
BEFORE_VAULT="$(snapshot_dir "$VAULT_ABS")"
if [ -n "$TEST_INJECT" ]; then
  sh -c "$TEST_INJECT"
fi
tar -cf "$DESTINATION/vault.tar" -C "$VAULT_ABS" .
validate_created_archive "$DESTINATION/vault.tar" vault vault
if ! VAULT_LINKS="$(validate_live_store "$VAULT_ABS" vault 2>&1)"; then
  rm -f "$DESTINATION/vault.tar"
  fail "the vault changed into an unsafe state while it was being copied: $VAULT_LINKS"
fi
AFTER_VAULT="$(snapshot_dir "$VAULT_ABS")"
if [ "$BEFORE_VAULT" != "$AFTER_VAULT" ]; then
  rm -f "$DESTINATION/vault.tar"
  fail "the vault changed while it was being copied; aborting because the backup is inconsistent (is Obsidian/sync really paused?)"
fi

if [ "$NOTES_ONLY" = "0" ]; then
  for entry in ${SELECTED_VOLUMES[@]+"${SELECTED_VOLUMES[@]}"}; do
    key="${entry%%$'\t'*}"
    volume="${entry#*$'\t'}"
    note "archiving named volume $key ($volume)"
    if ! LINK_CHECK="$(validate_live_store "$volume" volume 2>&1)"; then
      fail "volume $key ($volume) cannot be archived: $LINK_CHECK"
    fi
    BEFORE="$(volume_snapshot "$volume")"
    docker run --rm --user 0:0 -v "$volume":/volume:ro -v "$DESTINATION/volumes":/backup \
      --entrypoint tar "$NODE_IMAGE" -C /volume -cf "/backup/$key.tar" .
    validate_created_archive "$DESTINATION/volumes/$key.tar" volume "volume $key"
    if ! LINK_CHECK="$(validate_live_store "$volume" volume 2>&1)"; then
      rm -f "$DESTINATION/volumes/$key.tar"
      fail "volume $key ($volume) changed into an unsafe state while it was being copied: $LINK_CHECK"
    fi
    AFTER="$(volume_snapshot "$volume")"
    if [ "$BEFORE" != "$AFTER" ]; then
      rm -f "$DESTINATION/volumes/$key.tar"
      fail "volume $key ($volume) changed while it was being copied; aborting because the backup is inconsistent"
    fi
    STORES+=("$key")
    VOLUME_MAP="${VOLUME_MAP:+$VOLUME_MAP,}$key=$volume"
  done
fi

SENSITIVE=0
if [ "$INCLUDE_SECRETS" = "1" ]; then
  [ -d "$ROOT_DIR/secrets" ] || fail "--include-secrets was requested but secrets/ does not exist"
  note "archiving host token files (labeled sensitive)"
  tar -cf "$DESTINATION/secrets.tar" -C "$ROOT_DIR" secrets
  validate_created_archive "$DESTINATION/secrets.tar" vault secrets
  STORES+=("secrets")
  SENSITIVE=1
fi

note "writing checksums"
( cd "$DESTINATION" && find . -type f ! -name checksums.sha256 ! -name manifest.json -print0 \
  | LC_ALL=C sort -z | xargs -0 -r sha256sum > checksums.sha256 )

STORE_ARG="$(IFS=,; printf '%s' "${STORES[*]}")"
MANIFEST_ARGS=(
  --root /backup
  --out /backup/manifest.json
  --store "$STORE_ARG"
  --image "brain=$NODE_IMAGE,basic-memory=$BASIC_MEMORY_IMAGE"
)
if [ -n "$VOLUME_MAP" ]; then
  MANIFEST_ARGS+=(--volume "$VOLUME_MAP")
fi
if [ "$SENSITIVE" = "1" ]; then
  MANIFEST_ARGS+=(--sensitive)
fi

note "writing the versioned manifest"
docker run --rm --user 0:0 -v "$DESTINATION":/backup --entrypoint node second-brain:local \
  /app/dist/cli.js backup-manifest "${MANIFEST_ARGS[@]}"

note "backup complete: $DESTINATION ($(IFS=,; printf '%s' "${STORES[*]}"))"
if [ "$SENSITIVE" = "1" ]; then
  note "this backup includes host token files and is labeled sensitive; protect it accordingly"
fi
