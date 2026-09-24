# Task 8 Report: Add safe rename and move with link rewriting

**Status:** Complete
**Branch:** `feat/local-brain-v2` (base `6ef8e2c`)
**Commit:** `73e2304640e9c822c59f227c09062459eec45a21` — `feat: move notes without breaking Obsidian references`
**Date:** 2026-09-24

## Files

Created:

- `src/notes/rename.ts` — pure plan construction, reference rewriting (Markdown / `.canvas` / `.base` / `.obsidian` scanning), rename plan/receipt types.
- `tests/unit/rename-plan.test.ts` — 13 planning tests.
- `tests/integration/rename-recovery.test.ts` — 9 apply/recovery tests.

Modified:

- `src/storage/journal.ts` — durable multi-file move persistence (`local_move_operations`, `local_move_files`, reserve/update/find/list methods).
- `src/storage/document-store.ts` — `applyRename(plan)` orchestration, per-file journaling, fault hooks, move recovery wired into `recover()`.
- `src/contracts/protocol.ts` — `reviewMoveOperation` schema (specified, deliberately *not* added to `reviewRequestSchema`).
- `src/core/types.ts` — `ReviewMoveOperation` interface (specified, deliberately *not* added to `ReviewRequest`).

No Task 9+ work was started.

## Interfaces

`planRename({ from, to, files })` returns `{ moves, edits, unresolved, conflicts }` (plus `source_hash` and `idempotency_key` — see Decisions). Edit entries are `{ path, expected_hash, raw }` (source path, expected sha256 of the observed bytes, and the new bytes). File snapshots are `{ path, raw, hash }`. Link extraction and resolution are Task 7's `extractLinks` / `resolveLink`; replacements are applied in descending source-offset order over the whole reference span, so labels, fragments, embeds, quoting, and surrounding text are preserved. Wikilink targets drop a note `.md` extension; attachment embeds keep theirs.

`applyRename(plan)` is exposed on the document store (`store.applyRename(plan)`), where durable journaling, revision history, the index hook, and the store's mutation lock already live. That keeps the single-argument call shape while the state/vault handles stay with the store rather than leaking into the plan.

### Planning behavior

- Only references that genuinely resolve to the moved path are rewritten. Reference rewriting re-resolves each reference against a post-move catalogue; a reference is changed only when its resolution would otherwise move or break.
- Inline code, fenced code, and HTML ranges are excluded by Task 7's extractor (the brief's verbatim test passes unchanged).
- Relative Markdown links are rebased from the new source directory; wikilinks resolve to the new canonical vault path. Relative links *inside* the moved note are rebased from its new folder too.
- Ambiguous short names are reported, never guessed. Unresolved references are reported and left byte-for-byte untouched.
- Case-only renames plan a two-step, case-safe move: `from → <stem>.case-rename-tmp<ext> → to`.
- An occupied target (including case-variant occupancy) is reported as a `target_occupied` conflict.
- `.canvas`: parsed as JSON; `type: "file"` node paths are rewritten while node ids, coordinates, sizes, and edges are preserved; `type: "text"` node strings go through the Markdown rewrite. Original indentation is detected and preserved.
- `.base`: only scalar values that are exactly a resolvable link/path are rewritten (per-scalar YAML nodes, no global replacement). Scalars that merely *contain* the moved path (for example `file.path == "…"` formula expressions) are reported as `unsupported` and left unchanged.
- `.obsidian/**`: never edited. References that resolve to the moved path are reported with reason `manual` for human attention.
- A malformed `.canvas`/`.base` is reported rather than corrupting the file.

### Journaled move phases

Exact brief sequence, per file:

1. `reserve target path and move operation` — occupancy/conflict checks, idempotency reservation (`local_move_operations`).
2. `persist link-edit manifest and preimages` — manifest plus one `local_move_files` row per source/edit with the observed preimage bytes and expected hash.
3. `validate every affected file against its expected hash` — preimage hashes are checked again before any write; any drift is a `CONFLICT`.
4. `perform case-safe temporary rename when needed` — one rename step for ordinary moves, two for case-only moves.
5. `apply each reference edit with conflict checks` — atomic temp-file replacement, re-checking the preimage immediately before replacement.
6. `update ID/path and graph records` — `local_documents` moves `from`→`to` with the same logical id/revision, and affected paths are enqueued for reindexing (the disposable index is best-effort).
7. `verify every rewritten reference and finalize the receipt` — the move re-plans from the persisted preimages and requires the produced edits to equal the applied edits, then stores `RenameReceipt`.

