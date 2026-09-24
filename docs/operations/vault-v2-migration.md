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
node dist/cli.js vault-v2 apply --manifest /var/lib/second-brain/migrations/manifest.json --backup-receipt /var/lib/second-brain/migrations/backup.json --maintenance
node dist/cli.js vault-v2 verify --manifest /var/lib/second-brain/migrations/manifest.json
node dist/cli.js vault-v2 resume --manifest /var/lib/second-brain/migrations/manifest.json --maintenance
node dist/cli.js vault-v2 rollback --manifest /var/lib/second-brain/migrations/manifest.json --maintenance
```

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
blockers. A blocked note is reported and left byte-for-byte in place. It is
never discarded and never moved to a guessed note. Notes that are not blocked
still migrate.

## Applying

Applying requires a saved, hash-verified manifest, a verified backup receipt,
and exclusive maintenance mode (`--maintenance`). The backup receipt is a
standard backup manifest whose file hashes must match the freshly recomputed
source fingerprint; a mismatch refuses the apply.

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
resolved logical note, preserving logical ids, approval provenance, and
historical revision ids without preserving caller permissions. Unmanaged human
notes, attachments, `.obsidian` settings, and Canvas/Base files are preserved.

## Verifying

`verify` reports counts, hash failures, UUID path components, duplicate heads,
and dangling internal links. Dangling links that already existed before the
migration are excluded so only newly broken links are reported. A non-zero exit
code means the migration needs operator attention.

## Rolling back

Rollback is exact only while the migrated vault has not received new writes.
If any migrated current file, rewritten file, or restored legacy path differs
from its recorded post-migration hash, rollback stops and reports the
divergence instead of overwriting newer work. Otherwise it removes generated
current notes and restores the original legacy revision files from durable
history. Migration history is retained after rollback for diagnosis, and
recovery never requires Basic Memory to remain online.
