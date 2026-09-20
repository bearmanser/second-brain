# Operations runbook: recovery, backup, restore, and index rebuild

This guide covers the operational side of the second-brain gateway: what persistent
state exists, how an interrupted write is recovered, how to take a cold backup and
restore it, and how to rebuild derived indexes without pretending that a rebuild is a
full recovery.

## What is authoritative, derived, and separate state

| Store | Location | Nature | Rebuildable? |
|---|---|---|---|
| Markdown notes | host vault directory (`VAULT_PATH`) | **Authoritative** knowledge | No — must be preserved |
| Revision catalogue | `brain-state` volume: `catalogue.db` | Derived head/graph index | Yes, from Markdown |
| Basic Memory search index and embeddings | `memory-state` + `model-cache` volumes | Derived search index | Yes, with `basic-memory reindex` |
| Operation journal | `brain-state` volume: `journal.db` | Separate persistent state: idempotency, recovery, retry history | No — restore from backup |
| Feedback, retrieval, audit records | `brain-state` volume: `journal.db` | Separate persistent state | No — restore from backup |

Because the journal and feedback live in `journal.db`, an index or catalogue rebuild
never reconstructs them. A missing `journal.db` triggers explicit recovery mode; the
gateway never silently initialises a fresh database on a non-empty vault.

## Startup recovery

Before it accepts new mutations the gateway records the disposition of every
incomplete operation with `recoverPending(deps)`. For each operation it:

1. locates the intended revision by operation/revision ID in the vault;
2. verifies the materialised payload (logical ID, revision ID, scope, parents,
   approval fingerprint) against the persisted plan;
3. **finalizes** a verified materialisation, **leaves it conflicted** when the bytes
   disagree, or **marks it definitively failed** when the plan cannot be read; a
   prepared reservation with no plan is released.

Startup recovery never replays a write merely because a receipt is absent. A
submitted operation whose materialisation is conclusively absent is left `pending`
for an identical client retry; it is not resent from recovery.

While an operation remains ambiguous (an inconclusive vault scan), `brain_status`
reports `health.gateway = "recovering"`, authorized reads continue, and **new**
mutations are refused with `RECOVERY_REQUIRED`. Retrying the same idempotency key,
and `recover-state` below, remain available. The report shape is:

```ts
interface RecoveryReport {
  inspected: number;
  finalized: number;
  conflicted: number;
  failed: number;
  released: number;
  pending: number;
  blocking_operations: string[];
  operations: RecoveryOperationReport[];
  scopes: string[];
}
```

Run recovery explicitly:

```sh
# Non-destructive inspection/recovery of pending operations (prints the journal path
# error if journal.db is missing).
docker compose exec brain node dist/cli.js recover

# Owner-only, explicit recovery mode. Refuses without --mode=recover.
# Requires an owner bearer token (BRAIN_TOKEN or --token) and an existing journal.db.
docker compose exec brain node dist/cli.js recover-state --mode=recover --token "$OWNER_TOKEN"
```

`recover-state` exits non-zero when ambiguity remains (`blocking_operations` is not
empty) so an operator can investigate instead of assuming success.

## Cold backup

`scripts/backup.sh DESTINATION [--yes] [--notes-only] [--include-secrets]`

```sh
# Stop editing in Obsidian and pause external sync first, then:
scripts/backup.sh /srv/backups/second-brain-2026-09-21
```

The script:

1. refuses a destination that already exists and is not empty;
2. requires the operator to confirm that Obsidian edits and external synchronization
   are paused (`--yes` for non-interactive runs);
3. stops **both** services before reading anything;
4. resolves the real named-volume names from Compose — it asks
   `docker compose config --volumes` for the volume keys and then resolves each key to
   the actual Docker volume by its `com.docker.compose.project`/`com.docker.compose.volume`
   labels. It never hard-codes the project prefix;
5. archives the host vault to `vault.tar` and each named volume to
   `volumes/<volume>.tar`;
6. computes a source snapshot before and after each copy and **aborts the backup as
   inconsistent** if any file changed (stopping the containers does not stop an
   external editor or sync client);
7. writes `checksums.sha256` and a versioned `manifest.json` (format version, creation
   time, software/image versions, included stores, file entries) via
   `node dist/cli.js backup-manifest`;
8. restarts both services from an `EXIT` trap **even if backup creation fails**.

Stores and secrets:

