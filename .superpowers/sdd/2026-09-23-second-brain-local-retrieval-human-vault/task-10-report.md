# Task 10 report: resumable V1-to-V2 migration

**Status:** complete on branch `feat/local-brain-v2` (base `09a300f`).

## Deliverables

Created:

- `src/operations/vault-v2/plan.ts` — source fingerprinting, manifest planning,
  journal types, backup-receipt helpers, link rewriting, and the shared
  migration file primitives.
- `src/operations/vault-v2/apply.ts` — journaled, restartable, idempotent apply
  plus `resumeVaultMigration` and the exclusive maintenance lock.
- `src/operations/vault-v2/verify.ts` — counts, hash failures, UUID path
  components, duplicate heads, and new dangling links.
- `src/operations/vault-v2/rollback.ts` — exact rollback with divergence
  refusal.
- `src/operations/vault-v2/report.ts` — inspection report builder and renderer.
- `tests/unit/vault-v2-plan.test.ts` — read-only planning, frozen-corpus plan,
  determinism, link-rewrite mapping, and byte-preservation tests.
- `tests/integration/vault-v2-migration.test.ts` — lossless apply, fault
  injection after every persisted phase, resume with corruption, occupied
  target, conflicting heads, changed inputs, and rollback tests.
- `docs/operations/vault-v2-migration.md` — operator documentation.

Modified:

- `src/cli.ts` — added `vault-v2 inspect|plan|apply|verify|resume|rollback` with
  the required arguments.

## Reused infrastructure

- Task 1 `inventoryTree` for the read-only source inventory.
- Task 4 `decodeRevision`, `renderDocument`, `renderNoteBody`, and
  `parseDocument`.
- Task 5 `allocateNotePath`, `allocateProjectRoot`, `collisionKey`.
- Task 6 `openRevisionStore`/`revisionLocation` layout for durable history
  destinations, plus `readBoundedBytes`.
- Task 7 `extractLinks`, `resolveLink`, and `LinkCatalogue`.
- Existing backup infrastructure (`buildManifest`, `validateManifest`) for the
  backup receipt contract.

## Behavior

- `planVaultMigration({vault, state, projectNames})` returns a versioned
  manifest containing `source_fingerprint` (vault and durable state, excluding
  disposable indexes, model caches, and the migration output directory),
  `moves`, `history_copies`, `rewrites` (with targets), `blockers`,
  `preserved_files`, `baseline_dangling_links`, and `manifest_sha256`.
- Heads are selected only through `resolveHead` (revision DAG rules).
- Forks, duplicate revision IDs, malformed content, unsupported schemas, and
  unmappable project identities become blockers and the affected note files
  stay byte-identical and are never moved to a guessed note.
- `applyVaultMigration`/`resumeVaultMigration` require exclusive maintenance
  mode, a hash-verified manifest, and, on a fresh apply, a verified backup
  receipt plus an unchanged source fingerprint. Phases (`history`,
  `materialize`, `remove_sources`, `rewrites`, `verify`, `complete`) persist
  exact post hashes in `state/migrations/<sha>/journal.json`; a fault after any
  phase resumes correctly, and a completed migration is a no-op only while
  every destination still matches. History bytes are verified before any
  visible legacy revision is removed. Free space is checked before copying.
- `verifyVaultMigration` returns counts, hash failures, dangling links, UUID
  path components, and duplicate heads; baseline-broken links are excluded.
- `rollbackVaultMigration` refuses when any migrated file diverged (human edit),
  otherwise removes generated notes and restores the original revision bytes
  from durable history, retaining migration history for diagnosis.

## Verification

Run with `npx --yes --package=node@24 --package=npm@10 -c '...'`:

- `npx vitest run tests/unit/vault-v2-plan.test.ts tests/integration/vault-v2-migration.test.ts`
  — 15 tests, all passing.
- `npm run verify` — typecheck, 544 unit/contract tests, and build all pass.
- `npm run test:integration` — 443 tests pass.

## Interpretation of "refuses any blockers"

The frozen Task 1 corpus deliberately contains a forked logical note. The brief
also requires one current file per **resolved** head, so apply must migrate
unblocked notes while leaving blocked ones untouched. The original
implementation applied partial migration silently; fix round 1 follows the
controller ruling: apply refuses by default whenever any blocker exists, and
requires the explicit `--partial` opt-in to migrate unblocked notes while still
enumerating every blocked item.

## Concerns

