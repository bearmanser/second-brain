# Operations

This covers the running gateway: its state files, how indexing keeps up with
Obsidian, health checks, backup, and recovery.

## State directory

`BRAIN_STATE_DIR` holds three things (plus SQLite WAL/SHM sidecar files):

| File | Nature |
| --- | --- |
| `index.db` | **Derived.** The FTS5 search index, rebuilt from the vault. Safe to delete. |
| `brain.db` | **Durable.** Feedback and idempotency records — the only state not in the vault. |
| `brain.lock` | Instance lock; one gateway per state directory. |

`index.db` is a pure function of the vault: the gateway re-creates it on
startup by scanning. `brain.db` holds feedback you recorded and idempotency
reservations, and cannot be regenerated from the vault.

## Rebuilding the index

If the index looks stale or corrupt after an upgrade:

1. Stop the container.
2. Delete `index.db` (and any `index.db-wal` / `index.db-shm`).
3. Start it again. The startup scan rebuilds the index from the vault.

**Never delete `brain.db` casually.** It holds your feedback. Deleting it does
not lose notes, but it silently discards every feedback verdict and idempotency
reservation.

## Scanning

The vault is scanned at startup (before the listener binds) and then every
`BRAIN_SCAN_INTERVAL_MS` (default 30 seconds). Hand edits made in Obsidian are
picked up within one interval; MCP writes update the index synchronously before
they return.

Notes the scanner cannot parse (for example invalid YAML frontmatter, or a
`type: project` file somewhere other than `Projects/<Name>/<Name>.md`) are
skipped and reported by `brain_status` under `problems`, together with any
duplicate `id`s.

## Health

`GET /health` is the only unauthenticated route. It returns:

```json
{ "status": "ok" }
```

Liveness probes should use it. The listener does not bind until the initial
scan completes, so a reachable `/health` implies the index is built. The body
exposes nothing beyond this; success is indicated by the HTTP 200.

## Backup

Back up two things:

- **The vault** — the source of truth for note content and project structure.
- **`brain.db`** — the feedback you have recorded.

`index.db` does not need backing up; it is rebuilt from the vault.

## Recovery

- **A broken note.** `brain_status` names the offending path and problem in
  `problems`. Fix the frontmatter in Obsidian and it indexes on the next scan.
- **Duplicate ids.** `brain_status` lists every path sharing an id. Rename or
  remove one; after the next scan the duplicates clear. Until then, addressing
  such a note by `id` fails with `CONFLICT`, but `path` still works.

## Trash

`brain_delete` moves a note to `.trash/` (adding a collision suffix if needed).
`.trash/` is never indexed and never returned by recall. To permanently remove
a trashed note, delete the file from `.trash/`.

## Cutover window

The one-shot importer (`node dist/cli.js import`) migrates a pre-clean vault
into the clean layout; it is removed after cutover is accepted. During the
cutover window, retain the previous container image, the legacy vault, and the
old state volume so you can roll back: restoring the previous image together
with the legacy vault and old state volume returns you to the pre-clean system.
The exact tar archives, renames, and volume names for this host are in the
cutover runbook in the design document
(`docs/superpowers/specs/2026-09-25-clean-core-design.md`); none of those
artifacts are modified during cutover.