A multi-file move is not globally atomic: each `local_move_files` row advances independently. An interruption leaves partial state; `recover()` (run on open) resumes from the per-file rows. If current bytes match neither the expected preimage nor the planned result, the move is marked `conflict` and recovery stops rather than continuing. Idempotent replay of a completed move returns the stored receipt; reusing a key with different bytes is `IDEMPOTENCY_CONFLICT`.

## `brain_review` move contract (Task 14 seam)

Specified here so Task 14 can add it to the union and handlers together:

```json
{ "action": "move", "idempotency_key": "...", "id": "...", "target_path": "...", "expected_etag": "...", "rationale": "..." }
```

Exported as `reviewMoveOperation` (Zod, `src/contracts/protocol.ts`) and `ReviewMoveOperation` (TS, `src/core/types.ts`). Neither is added to `reviewRequestSchema` or `ReviewRequest` in this commit, so the current exhaustive `switch` in `src/features/review.ts` stays type-correct.

## Tests

- `npx vitest run tests/unit/rename-plan.test.ts tests/integration/rename-recovery.test.ts` — **22 passed** (13 unit, 9 integration); confirmed failing first (missing `src/notes/rename.js`) before implementation.
- `npm run verify` — typecheck + **530 unit/contract tests passed** + build.
- `npm run test:integration` — **389 tests passed** (19 files).

Required scenarios covered: moves across project folders, case-only renames, target occupied after planning, one edited backlink mid-operation, attachment embeds, deleted targets, interrupted multi-file operations, and id/history survival. Extra coverage: preserved label/fragment and untouched code, ambiguous short names, rebased relative links (both into and inside the moved note), canvas node ids/layout, base formula reporting, obsidian manual reporting, and move idempotency replay.

## Decisions and deviations

