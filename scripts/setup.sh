#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BRAIN_UID="${BRAIN_UID:-}"
BRAIN_GID="${BRAIN_GID:-}"
BRAIN_SCOPE="${BRAIN_SCOPE:-freellmapi}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-second-brain}"
IMAGES_FILE="$ROOT_DIR/config/images.env"

fail() {
  printf 'setup: %s\n' "$1" >&2
  exit 1
}

NODE_IMAGE=""
BASIC_MEMORY_IMAGE=""

parse_images_env() {
  local file="$1"
  [ -f "$file" ] || fail "missing pinned image file $file"
  local raw line key value
  while IFS= read -r raw || [ -n "$raw" ]; do
    line="${raw%$'\r'}"
    case "$line" in
      '' | '#'*) continue ;;
    esac
    case "$line" in
      *=*) ;;
      *) fail "rejected line in $file: $line" ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      NODE_IMAGE)
        [ -z "$NODE_IMAGE" ] || fail "duplicate NODE_IMAGE in $file"
        NODE_IMAGE="$value"
        ;;
      BASIC_MEMORY_IMAGE)
        [ -z "$BASIC_MEMORY_IMAGE" ] || fail "duplicate BASIC_MEMORY_IMAGE in $file"
        BASIC_MEMORY_IMAGE="$value"
        ;;
      *) fail "unexpected key '$key' in $file (only NODE_IMAGE and BASIC_MEMORY_IMAGE are allowed)" ;;
    esac
    case "$value" in
      '' ) fail "empty value for $key in $file" ;;
      *[!A-Za-z0-9._:@/+-]*) fail "rejected shell syntax or unsafe character in $key" ;;
    esac
  done < "$file"
  [ -n "$NODE_IMAGE" ] || fail "NODE_IMAGE is missing from $file"
  [ -n "$BASIC_MEMORY_IMAGE" ] || fail "BASIC_MEMORY_IMAGE is missing from $file"
  case "$NODE_IMAGE" in
    *@sha256:*) ;;
    *) fail "NODE_IMAGE must be digest-pinned" ;;
  esac
  case "$BASIC_MEMORY_IMAGE" in
    *@sha256:*) ;;
    *) fail "BASIC_MEMORY_IMAGE must be digest-pinned" ;;
  esac
  case "$NODE_IMAGE$BASIC_MEMORY_IMAGE" in
    *:latest*) fail "floating 'latest' references are not allowed" ;;
  esac
}

read_env_value() {
  local name="$1"
  [ -f "$ROOT_DIR/.env" ] || return 0
  local line
  line="$(grep -E "^${name}=" "$ROOT_DIR/.env" | tail -n 1 || true)"
  [ -n "$line" ] || return 0
  printf '%s' "${line#*=}"
}

write_env_file() {
  local vault="$1" port="$2"
  local tmp existing_vault existing_port
  tmp="$(mktemp)"
  existing_vault="$(read_env_value VAULT_PATH)"
  existing_port="$(read_env_value BRAIN_PORT)"
  if [ -f "$ROOT_DIR/.env" ]; then
    local raw line
    while IFS= read -r raw || [ -n "$raw" ]; do
      line="${raw%$'\r'}"
      case "$line" in
        NODE_IMAGE=* | BASIC_MEMORY_IMAGE=* | VAULT_PATH=* | BRAIN_PORT=* | BRAIN_UID=* | BRAIN_GID=*) continue ;;
      esac
      printf '%s\n' "$line" >> "$tmp"
    done < "$ROOT_DIR/.env"
  fi
  printf 'NODE_IMAGE=%s\n' "$NODE_IMAGE" >> "$tmp"
  printf 'BASIC_MEMORY_IMAGE=%s\n' "$BASIC_MEMORY_IMAGE" >> "$tmp"
  printf 'VAULT_PATH=%s\n' "${existing_vault:-$vault}" >> "$tmp"
  printf 'BRAIN_PORT=%s\n' "${existing_port:-$port}" >> "$tmp"
  printf 'BRAIN_UID=%s\n' "$BRAIN_UID" >> "$tmp"
  printf 'BRAIN_GID=%s\n' "$BRAIN_GID" >> "$tmp"
  mv "$tmp" "$ROOT_DIR/.env"
}

run_as_root() {
  docker run --rm --user 0:0 "$@"
}

