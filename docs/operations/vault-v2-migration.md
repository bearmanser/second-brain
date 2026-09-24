# Vault V2 migration operations

This document describes the resumable V1-to-V2 vault migration. The migration
turns the legacy UUID-directory revision layout into one readable current note
per logical note, with raw revision bytes preserved in durable history outside
the vault.

Do not run these commands against a live vault. Production migration requires a
verified backup, an explicit maintenance window with Obsidian and every other
writer stopped, and operator review of the inspection report.

## Command contract

```sh
node dist/cli.js vault-v2 inspect --report /var/lib/second-brain/migrations/inspection.json
node dist/cli.js vault-v2 plan --output /var/lib/second-brain/migrations/manifest.json
node dist/cli.js vault-v2 apply --manifest /var/lib/second-brain/migrations/manifest.json --backup-receipt /var/lib/second-brain/migrations/backup.json --backup-root /var/lib/second-brain/backup --maintenance
node dist/cli.js vault-v2 apply --manifest /var/lib/second-brain/migrations/manifest.json --backup-receipt /var/lib/second-brain/migrations/backup.json --backup-root /var/lib/second-brain/backup --maintenance --partial
node dist/cli.js vault-v2 verify --manifest /var/lib/second-brain/migrations/manifest.json
node dist/cli.js vault-v2 resume --manifest /var/lib/second-brain/migrations/manifest.json --backup-root /var/lib/second-brain/backup --maintenance
node dist/cli.js vault-v2 rollback --manifest /var/lib/second-brain/migrations/manifest.json --maintenance
```

The backup media at `--backup-root` mirrors the source as `vault/<path>` and
`state/<path>`. The backup receipt lists those paths with hashes computed from
the backup itself; applying re-reads the backup media and refuses unless every
recorded hash and size still matches the live source fingerprint.
Symlinked backup directories and backup files hardlinked to the live source
are refused: backup media must contain separate regular-file bytes. Keep the
backup untouched until migration and rollback verification are complete.

The vault and state directories come from the runtime configuration
(`BRAIN_VAULT_DIR`, `BRAIN_STATE_DIR`) and can be overridden with `--vault` and
`--state`. Project display names are supplied with repeated `--projects`
entries formatted `scope=Display Name`.

## Read-only inspection and planning

`inspect` and `plan` never alter source vault files or durable operational
records. The CLI writes only the explicitly requested report or manifest
output. The manifest records:

- a `source_fingerprint` of the source vault and the durable history/journal
  snapshot, excluding disposable indexes, model caches, and the migration
  output directory so the hash is not self-referential;
- every source file's relative path and SHA-256;
- legacy logical and revision identifiers, parent relationships, and the
  selected current head;
- the proposed readable current path and each historical destination;
- rewritten link targets and any conflicts;
- a versioned `manifest_sha256` integrity digest.

Current heads are selected with the existing revision DAG rules, never by file
name or modification time.

## Blockers

Forks, duplicate revision identifiers, malformed content, unsupported schema
versions, unmappable project identities, and unsafe targets are recorded as
blockers. An unreadable managed file is associated with its recoverable
`brain_id` so it blocks the whole affected logical note; if no identity can be
recovered it is reported as an actionable unresolved blocker. A blocked note is
reported and left byte-for-byte in place. It is never discarded and never moved
to a guessed note.

Applying refuses by default whenever any blocker exists and enumerates every
blocked item. An operator can opt in to partial migration with `--partial`,
which migrates only the unblocked notes and still reports the full blocked set.

## Applying

Applying requires a saved, hash-verified manifest, a verified backup, and
exclusive maintenance mode (`--maintenance`). The backup must be present at
`--backup-root`; applying re-reads the backup media, hashes it, and refuses
unless the receipt matches both the backup bytes and the freshly recomputed
source fingerprint. A mismatch refuses the apply.

Maintenance is enforced by the state-wide gateway lock, so the migration and
the serving gateway cannot mutate concurrently; the lock is released when the
command finishes. Lock acquisition precedes journal, fingerprint, and backup
preflight. Stale-lock reclamation uses an exclusive `gateway.lock.recovery`
directory; if a process dies holding that claim, investigate the lock owner
and remove the abandoned recovery directory manually before retrying.

Migration steps are journaled, restartable, and idempotent:

- durable history is written and verified before any visible legacy revision is
  removed;
- each phase persists exact post hashes in
  `state/migrations/<manifest_sha256>/journal.json`;
- free space is checked before copying;
- a second apply is a no-op only when every completed destination still matches
  its recorded hash.

A failed verification leaves the original backup untouched. Cleanup only ever
targets the exact source paths named in the manifest.

Relative links are resolved against each source's original location, including
attachments, and rewritten through the actual old-to-new path map rather than
by substituting UUID-shaped strings. One current file is materialized per
resolved logical note, preserving logical ids, approval records, and historical
revision ids without preserving caller permissions. Approval status is only
carried into a readable note when its recorded payload hash is valid; otherwise
the note is conservatively materialized as an unreviewed candidate while its
raw approval record stays in durable history. A project hub link is written
only when the hub file already exists; until then the project association is
kept in the manifest without emitting a broken link. Unmanaged human notes,
attachments, `.obsidian` settings, and Canvas/Base files are preserved.

## Verifying

`verify` reports counts, hash failures, UUID path components, duplicate heads,
and dangling internal links. Dangling links that already existed before the
migration are excluded so only newly broken links are reported. A non-zero exit
code means the migration needs operator attention.

## Rolling back

Rollback is exact only while the migrated vault has not received new writes.
Before changing anything it verifies every durable history copy, every
destination, and that the live vault inventory still matches the recorded
post-migration inventory; any added, changed, or removed file stops rollback
and is reported instead of overwriting newer work. Only then does it restore
legacy revisions and remove generated notes, journaling each stage so an
interrupted rollback can restart without destroying data. Migration history is
retained after rollback for diagnosis, and recovery never requires Basic Memory
to remain online. On restart, history and the adjusted vault inventory are
checked again, including the recorded bytes of already-restored source files.