- `applyRename` lives on `DocumentStore` rather than as a free function so it can use the existing vault/state handles, lock, history store, and index port while keeping the `applyRename(plan)` call shape.
- `RenamePlan` carries two extra fields required by durable application: `source_hash` (the expected hash of the source) and `idempotency_key` (defaults to `rename:<from>-><to>`; Task 14 will pass `brain_review`'s key).
- File renames are still `fs.rename` after an occupancy check, not a no-clobber `link`, matching the brief's "case-safe temporary rename" wording. A non-cooperating writer racing between the check and the rename is not fully preventable, consistent with the Task 6 note that an atomic rename is not a cross-process compare-and-swap.
- "Graph records" currently means reindexing affected paths; the persistent graph/store arrives in Task 11, so nothing graph-specific is invented here.

## Concerns

- Verification re-plans from persisted preimages plus current non-affected files. A concurrent human edit to an *unaffected* file that changes reference resolution toward the moved note will make verification fail closed (`CONFLICT`) rather than silently accept divergence — intended, but worth knowing for Task 14 integration.
- Binary attachments are skipped during verification snapshotting (unreadable as UTF-8); they are never rewritten, only their textual references are.

---

# Task 8 Fix Round 1

**Status:** Complete
**Commit:** `adef85ce9d4a69ae6a20b8b2dcc4dcbd899cbf6c` — `fix: make note moves no-clobber and recoverable`
**Fixes:** all 4 Critical, all 3 Important, and the 1 Minor finding.

This section supersedes the earlier "File renames are still `fs.rename`" and "Binary attachments are skipped" notes; both behaviors changed below.

## Critical fixes

1. **No-clobber move and protected replacement.** Move steps now use `link(from, to)` then `rm(from)` (a no-replace primitive: `link` fails `EEXIST`), never overwriting an occupied destination; a concurrent duplicate (crash between link and rm) is resolved by inode identity. Backlink rewrites pin the verified inode with a hard link, re-check the pinned hash and target inode immediately before replacement, replace via an atomic rename, and roll back to the pinned inode on any post-replacement divergence. New tests: `a target created between the check and the move is never overwritten`, `a backlink changed during the rewrite keeps the human bytes`. New fault hooks `beforeMoveStep`/`beforeEditReplace`.
2. **Case-only recovery after the temporary step.** Each move step is journaled independently in `local_move_steps` (atomic with the manifest), and recovery locates the source among all step endpoints by byte hash. Test: `a case-only rename interrupted after its temporary step recovers` (faults after step 0, then reopens and completes).
3. **Receipt must reflect disk.** Before finalizing, every affected file (source at its final path and every edit) is re-read and checked against its expected final byte hash; `verifyMove` now compares the re-plan against *current file bytes* rather than journaled replacement strings. Test: `a divergent backlink prevents a verified receipt` (mutates an applied backlink before finalization → `CONFLICT`).
4. **Atomic manifest persistence.** `LocalWriteJournal.reserveMove(input, files, steps)` inserts the operation, all file rows, and all step rows in one SQLite transaction, and `runMove` rejects a reservation whose row/step counts do not match the manifest. Test: `an incomplete multi-file reservation is rejected instead of partially applied` (deletes a row from `documents.sqlite`, reopens, asserts no partial move).

## Important fixes

5. **Binary attachment moves.** `readNoteFile` gained bounded `maxBytes`/`requireUtf8` options; moves read source preimages byte-exactly (`MOVE_MAX_BYTES` 8 MiB) and keep byte hashes, storing `''` as the journaled preimage when the bytes are not valid UTF-8. Test: `a binary attachment move preserves bytes and rewrites embeds` (asserts exact `Buffer` equality and embed rewrite).
6. **`.base` span-only rewriting.** Supported lone link/path scalars are replaced by their exact YAML source span; formulas or any other scalar containing the moved path are reported `unsupported` and never modified, and the file is not reserialized. Tests: `a base formula that embeds a resolvable link is reported, not rewritten`, `a base with no supported reference is left byte-for-byte untouched`.
7. **Revision provenance.** Rewritten managed sources get a new persisted revision (unchanged sources keep theirs), and rewritten managed backlinks get a persisted revision plus an updated `local_documents` record, keeping id/hash/revision aligned. Tests: extended `a move rebases a relative link inside the moved note itself` and new `a managed backlink gets a durable revision after a rewrite` (new `revision_id`, rewritten historical bytes readable, original revision retained).

## Minor fix

8. **Read-only `.obsidian` planning inventory.** New `collectRenameSnapshots(root)` walks the vault including `.obsidian` (skipping `.git`, symlinks, and other dot-directories) and returns byte-hashed snapshots for planning only. Test: `planning includes obsidian bookmarks read-only` (manual report produced, no edit, bytes unchanged after apply).

## Test commands and results

- `node ./node_modules/vitest/vitest.mjs run tests/unit/rename-plan.test.ts tests/integration/rename-recovery.test.ts` — **32 passed** (15 unit + 17 integration).
- `npm run verify` — typecheck + **532 unit/contract passed** + build.
- `npm run test:integration` — **397 passed** (19 files).

## Not fixed

None. All findings above are addressed with a dedicated test.

---

# Task 8 Fix Round 2

**Status:** Complete
**Base:** `adef85c` — this round supersedes Round 1's claims about backlink replacement and binary preimage persistence.

## Open findings addressed

- **Critical 1 and B — backlink races:** Replacement now stages the old path in a private, unique directory, checks the staged inode and bytes against the pinned preimage, then installs the new bytes with a no-clobber hard link. A human replacement between the inode check and staging is detected and restored only with a no-clobber link if the path is vacant; if another writer has filled the path, its bytes stay in place and the staged bytes are retained for manual reconciliation. A human replacement after installation is never overwritten by rollback. Tests interleave at both exact boundaries, asserting conflict and human-byte preservation.
- **Critical A — rewritten source recovery:** Recovery recognizes the final destination's planned `new_hash` when the source itself was edited and continues from the final step; the moved managed note receives its new durable revision. An interruption immediately after source editing is recovered on reopen, with id, revision bytes, and old-path absence asserted.
- **Important 5 — binary preimages:** The move journal stores bounded, byte-exact `Buffer` preimages as SQLite BLOB values (existing TEXT rows remain readable), and re-planning uses their exact bytes to distinguish valid text from binary. The binary attachment integration test now inspects the persisted preimage bytes.
- **Important 6 — formula references:** Unsupported `.base` scalar formulas now report resolvable stem-form wikilinks to the moved note as `unsupported`, without rewriting the formula. A dedicated unit test checks `file.hasLink("[[Laya]]")`.
- **Important 7 — revision interruption:** The source's new revision is persisted before record changes; the old-path delete and new-path record insertion run in one SQLite transaction. An injected interruption at the revision-persist boundary confirms the old record still exists, and reopening restores the moved revision.
- **Important C — stale old source:** Recovery rejects any unexpected bytes or unreadable occupancy at move-step endpoints, including a changed original source beside a matching destination; before receipt it independently checks that the original path is absent. Removal stages the old path, verifies its inode against the linked destination, and restores unexpected bytes only with a no-clobber link. A test interrupts after destination linking and changes the original path, then checks no verified receipt on recovery. A second interruption test ensures stranded staged source bytes cannot become a verified receipt; recovery stops in conflict rather than hiding them.

Existing verified findings 2, 3, 4, and 8 remain covered by their previous tests. Multi-file moves remain non-atomic. A crash leaving a nonempty staging directory deliberately stops recovery for human reconciliation; no file at an occupied path is replaced or silently merged.

## Verification

- `PATH=/tmp/opencode/node-v24.15.0-linux-x64/bin:$PATH node ./node_modules/vitest/vitest.mjs run tests/unit/rename-plan.test.ts tests/integration/rename-recovery.test.ts` — **39 passed** (16 unit, 23 integration).
- `PATH=/tmp/opencode/node-v24.15.0-linux-x64/bin:$PATH npm run verify` — typecheck, **533 unit/contract passed**, build passed.
- `PATH=/tmp/opencode/node-v24.15.0-linux-x64/bin:$PATH npm run test:integration` — **403 passed** (19 files).

## Not fixed

None of the listed open findings remain unresolved.

---

# Task 8 Fix Round 3

**Status:** Complete. **Base:** `a1bea3c`. This section supersedes Round 2's claims for the case-only edited-source recovery, the revision-persist interruption test, and backlink cleanup.

- **Critical A:** Recovery identifies the source's verified position among all move-step endpoints, marks earlier steps complete, and continues only with remaining steps. The final rewritten case-only destination can therefore resume when both the original and temporary names are absent. A new interruption test stops after rewriting that destination and checks the recovered managed id, revision bytes, and absent old paths.
- **Important 7:** Added a fault boundary *after* `persistRevision` and *before* the atomic `moveDocument` transaction. The test verifies the new revision exists while the old database path remains and the new path does not; after reopening, the managed revision id matches the revision persisted before interruption, and its bytes match the moved note. The source revision id is now the move operation's durable UUID, so retrying persistence reuses and integrity-checks the same immutable revision instead of creating an orphan.
- **Critical D:** A file descriptor pins the original backlink inode from backup creation until cleanup completes. Before unlinking either staged or backup path, cleanup confirms that path still names the pinned inode and re-hashes its current bytes through the descriptor; after removing the staged link, it checks the pinned backup again immediately before its removal. Unexpected content or a replaced link causes a conflict and leaves the still-linked inode available for manual reconciliation. A new test holds an open human descriptor across replacement, writes to it after the replacement is verified and before cleanup, and asserts conflict, retained human bytes and nonzero link count.

The pinned descriptor is closed on every normal, conflict, or error path. The backup and staged links are only removed after validation; on divergence they stay available, while the installed replacement remains at its path without overwriting any later human replacement. As with all uncooperative in-place writers, a write after the final content check and before the unlink cannot be made atomic with that unlink by a filesystem hash check; this round covers the specified controlled interleaving without claiming cross-process exclusion.

## Verification

- `PATH=/tmp/opencode/node-v24.15.0-linux-x64/bin:$PATH node ./node_modules/vitest/vitest.mjs run tests/integration/rename-recovery.test.ts` — **25 passed**.
- `PATH=/tmp/opencode/node-v24.15.0-linux-x64/bin:$PATH npm run verify` — typecheck, **533 unit/contract passed**, build passed.
- `PATH=/tmp/opencode/node-v24.15.0-linux-x64/bin:$PATH npm run test:integration` — **405 passed** (19 files).

## Not fixed

None of the three reported interleavings remains unresolved. Cross-process writers modifying the inode *after* the last verification are not excluded by filesystem hash checks without a cooperative lock; they remain outside the deterministic interleavings exercised here.
