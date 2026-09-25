# Operations runbook: recovery, backup, restore, and index rebuild

This guide covers the operational side of the second-brain gateway: what persistent
state exists, how an interrupted write is recovered, how to take a cold backup and
restore it, and how to rebuild derived indexes without pretending that a rebuild is a
full recovery.

## What is authoritative, derived, and separate state

| Store | Location | Nature | Rebuildable? |
|---|---|---|---|
| Markdown notes | host vault directory (`VAULT_PATH`) | **Authoritative** knowledge | No — must be preserved |
| Revision snapshots | `brain-state` volume: `history/<id>/` | **Durable** revision history and preimages | No — restore from backup |
| Operation journal | `brain-state` volume: `journal.db` | **Durable** idempotency, project records, feedback, retrieval traces/labels, approvals | No — restore from backup |
| Local write journal | `brain-state` volume: `documents.sqlite` | **Durable** current-document bindings, write receipts, index queue | No — restore from backup |
| Local operation journal | `brain-state` volume: `operations.sqlite` | **Durable** local mutation operation receipts | No — restore from backup |
| Migration manifests | `brain-state` volume: `migrations/` | **Durable** vault-v2 migration receipts | No — restore from backup |
| Search index | `brain-state` volume: `index/search.sqlite` | Disposable derived FTS index | Yes, with `rebuild-index` |
| Model artifacts | `brain-state` volume: `models/` | Reproducible but useful for offline recovery | Yes, re-downloaded during model setup |

Because history, the journals, project records, feedback, and migration receipts
live outside the vault, an index rebuild never reconstructs them. A missing or
damaged `journal.db` triggers explicit recovery mode; the gateway never silently
initialises a fresh database on a non-empty vault, and `rebuild-index` refuses
rather than deleting history or granting approvals implicitly.

## Renamed and retired operator commands

The local V2 runtime retires Basic Memory from normal operation. The following
operator surfaces replace the earlier Basic Memory guidance:

| Retired | Replacement |
|---|---|
| `basic-memory reindex` (inside the `memory` container) | `node dist/cli.js rebuild-index` |
| `rebuild-catalogue` as a search reindex | `rebuild-index` (the legacy `rebuild-catalogue` command remains for the legacy catalogue only) |
| Ad-hoc `cp` of a live `journal.db` | `node dist/cli.js local-backup` (SQLite backup API, WAL-safe) |
| Manual vault-only `tar` export | `node dist/cli.js local-backup --vault-only` then `node dist/cli.js local-restore --vault-only` |
| `verify-backup` for the Compose volume archive | `verify-local-backup` for the local V2 stores; `verify-backup` remains for `scripts/backup.sh` archives |

`scripts/backup.sh`, `scripts/restore.sh`, and `scripts/rebuild.sh` remain the
Compose-volume level tools for `brain-state`/`memory-state`/`model-cache`. The
`local-*` commands below are the store-level tools and are also used by the
integration tests.

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

`scripts/backup.sh DESTINATION [--yes] [--notes-only] [--include-secrets] [--exclude-volume NAME[,NAME]]`

```sh
# Stop editing in Obsidian and pause external sync first, then:
scripts/backup.sh /srv/backups/second-brain-2026-09-21
```

The default cold backup archives the host vault **and every named volume Compose
declares** (`brain-state`, `memory-state`, `model-cache`). `--exclude-volume` is the only
opt-out for individual volumes; `--notes-only` is an explicit vault-only export.

The script:

1. refuses a destination that already exists and is not empty;
2. requires the operator to confirm that Obsidian edits and external synchronization
   are paused (`--yes` for non-interactive runs);
3. resolves the real named-volume names from Compose — it asks
   `docker compose config --volumes` for the volume keys and then resolves each key to
   the actual Docker volume by its `com.docker.compose.project`/`com.docker.compose.volume`
   labels. It never hard-codes the project prefix;
