#!/usr/bin/env bash
set -euo pipefail

# Explicit model preparation. Normal startup never fetches models; reranking is
# enabled only after this step produced verified, hash-locked artifacts in the
# durable state volume. Nothing here runs during `docker compose up`.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-second-brain}"
BRAIN_UID="${BRAIN_UID:-1000}"
BRAIN_GID="${BRAIN_GID:-1000}"
LOCK="${BRAIN_LAYA_LOCK:-config/laya-model.lock.json}"
CONTAINER_MODELS="/var/lib/second-brain/models/laya"

fail() {
  printf 'prepare-models: %s\n' "$1" >&2
  exit 1
}

IMAGE="second-brain:local"
docker image inspect "$IMAGE" >/dev/null 2>&1 \
  || fail "image $IMAGE does not exist; run scripts/setup.sh first"

VOLUME="${COMPOSE_PROJECT_NAME}_brain-state"
docker volume inspect "$VOLUME" >/dev/null 2>&1 \
  || fail "state volume $VOLUME does not exist; run scripts/setup.sh first"

printf 'prepare-models: fetching the locked snapshot into %s\n' "$VOLUME"
docker run --rm --user 0:0 --entrypoint python3 \
  -v "$VOLUME":/var/lib/second-brain \
  -v "$ROOT_DIR":/src:ro \
  -w /src \
  "$IMAGE" \
  scripts/prepare-laya.py fetch --lock "$LOCK" --destination "$CONTAINER_MODELS"

printf 'prepare-models: verifying the snapshot with networking disabled\n'
docker run --rm --user 0:0 --network none --entrypoint python3 \
  -v "$VOLUME":/var/lib/second-brain \
  -v "$ROOT_DIR":/src:ro \
  -w /src \
  "$IMAGE" \
  scripts/prepare-laya.py verify --lock "$LOCK" --destination "$CONTAINER_MODELS" --offline

docker run --rm --user 0:0 --entrypoint chown -v "$VOLUME":/var/lib/second-brain "$IMAGE" \
  -R "$BRAIN_UID:$BRAIN_GID" /var/lib/second-brain/models

printf 'prepare-models: complete; set BRAIN_LAYA_ENABLED=true and BRAIN_SEARCH_MODE=reranked only after the release gate\n'
