#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BRAIN_UID="${BRAIN_UID:-}"
BRAIN_GID="${BRAIN_GID:-}"
BRAIN_SCOPE="${BRAIN_SCOPE:-}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-second-brain}"
IMAGES_FILE="$ROOT_DIR/config/images.env"

fail() {
  printf 'setup: %s\n' "$1" >&2
  exit 1
}

NODE_IMAGE=""
PYTHON_IMAGE=""

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
      PYTHON_IMAGE)
        [ -z "$PYTHON_IMAGE" ] || fail "duplicate PYTHON_IMAGE in $file"
        PYTHON_IMAGE="$value"
        ;;
      *) fail "unexpected key '$key' in $file (only NODE_IMAGE and PYTHON_IMAGE are allowed)" ;;
    esac
    case "$value" in
      '' ) fail "empty value for $key in $file" ;;
      *[!A-Za-z0-9._:@/+-]*) fail "rejected shell syntax or unsafe character in $key" ;;
    esac
  done < "$file"
  [ -n "$NODE_IMAGE" ] || fail "NODE_IMAGE is missing from $file"
  [ -n "$PYTHON_IMAGE" ] || fail "PYTHON_IMAGE is missing from $file"
  require_digest_reference "NODE_IMAGE" "$NODE_IMAGE"
  require_digest_reference "PYTHON_IMAGE" "$PYTHON_IMAGE"
  case "$NODE_IMAGE$PYTHON_IMAGE" in
    *:latest*) fail "floating 'latest' references are not allowed" ;;
  esac
}

require_digest_reference() {
  local name="$1" value="$2"
  if [[ ! "$value" =~ ^[A-Za-z0-9._:/-]+@sha256:[0-9a-fA-F]{64}$ ]]; then
    fail "$name must be a digest-pinned reference ending in @sha256:<64 hex digits>"
  fi
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
        NODE_IMAGE=* | PYTHON_IMAGE=* | BASIC_MEMORY_IMAGE=* | VAULT_PATH=* | BRAIN_PORT=* | BRAIN_UID=* | BRAIN_GID=*) continue ;;
      esac
      printf '%s\n' "$line" >> "$tmp"
    done < "$ROOT_DIR/.env"
  fi
  printf 'NODE_IMAGE=%s\n' "$NODE_IMAGE" >> "$tmp"
  printf 'PYTHON_IMAGE=%s\n' "$PYTHON_IMAGE" >> "$tmp"
  printf 'VAULT_PATH=%s\n' "${existing_vault:-$vault}" >> "$tmp"
  printf 'BRAIN_PORT=%s\n' "${existing_port:-$port}" >> "$tmp"
  printf 'BRAIN_UID=%s\n' "$BRAIN_UID" >> "$tmp"
  printf 'BRAIN_GID=%s\n' "$BRAIN_GID" >> "$tmp"
  mv "$tmp" "$ROOT_DIR/.env"
}

run_as_root() {
  docker run --rm --user 0:0 "$@"
}

volume_is_writable_by_runtime() {
  docker run --rm --user "$BRAIN_UID:$BRAIN_GID" -v "$1":/volume \
    --entrypoint sh "$NODE_IMAGE" -c 'test -w /volume'
}

chown_new_volume() {
  run_as_root -v "$1":/volume "$NODE_IMAGE" chown -R "$BRAIN_UID:$BRAIN_GID" /volume
}

main() {
  parse_images_env "$IMAGES_FILE"

  [ -n "$BRAIN_SCOPE" ] || BRAIN_SCOPE="$(read_env_value BRAIN_SCOPE)"

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
  chmod 600 "$ROOT_DIR/.env"

  printf 'setup: building second-brain:local from %s and %s\n' "$NODE_IMAGE" "$PYTHON_IMAGE"
  docker build \
    --build-arg "NODE_IMAGE=$NODE_IMAGE" \
    --build-arg "PYTHON_IMAGE=$PYTHON_IMAGE" \
    -t second-brain:local "$ROOT_DIR"

  printf 'setup: generating configuration and secrets in %s\n' "$ROOT_DIR"
  local scope_args=()
  if [ -n "$BRAIN_SCOPE" ]; then
    scope_args+=(-e "BRAIN_SETUP_SCOPE=$BRAIN_SCOPE")
  fi
  run_as_root \
    -e BRAIN_SETUP_ROOT=/bootstrap \
    -e "BRAIN_SETUP_VAULT=$vault_abs" \
    -e "BRAIN_SETUP_UID=$BRAIN_UID" \
    -e "BRAIN_SETUP_GID=$BRAIN_GID" \
    ${scope_args[@]+"${scope_args[@]}"} \
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
  for name in brain-state; do
    vol="${COMPOSE_PROJECT_NAME}_${name}"
    if docker volume inspect "$vol" >/dev/null 2>&1; then
      if volume_is_writable_by_runtime "$vol"; then
        printf 'setup: volume %s already exists; validated without changing ownership\n' "$vol"
        continue
      fi
      fail "existing volume $vol is not writable by uid $BRAIN_UID; setup never changes ownership of an existing volume, so repair it manually or choose a different COMPOSE_PROJECT_NAME"
    fi
    docker volume create \
      --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
      --label "com.docker.compose.volume=$name" \
      "$vol" >/dev/null
    chown_new_volume "$vol"
  done

  printf 'setup: complete\n'
  printf 'setup: next run "docker compose up -d --build"\n'
  printf 'setup: prepare the local model explicitly with "bash scripts/prepare-models.sh" before enabling reranking\n'
  printf 'setup: check with "docker compose exec brain node dist/cli.js health"\n'
}

main "$@"