4. stops **both** services before reading anything;
5. under that stable stopped state, scans the vault and every selected volume for
   symbolic links and archives each store under its **stable logical key** (for example
   `volumes/brain-state.tar`), recording the resolved Compose-key-to-actual-volume-name
   mapping in the manifest's `volumes` object (for example
   `{"brain-state": "second-brain_brain-state"}`);
6. enumerates and validates every produced archive before accepting it, removing the
   archive and failing as inconsistent if its members violate the store's link rule;
7. computes a source snapshot before and after each copy **including symbolic-link
   entries** and **aborts the backup as inconsistent** if anything changed, so a link
   introduced mid-backup is detected;
8. writes `checksums.sha256` and a versioned `manifest.json` (format version, creation
   time, software/image versions, included stores, the volume mapping, sensitivity, and
   file entries) via `node dist/cli.js backup-manifest`;
9. restarts both services from an `EXIT` trap **even if backup creation fails**.

Symbolic links are **never dereferenced** (`tar` runs without `-h`). The rule is
per-store:

- **Vault:** any symbolic link is an error. The backup fails with the precise offending
  path, matching `FileVault`, which ignores links.
- **Named volumes** (for example `model-cache`, which legitimately contains cache links):
  links are preserved as links. One TypeScript resolver validates both the stopped live
  volume and the produced archive, walking each target component, requiring every
  intermediate component to be a directory, bounding link chains, and rejecting missing,
  absolute, or root-escaping targets with the precise link path. The before/after
  consistency snapshot includes link entries, so a link that appears while copying aborts
  the backup.
- **Restore** applies the same rule: symlink members in the vault archive are rejected;
  named-volume archives recreate links only when their targets stay inside the restored
  volume root, and a broken or escaping link discards the restore.

`--check` validates the manifest, hashes, and archive members without extracting them.

Stores and secrets:

- default (operational) backup: host vault + named volumes. Host token files under
  `secrets/` are **excluded**;
- `--notes-only`: the host vault only. Host token files are never included;
- `--include-secrets`: additionally archives `secrets/` and labels the manifest
  `sensitive: true`. Treat that archive as a credential store.

Do not copy a live `journal.db` directly; the cold backup stops the gateway first, and
Docker's WAL mode means the `.db` plus its `-wal`/`-shm` companions are all inside the
volume archive taken while the service is stopped.

The manifest writer can also be invoked directly (the `--volume` mapping is the
Compose-key-to-actual-name object, and `--image` entries are comma-separated):

```sh
node dist/cli.js backup-manifest \
  --root /srv/backups/… --out /srv/backups/…/manifest.json \
  --store vault,brain-state,memory-state,model-cache \
  --volume brain-state=second-brain_brain-state,memory-state=second-brain_memory-state \
  --image brain=node@sha256:…,basic-memory=ghcr.io/…@sha256:…
```

### Local V2 store backup (`local-backup`)

`node dist/cli.js local-backup --destination DIR [--vault-only] [--include-search-index] [--include-model-artifacts] [--config DIR] [--secret FILE] [--allow-live-writers]`

`local-backup` is a cold backup: it acquires the state `gateway.lock` and
**fails closed** if a running runtime already holds it, so the vault and history
are not captured at different points. `--allow-live-writers` is an explicit,
unsafe override for an operator who has independently paused writers; it is not
the normal path.

The store-level backup writes `local-manifest.json` and a category-classified
copy of the local V2 state:

- **vault** — the authoritative Markdown (never contains secrets);
- **revision snapshots** — `state/history/`;
- **journal** — `journal.db`, `documents.sqlite`, `operations.sqlite`, each
  captured through the SQLite backup API after writers are stopped, so committed
  WAL content is included and the live `.sqlite` file is never copied alone;
- **migration manifests** — `state/migrations/`;
- **config/version** — `config/version.json` and, when `--config` is given, the
  configuration directory;