main() {
  parse_images_env "$IMAGES_FILE"

  local vault_raw="${VAULT_PATH:-$(read_env_value VAULT_PATH)}"
  vault_raw="${vault_raw:-./vault}"
  local brain_port="${BRAIN_PORT:-$(read_env_value BRAIN_PORT)}"
  brain_port="${brain_port:-7331}"

  [ -n "$BRAIN_UID" ] || BRAIN_UID="$(read_env_value BRAIN_UID)"
  BRAIN_UID="${BRAIN_UID:-1000}"
  [ -n "$BRAIN_GID" ] || BRAIN_GID="$(read_env_value BRAIN_GID)"
  BRAIN_GID="${BRAIN_GID:-1000}"

  local vault_abs vault_created=0
  if [ -d "$vault_raw" ]; then
    vault_abs="$(cd "$vault_raw" && pwd -P)"
  else
    vault_abs="$(mkdir -p "$vault_raw" && cd "$vault_raw" && pwd -P)"
    vault_created=1
  fi

  if [ "$vault_created" -eq 1 ]; then
    run_as_root -v "$vault_abs":/vault "$NODE_IMAGE" \
      sh -c "chown -R $BRAIN_UID:$BRAIN_GID /vault"
  fi

  write_env_file "$vault_raw" "$brain_port"

  printf 'setup: building second-brain:local from %s\n' "$NODE_IMAGE"
  docker build --build-arg "NODE_IMAGE=$NODE_IMAGE" -t second-brain:local "$ROOT_DIR"

  printf 'setup: generating configuration and secrets in %s\n' "$ROOT_DIR"
  local owner_args=()
  if [ "${BRAIN_OWNER_CREDENTIAL:-0}" = "1" ]; then
    owner_args+=(-e BRAIN_SETUP_OWNER_CREDENTIAL=1)
  fi
  run_as_root \
    -e BRAIN_SETUP_ROOT=/bootstrap \
    -e "BRAIN_SETUP_SCOPE=$BRAIN_SCOPE" \
    -e "BRAIN_SETUP_VAULT=$vault_abs" \
    -e "BRAIN_SETUP_UID=$BRAIN_UID" \
    -e "BRAIN_SETUP_GID=$BRAIN_GID" \
    ${owner_args[@]+"${owner_args[@]}"} \
    -v "$ROOT_DIR":/bootstrap \
    -v "$vault_abs":"$vault_abs" \
    second-brain:local setup

  run_as_root -v "$ROOT_DIR/config":/config "$NODE_IMAGE" \
    sh -c "chown $BRAIN_UID:$BRAIN_GID /config/brain.yaml && chmod 644 /config/brain.yaml"
  run_as_root -v "$ROOT_DIR/secrets":/secrets "$NODE_IMAGE" \
    sh -c "chown -R $BRAIN_UID:$BRAIN_GID /secrets && chmod 700 /secrets && chmod 600 /secrets/*"
  if [ "$vault_created" -eq 1 ]; then
    run_as_root -v "$vault_abs":/vault "$NODE_IMAGE" \
      chown -R "$BRAIN_UID:$BRAIN_GID" /vault
  fi

  local name vol
  for name in brain-state memory-state model-cache; do
    vol="${COMPOSE_PROJECT_NAME}_${name}"
    if docker volume inspect "$vol" >/dev/null 2>&1; then
      printf 'setup: volume %s already exists; leaving ownership unchanged\n' "$vol"
      continue
    fi
    docker volume create "$vol" >/dev/null
    run_as_root -v "$vol":/volume "$NODE_IMAGE" chown -R "$BRAIN_UID:$BRAIN_GID" /volume
  done

  local config_volume="${COMPOSE_PROJECT_NAME}_memory-state"
  if docker run --rm --user "$BRAIN_UID:$BRAIN_GID" \
      -v "$config_volume":/home/appuser/.basic-memory \
      --entrypoint sh "$BASIC_MEMORY_IMAGE" \
      -c 'test -f /home/appuser/.basic-memory/config.json'; then
    printf 'setup: Basic Memory configuration already present; preserving project mappings\n'
  else
    if ! docker run --rm --user "$BRAIN_UID:$BRAIN_GID" -v "$vault_abs":/app/data "$NODE_IMAGE" \
        sh -c 'test -w /app/data'; then
      fail "vault path is not writable by uid $BRAIN_UID: $vault_abs"
    fi
    local bm=(docker run --rm --user "$BRAIN_UID:$BRAIN_GID"
      -e BASIC_MEMORY_CONFIG_DIR=/home/appuser/.basic-memory
      -e BASIC_MEMORY_HOME=/home/appuser/.basic-memory/home
      -e BASIC_MEMORY_PROJECT_ROOT=
      -v "$config_volume":/home/appuser/.basic-memory
      -v "$vault_abs":/app/data
      --entrypoint basic-memory "$BASIC_MEMORY_IMAGE")
    "${bm[@]}" project add "$BRAIN_SCOPE" "/app/data/$(scope_relative_root "$BRAIN_SCOPE")"
    "${bm[@]}" project add shared /app/data/Shared
    "${bm[@]}" project add profile /app/data/Profile
  fi

  printf 'setup: complete\n'
  printf 'setup: next run "docker compose up -d --build"\n'
  printf 'setup: check with "docker compose exec brain node dist/cli.js health"\n'
}

scope_relative_root() {
  case "$1" in
    freellmapi) printf 'Projects/freellmapi' ;;
    shared) printf 'Shared' ;;
    profile) printf 'Profile' ;;
    *) printf 'Projects/%s' "$1" ;;
  esac
}

main "$@"
