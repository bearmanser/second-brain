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
unblocked notes while leaving blocked ones untouched. `applyVaultMigration`
therefore refuses changed inputs, refuses an all-blocked manifest, and skips
(individually blocks) affected notes; blockers remain fully reported in the
manifest and inspection report. This is the only reading consistent with both
the frozen-fixture requirement and the per-note blocking language.

## Concerns

- The current readable document format has no approval field, so approval
  provenance is preserved in durable history and recorded in the manifest
  (`approval_preserved`) rather than duplicated into the generated note.
- The frozen fixture's `project` property generates a project-hub wikilink that
  is treated as a known planned navigation target during verification; the hub
  file itself is created by Task 15.
- Canvas/Base link rewriting is out of scope here (Task 8 owns it); migration
  preserves those files byte-identically.
- TDD order: the new modules were authored in one pass rather than strictly
  red-then-green; the final combined suite is green.