- **search index** and **model artifacts** — optional, marked `reproducible`;
- **secrets** — only with `--secret`; stored under `secrets/`, marked
  `sensitive: true`, and never copied into the `vault/` tree.

A backup that excludes model binaries cannot promise an immediate offline Laya
start after a restore; the model must be re-downloaded through the explicit
setup path. Text search (via `rebuild-index`), current reads, and safe writes
still work after durable-state verification without any model artifacts.

`--vault-only` is an explicit, distinct export that contains only current note
content. Import it with `local-restore --vault-only`; the CLI prints that
history and receipts are absent, and `verify-local-backup` never reports a
vault-only import as historical recovery.

`node dist/cli.js local-restore --backup DIR [--vault-only] [--vault V] [--state S]`

A full restore into an empty directory recovers current content, revision
history, and operation receipts; it refuses a vault-only backup, and refuses a
non-empty destination. `node dist/cli.js verify-local-backup --manifest FILE
[--root DIR | --vault V --state S --config C --secrets X]` reports integrity
(every category checksum present and valid) and durability completeness
separately: a `full`-scope manifest that omits durable history or
`journal.db`/project records is not `ok`, and a full restore of such a manifest
is refused rather than performed with warnings only. It also reports which of
current content, history, receipts, and index are recoverable.
`rebuild-index` refuses when `journal.db` is missing, damaged, behind on schema,
or needs approval-provenance recovery while managed notes exist, so a rebuild
never repairs durable state; run the explicit recovery command instead.

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

- a corrupt or incomplete archive (the TypeScript `verify-backup` verifier checks
  **every** file declared in `manifest.json`, and `restore.sh` additionally rejects any
  extractable `*.tar` that is not declared);
- `../` traversal members and absolute paths inside any archive;
- symbolic-link members in the vault archive, and broken or escaping named-volume
  symlinks (internal non-broken volume links are preserved as links);
- an unsupported backup format version;
- a backup whose application-state schema is newer than this release supports;
- an existing `NEW_ROOT` (including an empty directory or a symlink) — restore creates
  the fresh root atomically only after all checks pass, and validates its parent.

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

`node dist/cli.js rebuild-index [--vault V] [--state S]`

The local V2 rebuild builds a fresh FTS index into a staging file, validates the
document count and a fingerprint over `(path, etag)`, then atomically replaces
`index/search.sqlite` after closing the previous handle. On any failure it
retains the previous valid index, removes the staging file, and reports
degradation on stderr with a non-zero exit. It never touches `history/`,
`journal.db`, or approval provenance.

`scripts/rebuild.sh [--acknowledge] [--accept-operational-loss] [--full] [--embeddings] [--search] [--project NAME]`

```sh
BRAIN_REBUILD_ACKNOWLEDGE=yes scripts/rebuild.sh
```

The script:

1. checks for `journal.db` in the `brain-state` volume. If it is missing it **fails**
   and tells you to restore it from a backup. Only an explicit
   `--accept-operational-loss` (or `BRAIN_REBUILD_ACCEPT_OPERATIONAL_LOSS=yes`) proceeds
   without it: the script prints a loud warning, and `rebuild-catalogue` is invoked with
   `--accept-operational-loss`, which initializes a fresh operation journal and labels
   the result as lossy. Retry and feedback history is permanently discarded and the
   result is **not** full operational recovery. This escape hatch is refused when the
   vault contains a dynamic repository project not declared in `brain.yaml`, because
   its canonical identity and grants cannot be reconstructed from Markdown; restore
   `journal.db` instead;
2. requires explicit owner acknowledgment (`--acknowledge` /
   `BRAIN_REBUILD_ACKNOWLEDGE=yes`) so nobody mistakes an index rebuild for operational
   recovery;