- default (operational) backup: host vault + named volumes. Host token files under
  `secrets/` are **excluded**;
- `--notes-only`: the host vault only. Host token files are never included;
- `--include-secrets`: additionally archives `secrets/` and labels the manifest
  `sensitive: true`. Treat that archive as a credential store.

Do not copy a live `journal.db` directly; the cold backup stops the gateway first, and
Docker's WAL mode means the `.db` plus its `-wal`/`-shm` companions are all inside the
volume archive taken while the service is stopped.

## Verify and restore

`scripts/restore.sh BACKUP NEW_ROOT [--check] [--acknowledge] [--project NAME] [--port N]`

```sh
# Validate only: hashes, manifest, paths, symlinks. Does not extract or start anything.
scripts/restore.sh /srv/backups/second-brain-2026-09-21 /srv/restore/test --check

# Extract into a new root (no services touched).
scripts/restore.sh /srv/backups/second-brain-2026-09-21 /srv/restore/test --acknowledge

# Boot the restored data under a separate Compose project and port and wait for health.
# This reuses the checkout's config/credentials and the restored vault + volumes.
scripts/restore.sh /srv/backups/second-brain-2026-09-21 /srv/restore/test \
  --acknowledge --start --project second-brain-restore --port 17551
```

The script rejects:

- a corrupt or incomplete archive (checksum mismatch against `checksums.sha256`);
- `../` traversal members and absolute paths inside any archive;
- symbolic-link members;
- an unsupported backup format version;
- a backup whose application-state schema is newer than this release supports;
- an existing, non-empty destination.

It extracts only into the fresh `NEW_ROOT`. With `--start` it bind-mounts the restored
vault and volume directories into a separate Compose project and port, waits for
`node dist/cli.js health` (up to five minutes) before reporting success, and removes the
test stack afterwards. The working deployment is **not** switched automatically; review
the restored stack and switch deliberately, restoring `config/` and `secrets/` as well
if the full operational backup was taken.

Independent verification of a backup directory is also available:

```sh
docker compose exec brain node dist/cli.js verify-backup \
  --root /backup --manifest /backup/manifest.json
```

## Index rebuild (not a restore)

`scripts/rebuild.sh [--acknowledge] [--full] [--embeddings] [--project NAME]`

```sh
BRAIN_REBUILD_ACKNOWLEDGE=yes scripts/rebuild.sh
```

The script:

1. checks for `journal.db` in the `brain-state` volume. If it is missing it **fails**
   and tells you to restore it from a backup; it never initialises a fresh database on
   a non-empty vault;
2. requires explicit owner acknowledgment (so nobody mistakes an index rebuild for
   operational recovery);
3. pauses gateway mutations by stopping the `brain` service;
4. runs the supported reindex inside the Basic Memory container:
   `basic-memory reindex` (use `--full`/`--embeddings`/`--search` for a fuller or
   narrower run);
5. rebuilds the gateway catalogue from Markdown with
   `node dist/cli.js rebuild-catalogue`, which now also requires `journal.db` so
   authenticated approval provenance is preserved;
6. leaves the operation journal and feedback untouched, and confirms the `operations`
   and `feedback_records` tables are still present;
7. restarts the gateway from an `EXIT` trap.

Rebuilding never revives an archived or superseded head: the catalogue marks heads by
graph position, and retrieval continues to exclude archived and superseded statuses.

**Limits.** An index rebuild restores derived search/catalogue state only. It does not
reconstruct retry history or feedback, does not recover a corrupt vault, and does not
repair a damaged revision graph. Those require a backup or explicit owner recovery.

## Observed environment notes

- The pinned Basic Memory image advertises `reindex` and `doctor`; the supported
  command used here is `basic-memory reindex` (verified against the pinned image,
  which documents "Rebuild search indexes and/or vector embeddings without dropping
  the database").
- This checkout had no deployed `second-brain` Compose project (`docker volume ls`
  showed no `second-brain_*` volumes and no running containers). The full
  stop/archive/restart and restore/reboot cycles were therefore validated through the
  in-process recovery/backup suite and `restore.sh --check`, not by executing the stop
  and restart against a live stack. Run the full cycle on the actual deployment before
  relying on it.
- `restore.sh --check` and the manifest commands require only coreutils + `tar` (and,
  for `verify-backup`, the built CLI); the full restore and rebuild paths require
  Docker and the pinned images.