- The current readable document format has no approval field, so approval
  provenance is preserved in durable history and recorded in the manifest
  (`approval_preserved`) rather than duplicated into the generated note.
- The frozen fixture's `project` property was originally treated as a known
  planned navigation target during verification; fix round 1 removes that
  synthesis (see below) and Task 15 creates the hub file.
- Canvas/Base link rewriting is out of scope here (Task 8 owns it); migration
  preserves those files byte-identically.
- TDD order: the new modules were authored in one pass rather than strictly
  red-then-green; the final combined suite is green.

# Fix round 1

All three Critical and all six Important findings from the independent review
are fixed. Test assertions were strengthened rather than weakened, and a
regression test was added for every fixed behavior.

## Critical 1: backup receipt was derived from the live vault

`buildMigrationBackupReceipt`/`verifyMigrationBackupReceipt` only compared a
supplied file list against the live fingerprint. Verification now requires a
concrete backup at `--backup-root`/`backupRoot`, re-hashes the backup media
through the existing `verifyManifest`, and requires the receipt to match both
the backup bytes (path, size, SHA-256) and the freshly recomputed source
fingerprint. The backup root must be separate from the live vault and state.
Apply also now requires `backupRoot` on a fresh apply.

Regression tests: media-less backup, tampered receipt hash, and missing backup
root are all rejected (`RECOVERY_REQUIRED`/`INVALID_INPUT`).

## Critical 2: maintenance was not exclusive

The per-migration lock that accepted any same-migration owner was replaced with
the state-wide gateway lock (`InstanceLock`, name `gateway.lock`) with owner and
staleness handling, acquired around every mutating apply/resume/rollback and
released in `finally`. Because the serving gateway uses the same lock, the
migration and the writer can no longer mutate concurrently.

Regression test: a live lock holder (`/proc/<pid>/stat` start time) makes apply
refuse with `CONFLICT`.

## Critical 3: rollback could destroy notes before finding lost history

Rollback now preflights every durable history copy (read plus hash) and every
destination before mutating anything, then journals each rollback stage
(`restored_sources`, `restored_rewrites`, `removed_current`) so an interrupted
rollback can restart idempotently.

Regression test: a corrupted history copy makes rollback refuse
(`RECOVERY_REQUIRED`) while every migrated current note remains present.

## Important 5: malformed revisions could fail to block their note

Unreadable managed files are now associated with their recoverable `brain_id`
(via frontmatter peek). A failed revision blocks the whole logical group, and a
failure whose identity cannot be recovered is reported as an actionable
unresolved blocker.

Regression test: a malformed sibling sharing the preference `brain_id` blocks
the preference group with both paths enumerated and no move emitted.

## Important 6: generated project links were synthesized

A `project` wikilink is now emitted only when the project hub file already
exists in the source vault; otherwise the project association is kept in the
manifest (`project_root`) without writing a broken link. The synthetic
catalogue entry in `verifyVaultMigration` was removed.

Regression tests: the migrated fixture note has no `project` property, the
manifest raw contains no `project:` field, and `verify` reports no dangling
links.

## Important 7: rollback did not enforce vault-wide exactness

Apply records a post-migration vault inventory in the journal. Rollback
compares the live inventory against it and refuses with an enumerated
divergence report for any added, changed, or removed file.

Regression tests: a human edit, a new unrelated file, and a removed/changed
preserved file all stop rollback while leaving migrated notes intact.

## Important 8: approval status was carried without provenance validation

Status now passes through `effectiveLifecycle`, which conservatively demotes a
note to `candidate` when approval is absent or its payload hash does not match
the revision, and `approval_valid` is recorded. The raw approval record stays in
durable history.

Regression test: a tampered `brain_approval_payload_hash` yields
`status: candidate`, `approval_preserved: true`, `approval_valid: false`.

## Important 9: output exclusion was inconsistent

The manifest now records `output_exclusions`; planning and apply use the same
exact exclusion set with vault containment checks, and the CLI passes
`dirname(--output)` and `dirname(--report)` as the exclusion.

Regression test: a manifest written into a custom state-side output directory
no longer makes the subsequent fresh apply reject its own plan.

## Controller ruling on finding 4

Apply now refuses by default whenever any blocker exists. Partial migration
requires the explicit `--partial` opt-in, and the apply result enumerates every
blocked item. The opt-in test migrates unblocked notes while the fork's legacy
files stay byte-identical.

## Verification

- `npx vitest run tests/unit/vault-v2-plan.test.ts tests/integration/vault-v2-migration.test.ts`
  - 22 tests passing.