3. pauses gateway mutations by stopping the `brain` service (only if it is running);
4. rebuilds the local V2 search index from current Markdown with
   `node dist/cli.js rebuild-index`, which stages, validates, and atomically
   publishes the index and refuses if the durable journal is missing or damaged.
   The legacy Basic Memory reindex step is retired for the local V2 runtime; the
   `scripts/rebuild.sh` script still contains it and Task 18 replaces it;
5. rebuilds the gateway catalogue from Markdown with
   `node dist/cli.js rebuild-catalogue`, which requires `journal.db` so authenticated
   approval provenance is preserved;
6. compares the catalogue's `scanned` count against the Markdown revision count and
   **fails loudly** unless they match and `conflicts`/`malformed`/`unsupported_schema`
   are all zero (a head-graph problem is never silently accepted);
7. captures the pre-rebuild `operations`, `feedback_records`,
   `repository_projects`, and `dynamic_project_grants` row counts and content
   digests and repeats the measurement after the rebuild, **failing** unless
   they are byte-for-byte identical (in the acknowledged-loss mode there is no
   pre-state to compare, and the lossy label is printed instead);
8. restarts the gateway from an `EXIT` trap.

Rebuilding never revives an archived or superseded head: the catalogue marks heads by
graph position, and retrieval continues to exclude archived and superseded statuses.

**Limits.** An index rebuild restores derived search/catalogue state only. It does not
reconstruct retry history, feedback, repository mappings, or grants, does not
recover a corrupt vault, and does not repair a damaged revision graph. Those
require a backup or explicit owner recovery. A repository project in
`recovery_required` must remain unavailable until an owner verifies backend,
vault, mapping, and grant state. After correcting the underlying Basic Memory
name/path conflict, the owner calls `brain_project_ensure` for the same remote
with a new idempotency key; only successful exact-path verification returns the
project to `ready`. Startup and every new-principal ensure re-verify persisted
ready mappings against both the vault directory and Basic Memory. A broken
dynamic scope is quarantined without hiding unrelated ready scopes.

## Local V2 cutover runbook

This is the exact ordering for replacing the pre-V2 (Basic Memory) deployment
with the single-container local V2 runtime. The detailed migration command
contract is in `docs/operations/vault-v2-migration.md`; the recorded release
evidence is in `docs/release-gate/local-brain-v2/checklist.md`.

```text
Record current image, configuration, volume mapping, and rollback artifacts.
Stop Obsidian and every agent/file-sync writer; enter maintenance.
Create and verify a cold backup; do not proceed on a partial verification.
Run migration inspect and plan; review every proposed path and blocker.
Run apply with the recorded manifest and backup receipt.
Verify migrated current files, all history hashes, links, projects, and receipts.
Start the new image on the existing vault and state mounts.
Run authenticated smoke tests and unauthenticated rejection checks.
Open the vault in Obsidian and validate the native views and a sample of links.
Enable reranking only when its measured gate passed; otherwise keep text mode.
Release maintenance only after the backend-replacement gate passed.
Retain the old backup/image/configuration; never delete them during cutover.
```

Command sketch (run inside the container or with the built CLI):

```sh
node dist/cli.js vault-v2 inspect --report /var/lib/second-brain/migrations/inspection.json --projects freellmapi="FreeLLM API"
node dist/cli.js vault-v2 plan --output /var/lib/second-brain/migrations/manifest.json --projects freellmapi="FreeLLM API"
# Refuses when any blocker is present:
node dist/cli.js vault-v2 apply --manifest /var/lib/second-brain/migrations/manifest.json \
  --backup-receipt /var/lib/second-brain/migrations/backup.json \
  --backup-root /var/lib/second-brain/backup --maintenance
# Explicit opt-in that migrates only the unblocked notes and prints every blocker:
node dist/cli.js vault-v2 apply --manifest /var/lib/second-brain/migrations/manifest.json \
  --backup-receipt /var/lib/second-brain/migrations/backup.json \
  --backup-root /var/lib/second-brain/backup --maintenance --partial
node dist/cli.js vault-v2 verify --manifest /var/lib/second-brain/migrations/manifest.json
```

If validation fails before writers resume, stop V2 and use the verified
migration rollback or a full cold restore with the matching old image/config. If
new writes have occurred, stop writers, take another backup, and reconcile
divergence before rollback. Never restore the old journal or files on top of new
work. A fresh local V2 deployment with no prior operational history must
initialize the journal explicitly (`rebuild-catalogue --accept-operational-loss`)
and is labelled lossy; that is not full operational recovery.

## Logs and status

```sh
docker compose logs -f brain
docker compose logs -f memory
docker compose ps
docker compose exec brain node dist/cli.js health
docker compose exec brain node dist/cli.js recover
docker compose exec brain node dist/cli.js verify-backup --root /backup --manifest /backup/manifest.json
```

Normal logs carry opaque IDs, sizes, durations, outcomes, and error codes, never
note bodies, queries, or credentials. `brain_status` reports
`health.gateway` (`ready`/`recovering`/`degraded`), `health.backend`,
`health.embeddings`, and `pending_operations`. While an operation is ambiguous,
reads continue. An ambiguous note write blocks new mutations until reconciled;
an ambiguous project provision blocks only its affected scope, so unrelated
ready scopes remain writable. `recover-state --mode=recover` exits non-zero when
ambiguity remains.

## Offline cache

The first hybrid search downloads the local FastEmbed model into the
`model-cache` volume at the verified path
`/home/appuser/.basic-memory/fastembed_cache`. After warm-up, hybrid search works
with no external egress (the Compose network can be switched to `internal: true`
for a test), and restarts reuse the cached model. Index and embedding state are
derived and rebuildable; the cache never contains authoritative notes.

## Safe upgrades

1. Take a cold backup and validate it (`scripts/restore.sh ... --check`) before
   changing an image or configuration.
2. Change `NODE_IMAGE`/`BASIC_MEMORY_IMAGE` only to another digest-pinned
   reference, then `docker compose up -d --build`.
3. Re-run `bash scripts/setup.sh`; it preserves existing tokens, credentials,
   `.env` user settings, and the ownership of existing volumes.
4. On start the gateway reconciles pending operations before accepting
   mutations. If `brain_status` reports `recovering`, inspect with
   `node dist/cli.js recover`.
5. If the state schema changed, rebuild the catalogue only through
   `scripts/rebuild.sh`; it requires `journal.db` and validates the graph.
6. Roll back by restoring the previous digest-pinned images and
   `config/brain.yaml`. The vault is authoritative and derived state rebuilds.
7. No image publishing or release automation runs automatically; a registry and
   release repository must be selected explicitly first.

For the full user-facing runbook (client registration, typed notes, candidate
review, credentials, and limitations), see `docs/setup.md`.

## Observed environment notes

- The legacy Basic Memory image advertises `reindex` and `doctor`, but `basic-memory
  reindex` is **not** the supported reindex path for the local V2 runtime; use
  `node dist/cli.js rebuild-index`. `scripts/rebuild.sh` still invokes the Basic
  Memory reindex and Task 18 removes that step.
- `tests/e2e/operations.test.ts` deploys a disposable Compose project (its own project
  name, port, vault, and volumes) and exercises the real stop/archive/restart cycle,
  the Compose-key volume mapping, `restore.sh --check`, `restore.sh --start` under a
  separate project and port, the rebuild count/graph/preservation checks, the
  destructive-loss refusal path, and corrupt-backup rejection. It fails loudly when
  Docker is unavailable and cleans up its project, volumes, images, and work directory
  in all paths. This checkout had no pre-existing deployed `second-brain` project, so
  the disposable project is the tested environment.
- `restore.sh --check` and the manifest commands require only coreutils + `tar` (and,
  for `verify-backup`, the built CLI or its container image); the full restore and
  rebuild paths require Docker and the pinned images.