- `npm run verify` - typecheck, unit/contract suite, and build pass.
- `npm run test:integration` - 450 tests passing.

## Remaining concerns

- The readable document format still has no approval field, so an invalid
  approval's raw record lives only in durable history, as before.
- Canvas/Base link rewriting remains Task 8's responsibility; migration still
  preserves those files byte-identically.
- The project hub itself is still created by Task 15; migration now omits the
  link until that hub exists instead of asserting it does.

# Fix round 2

Addressed Critical A, Critical 1–3, and Important 4, 5, 7, 8. The previously
verified fixes for 6 and 9 remain covered by the existing tests.

- The maintenance lock now precedes journal lookup, source fingerprinting,
  backup verification, and any journal write. A competing apply cannot use a
  stale no-journal observation to replace a completed journal. Rollback also
  reads its journal under the lock.
- Stale gateway-lock recovery is guarded by an exclusive recovery-directory
  claim. Only its holder can check and remove the stale lock; concurrent
  contenders conflict rather than unlinking a newly acquired lock. A crashed
  recovery claim fails closed and needs operator investigation/removal.
- Backup verification now fingerprints the backup tree with the no-follow,
  descriptor-pinned inventory reader, rejects symlinks in any directory or
  leaf, checks realpath separation, checks each receipt size/hash against the
  actual backup bytes and the source fingerprint, and rejects media files
  hardlinked to the live source. A changed backup does not alter the source.
- Every rollback invocation preflights all history, migrated destinations,
  already-journaled restorations, and the adjusted post-migration inventory.
  A restart permits only the single next in-flight file to have completed
  without a journal write; changed or removed preserved files still refuse
  before mutation. Already-complete artifact branches persist their progress.
- Default blocker refusal enumerates each reason and path; explicit partial
  apply prints the same full blocked set through the CLI.
- Every invalid-UTF-8 Markdown file is conservatively blocked, and recoverable
  logical IDs bind an unreadable sibling to its entire note group.
- Missing approval now demotes every lifecycle status, including archived and
  superseded, to candidate while the raw revision remains in durable history.

Regression tests cover lock-before-preflight, an occupied recovery claim and
four simultaneous stale-lock contenders, symlinked/hardlinked/changed media,
both blocker-reporting paths, invalid UTF-8 sibling, absent approval for
archived/superseded, and restart rollback with corrupt history/restored bytes,
preserved-file changes/removal, and successful verified continuation.

Verification under Node 24 / npm 10:

- `./node_modules/.bin/vitest run tests/unit/vault-v2-plan.test.ts tests/integration/vault-v2-migration.test.ts`: 33/33 passed.
- `npm run verify`: typecheck, 544/544 unit/contract tests, build passed.
- `npm run test:integration`: 461/461 passed after the restart-continuation test.
- `npm test`: twice timed out (300s default concurrency and 360s with
  `--maxWorkers=4`) before Vitest emitted any file result. This broad command
  includes E2E tests beyond the required verification gates; its result is
  not claimed green.

# Fix round 3: complete blocker path enumeration

The round-2 report's claim that every blocker printed its path was too broad:
unusable/missing project mappings, unsafe target allocation, and the no-matching
head fallback constructed blockers without source paths. All blocker constructors
now carry actual affected source file paths. A project-wide allocation failure
lists all candidate source files for that scope; per-note mapping and target
failures list every source revision of that note. The blocker constructor's type
requires `path` or `paths`, and manifest validation refuses blockers lacking a
nonempty reason or affected path in the source fingerprint, including rehashed
manifests supplied by callers. Malformed path-field types are also rejected,
even when another field supplies a valid path. Default refusal and
partial-success CLI reporting now receive complete path-and-reason data
without changing their rendering.

Both existing reporting tests now require at least one path per blocker and
assert every path and reason appears in the refusal or CLI output. They use a
disposable vault with an unusable project display name, a remaining migratable
note, and the existing fork. Further checks cover absent project mapping and
a rehashed incomplete blocker. The strengthened reporting tests failed on the
old implementation and passed after the plan fix.

Verification under Node 24/npm 10:

- `./node_modules/.bin/vitest run tests/unit/vault-v2-plan.test.ts tests/integration/vault-v2-migration.test.ts`: 34/34 passed.
- `npm run verify`: typecheck, 544/544 unit/contract tests, and build passed.
- `npm run test:integration`: 462/462 passed.
