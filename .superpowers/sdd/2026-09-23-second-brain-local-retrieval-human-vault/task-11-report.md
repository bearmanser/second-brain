# Task 11 Report: Local chunk, property, link, and FTS5 index

## Status

Complete and committed on `feat/local-brain-v2`.

- Commit: `5fd7149247f936e49720d7dbe44c53d153a04e4c` — `feat: index current notes with local FTS5 and bounded graph retrieval`
- Base: `c7b17f4`
- Tests: `npm run verify` green (556 unit + contract tests, typecheck, build with copied SQL asset); `npm run test:integration` green (475 tests, 22 files).

## Deliverables

Created (all within the brief's file list):

- `src/storage/search-index.ts` — `openSearchIndex(path)` and the disposable index.
- `src/storage/search-schema.sql` — contentful FTS5 table plus ordinary document/chunk/property/link tables.
- `src/retrieval/chunker.ts` — `SearchChunk`, `chunkDocument(document, raw)`.
- `src/retrieval/query.ts` — `literalMatch(query)`, `Candidate`, filter helpers.
- `src/retrieval/graph.ts` — graph expansion (`expandGraph`, `createGraphExpander`).
- `tests/unit/search-query.test.ts`, `tests/unit/chunker.test.ts`, `tests/integration/local-search.test.ts`.

Modified:

- `src/notes/reconcile.ts` — added `indexReconciledDocuments()` which supplies reconciled current documents/removals to an index sink.
- `src/runtime.ts` — opens the disposable index at `<state>/index/search.sqlite`, feeds it on initial and observer reconciliation, closes it on shutdown.
- `scripts/copy-assets.mjs` — copies `search-schema.sql` into `dist/storage/`.

No files outside the brief's list were changed.

## Interface conformance

- `openSearchIndex(path)` returns: `replaceDocument({path, raw, etag})`, `deletePath(path)`, `candidates({query, project?, types?, statuses?, limit})`, `close()`. It additionally implements `upsert/remove` so `reconcile.ts`/`document-store`/`runtime.ts` can treat it as a `DocumentIndex`.
- `literalMatch(query)` returns a safely quoted FTS5 expression or `null`.
- `chunkDocument(document, raw)` returns exact source slices.
- `expandGraph(seedKeys, filters, limit)` returns resolved neighbouring document keys and the edges that introduced them. It is exposed as an index method with exactly that signature; `graph.ts` exports the implementation `expandGraph(store, seedKeys, filters, limit)` plus the bound factory `createGraphExpander(store)` returning `{ expandGraph(seedKeys, filters, limit) }`.
- `SearchChunk` fields exactly as specified (`heading` is `string | null`; only `id` is optional).
- `Candidate` extends `SearchChunk` with `lexical_rank: number | null`, `candidate_position`, `reasons`. No model score appears in either type.

## Requirement coverage

- FTS5 definition used verbatim (columns `title, aliases, tags, heading, text`, `tokenize = 'unicode61 remove_diacritics 2'`), created with `IF NOT EXISTS` for idempotent open.
- Ordinary `chunks` table uses `row_id INTEGER PRIMARY KEY` matching the FTS5 rowid.
- Replacements delete obsolete chunk rows and their FTS rows and insert replacements inside one `transaction.immediate()`.
- All queries/filters use bound `?` parameters; only hardcoded column names and `?` placeholders are concatenated, and type/status filters are validated against allowlists before use.
- Ordering is `bm25(chunks_fts, 8, 6, 4, 3, 1)` ascending with `path`, `start_offset` tie-breakers; lower BM25 ranks better.
- `literalMatch` uses up to 64 unique Unicode letter/number terms (case-insensitively deduplicated), escapes embedded quotes, and ORs quoted terms. Empty/punctuation-only input yields an explicit `INVALID_INPUT` error rather than a whole-index scan.
- Exact title/path/alias matches are a separate candidate channel (`title`, `path`, `alias` reasons), independent of FTS syntax.
- Filters (`project`, `types`, `statuses`) are applied in SQL `WHERE` before `LIMIT`; the exact channel applies the same filters before merging; the merge truncates to the limit after dedupe.
- Chunking splits at heading/block boundaries, packs blocks to a 256-reference-token target, hard-splits oversized blocks by exact source offsets, and applies ~32-token overlap between consecutive chunks in a section. Code fences and tables are kept as searchable text and never executed.
- Excerpts are exact `raw.slice(start_offset, end_offset)`; `line_from`/`line_to` are one-based. `heading` is carried out-of-band and is never injected into excerpt text.
- Resolved wikilinks and typed relationships are indexed through the Task 7 `extractLinks`/`extractRelationships`/`resolveLink` code. Graph expansion traverses at most one hop from at most five seeds, skips seeds (cycle dedupe), caps neighbours at ten, and honours the original project/type/status filters.
- Neighbour chunks prefer lexical relevance (FTS over the query within that document) and otherwise fall back to the first chunk (summary/first nonempty section). Graph neighbours keep the reason `graph:<relationship>` and carry a real `SearchChunk` with no fabricated lexical score.

## Test coverage

`tests/unit/search-query.test.ts` (5): the brief's exact `literalMatch` expectations, empty/punctuation-only `null`, dedupe/64-term bound, punctuation-only `INVALID_INPUT`, and the brief's same-transaction update test.

`tests/unit/chunker.test.ts` (7): exact slices + one-based lines, CRLF byte preservation, tables and long code fences, oversized paragraph split within target with overlap, code-fence splitting, heading context not injected, and per-slice `reference_tokens`.

`tests/integration/local-search.test.ts` (13): filters before limit, SQL-injection-style unknown type rejection, title/alias-only retrieval, synonym-only absence, resolved-link graph retrieval with `graph:link`, cycle dedupe + ten-neighbour cap, five-seed cap + graph filters, lexical-relevance neighbour selection, typed `graph:related` relationships, deletion + managed rename by stable id, malformed note alongside valid notes, corrupt-index rebuild on a disposable file, and reconcile-driven indexing (including malformed reporting and change replacement).

## Verification evidence

- `npx … npm run typecheck` — clean.
- `npx … npm run verify` — typecheck + 556 unit/contract tests + build, exit 0; `dist/storage/search-schema.sql` present.
- `npx … npm run test:integration` — 22 files / 475 tests passed on the committed tree.

## Concerns / notes

- `expandGraph` signature interpretation: the brief lists `expandGraph(seedKeys, filters, limit)` without a receiver, while the function needs the index/database. It is exposed verbatim as `index.expandGraph(seedKeys, filters, limit)`; `graph.ts` also exports the store-taking implementation and `createGraphExpander`. No behaviour is hidden.
- One pre-existing integration flake: `tests/integration/read.test.ts > pages a long note …` occasionally exceeds the default 5 s Vitest timeout (measured ~3.0 s in isolation) under full-suite load. It is unrelated to this task (no read/cursor/budget code changed) and passed on the final two full integration runs. Left untouched to stay within the file list.
- FTS table is created `IF NOT EXISTS` (the brief's minimal snippet has no guard) so reopening an existing disposable index is idempotent. Column list and tokenizer match the brief exactly.
- Neighbour selection loads `document_links` and re-resolves targets at query time; this keeps graph edges correct regardless of indexing order and is bounded by the corpus size already targeted by the plan.

---

# Fix Round 1 (review findings)

Base for this round: `5fd7149`. Fix commit recorded below (new commit; `5fd7149` not rewritten).

## Findings fixed

### Critical — stale content survives restart

`indexReconciledDocuments` now reconciles the disposable index against the complete current catalogue, not just the reconcile deltas. `SearchIndex` gained `paths()` (all indexed document paths), `SearchIndexSink` gained an optional `paths?()`, and the input catalogue type now includes `all()`. After applying report-driven upserts/removals, any indexed path absent from `catalogue.all()` is removed. A note deleted while the service was stopped therefore disappears on the next startup reconcile.

Test: `tests/integration/local-search.test.ts > a note deleted while the index is closed is pruned on restart` (file-backed index, close/reopen, delete file, fresh catalogue; asserts the stale term is gone and `paths()` is empty).

### Important — graph edges did not correspond to returned neighbours

`expandGraph` no longer collects edges up front. The introducing edge is stored with each candidate neighbour, and only the edges for neighbours that survive filtering and the ten-neighbour cap are returned. `limit: 0` and rejected filters now yield zero edges.

Test: `tests/integration/local-search.test.ts > graph edges are returned only for selected neighbours` (limit 0 -> 0 edges; 12 links capped to 10 neighbours and 10 edges whose targets are selected; rejected status -> 0 edges).

### Important — overlap could push a chunk over the 256-token target

After computing a ~32-token overlap start, the chunker now rechecks the resulting slice; if it exceeds the target it reduces the overlap via `fitOverlapStart`, keeping the chunk at or below 256 tokens. `splitOversized` was also tightened so newline extension never passes the largest fitting offset.

Test: `tests/unit/chunker.test.ts > two near-target paragraphs keep every chunk within the token target after overlap` (two ~240-token paragraphs; asserts every chunk <= 256 and exact slices).

### Important — replacing a document whose key changes left orphan metadata/links

`removeDocumentRows` now resolves every displaced document key within the transaction (the incoming key plus any row matching the path) and deletes chunks, FTS rows, documents, properties, aliases, and link rows for all of them. Adding an id to an existing path no longer leaves the former path-keyed links behind.

Test: `tests/integration/local-search.test.ts > adding an id to an existing path cleans up its former path keyed links` (unmanaged note with a link becomes managed; expanding from the stale path returns nothing, expanding from the id returns the neighbour).

### Minor — metadata-only documents could not match title/alias

`chunkDocument` now emits a source-backed excerpt for documents whose body is empty/whitespace-only: a chunk spanning the exact raw source (split at the token target if needed), so FTS title/alias/text columns and the exact-title/alias channel all work for frontmatter-only notes.

Tests: `tests/unit/chunker.test.ts > frontmatter-only notes produce a source-backed excerpt` and `tests/integration/local-search.test.ts > a frontmatter-only note is retrievable by its alias and title`.

## Verification (fix round)

- `npx --yes --package=node@24 --package=npm@10 -c 'npm run typecheck'` — clean.
- `npx --yes --package=node@24 --package=npm@10 -c 'npm run verify'` — 35 files / 558 tests passed, build green.
- `npx --yes --package=node@24 --package=npm@10 -c 'npm run test:integration'` — 22 files / 479 tests passed.
- Targeted: `node_modules/.bin/vitest run tests/unit/search-query.test.ts tests/unit/chunker.test.ts tests/integration/local-search.test.ts` — 31 tests passed.

## Not fixed

None. All Critical, Important, and Minor findings in this round were addressed. Pre-existing unrelated flake noted in the original report (`read.test.ts` timing under full-suite load) remains out of scope and passed on this run.

---

# Fix Round 2 (review finding)

Base for this round: `acde5b6`. Fix commit recorded below (new commit; `acde5b6` not rewritten).

## Finding fixed

### Important — pruning could delete valid indexed notes when the catalogue is incomplete

Pruning no longer treats every path missing from `catalogue.all()` as deleted. `indexReconciledDocuments` now:

- computes the live set from `catalogue.all()` plus every path reported as `malformed` and every path in `duplicate_ids`, so a file that exists but failed to read/parse (or is in an id conflict) is never pruned;
- accepts an optional `partial?: boolean`; when partial, it skips all destructive work (move-source removal, reported removals, and pruning) and only applies safe upserts;
- keeps the proven-deletion behavior: a full scan still prunes indexed paths that are absent from the live set.

`runtime.ts` supplies the partial signal via a private `indexCoversVault(scanned)`: a scan with `scanned > 0` is treated as covering the vault; a zero-file scan is only trusted when the vault root is a readable directory, so a transiently missing/unlistable root skips pruning instead of deleting every entry. A genuinely empty but readable vault still prunes, preserving the verified deletion behavior.

Tests:
- `tests/integration/local-search.test.ts > a malformed note on restart keeps its index entry while a deleted note is pruned` (file-backed index; on restart one file is malformed and one deleted; the malformed file's previous excerpt is retained, the deleted note is pruned).
- `tests/integration/local-search.test.ts > an incomplete scan never prunes indexed entries` (`partial: true` retains the stale entry; a complete scan with the same report prunes it).
- Existing `a note deleted while the index is closed is pruned on restart` remains and still passes (not weakened).

## Verification (fix round 2)

- `npx --yes --package=node@24 --package=npm@10 -c 'npm run typecheck'` — clean.
- `npx --yes --package=node@24 --package=npm@10 -c 'npm run verify'` — 35 files / 558 tests passed, build green.
- `npx --yes --package=node@24 --package=npm@10 -c 'npm run test:integration'` — 22 files / 481 tests passed.
- Targeted: `node_modules/.bin/vitest run tests/unit/search-query.test.ts tests/unit/chunker.test.ts tests/integration/local-search.test.ts` — 33 tests passed.

## Not fixed

None. The new Important finding and all prior findings remain addressed. All five original findings are unchanged and still verified.

---

# Fix Round 3 (review findings — root cause)

Base for this round: `82d0856`. Fix commit recorded below (new commit; `82d0856` not rewritten).

## Defect 1 — ordering and classification

Root cause fixed in the catalogue, not patched at the index boundary.

- `reconcileCurrentVault` now tracks the set of paths actually listed by the scan (`listedPaths`). A previous catalogue entry is reported as `removed` only when its path was **not** listed at all. A file that is present but whose read or parse failed is listed, so it is classified as malformed, is **not** reported as `removed`, and its catalogue entry/index entry are retained for the next scan.
- Removals are skipped entirely when the scan is incomplete (`report.complete === false`), so a partial scan never drops catalogue entries either.
- `indexReconciledDocuments` computes its protected set (the report's `malformed` paths plus `duplicate_ids` paths) **before** applying any removal; protected paths are excluded from move-source removal and from `report.removed` handling, and are added to the prune live set. When the scan is incomplete it performs no destructive work at all (no removals, no pruning), only safe upserts.

Tests:
- `tests/integration/local-search.test.ts > a present file that becomes unparseable on a later scan keeps its index entry` — uses the **same** catalogue for a second scan (not a fresh one), asserts the file is `malformed`, is **not** in `removed`, and its index entry is retained.
- `a malformed note on restart keeps its index entry while a deleted note is pruned` and `a note deleted while the index is closed is pruned on restart` remain and pass.

## Defect 2 — unsound completeness signal

- `src/storage/vault.ts` now exposes `scanVaultFilePaths(root)` returning `{ paths, complete }`. The walker marks `complete = false` whenever a directory listing fails with `ENOENT` (the directory/root is gone) or an entry's `lstat` fails; these were previously skipped silently. `listVaultFilePaths` is preserved as a thin wrapper returning `.paths`, so existing callers are unchanged. `FileVault` gained `scanMarkdown()` returning the filtered `.md` inventory with its completeness flag, and `listMarkdown()` delegates to it.
- `current-catalogue.ts` gained `CurrentVaultScan` and an optional `scanMarkdown()` on `CurrentVault`, and `ReconcileCurrentVaultReport` now carries `complete`. `reconcileCurrentVault` uses `scanMarkdown` when available (falling back to `listMarkdown` with `complete: true` for minimal test vaults).
- `runtime.ts` deleted the heuristic `indexCoversVault` entirely and passes the report through; destructive work is gated on `report.complete`. The reconcile log now records `complete`/`partial`.

Tests:
- `tests/integration/local-search.test.ts > an incomplete vault walk is treated as partial and never prunes the index` — a scan reporting `complete: false` yields `report.complete === false`, no removals, and retains the indexed note.
- `a vault walk that cannot list a directory reports incompleteness` — `scanVaultFilePaths` on a missing directory returns `complete: false`, while a readable root returns `complete: true`.
- `an incomplete scan never prunes indexed entries` — `complete: false` retains a stale entry; `complete: true` with the same report prunes it.

## Verification (fix round 3)

- `npx --yes --package=node@24 --package=npm@10 -c 'npm run typecheck'` — clean.
- `npx --yes --package=node@24 --package=npm@10 -c 'npm run verify'` — 35 files / 558 tests passed, build green.
- `npx --yes --package=node@24 --package=npm@10 -c 'npm run test:integration'` — 22 files / 484 tests passed.
- Targeted: `node_modules/.bin/vitest run tests/unit/search-query.test.ts tests/unit/chunker.test.ts tests/integration/local-search.test.ts` — 36 tests passed.

## Not fixed

None. Both reported defects are fixed at the root cause; all prior findings remain verified and no existing assertions were weakened. Note: this round necessarily modified `src/notes/current-catalogue.ts` and `src/storage/vault.ts` (the files the review cited as the root cause), in addition to `src/notes/reconcile.ts` and `src/runtime.ts`.

---

# Fix Round 4 (protected index identities and walker-failure coverage)

Base: `cdc6bfb`; committed separately without rewriting the earlier fixes.

## Root cause and fix

- Catalogue move detection previously matched a prior ID to a newly readable destination without checking whether its original path was still listed but unreadable, or whether a partial walk could have missed it. Reconciliation now treats these as reported ID conflicts, retains the source, and does not plan a move. A partial scan also defers an ID change on the same path, reports an identity conflict, and retries on a complete scan.
- The index upsert deletes by ID as well as path, so protecting only explicit removals was insufficient. The disposable index now supplies its current path/ID identities to reconciliation. Before any removals or upserts, reconciliation detects collisions with protected paths and incomplete-scan identities, reports conflicts, and skips both the move-source removal and identity-changing destination upsert. This also protects an indexed source after a runtime restart with an empty current catalogue. Runtime logs reconciliation after index conflict detection so logged conflict counts include index-only collisions.
- Added deterministic filesystem-race tests: a directory disappears after `lstat` and before recursive `readdir` (ENOENT), and an entry disappears after listing before its `lstat`. Each exercises `FileVault.scanMarkdown` through `reconcileCurrentVault` into index synchronization, asserts `complete: false`, and verifies the indexed note is not pruned. Existing complete-scan deletion tests remain unchanged and passing.

## Regression tests

- `an unreadable managed source cannot be displaced by a readable note with its id` — originally failed with no conflict reported; checks source catalogue/index and previous excerpt remain intact.
- `a partial scan does not plan a move or upsert its destination` — originally failed because it planned a move; checks conflict and preservation on partial scan followed by successful move on a complete scan.
- `a fresh catalogue cannot upsert a colliding id over a malformed indexed source` — originally failed with an unreported collision; checks protection across restart-like catalogue recreation.
- `a partial scan does not replace an indexed path when its managed id changes` — checks an identity-changing update is deferred until a complete scan.
- `directory disappears after lstat ...` and `entry disappears after readdir ...` — both assert incomplete walker inventory reaches reconciliation and prevents pruning.

## Verification

- `npx --yes --package=node@24 --package=npm@10 -c 'npm run typecheck && node_modules/.bin/vitest run tests/integration/local-search.test.ts'` — exit 0; 28 local-search tests passed.
- `npx --yes --package=node@24 --package=npm@10 -c 'npm run verify'` — exit 0; typecheck, 558 unit/contract tests (35 files), and build passed.
- `npx --yes --package=node@24 --package=npm@10 -c 'npm run test:integration'` — exit 0; 490 tests (22 files) passed.
- `git diff --check` — exit 0.
- Additional `npx --yes --package=node@24 --package=npm@10 -c 'npm test'` was attempted; the unrestricted all-files command exceeded its 360-second limit without completing or reporting a test failure. The required targeted, verify, and integration gates above passed; no result is claimed for the unrestricted command.

## Not fixed

No known Task 11 defect remains. The unrestricted `npm test` run is unverified because it exceeded the 360-second execution limit; its constituent required unit/contract and integration suites passed separately.

---

# Fix Round 5 (deferred search-index recovery)

Base: `8cbb610`. New fix commit recorded separately; previous commits were not rewritten.

## Finding fixed

### Important — deferred same-ID upsert could be lost after conflict resolution

The catalogue records a readable contender even when the disposable index must defer its upsert to protect an indexed, malformed same-ID original. On a later scan with the original deleted, the unchanged contender produces no catalogue delta, so delta-only index synchronization pruned the original without indexing the contender. Complete-scan synchronization now compares every catalogue document against indexed path, ID, and etag and upserts missing or stale documents, while retaining protected-path collision checks before each upsert. Incomplete scans retain the existing delta-only safe-upsert behavior; complete scans still prune absent, unprotected paths. The index exposes the stored etag alongside each indexed identity for this comparison.

## Regression tests

- `a deferred contender is indexed after its malformed same-id source is deleted`: fresh catalogue, protected malformed Original plus same-ID Contender, then delete Original; asserts no new catalogue delta, Contender searchable and Original absent after the next complete scan.
- `a complete scan refreshes stale indexed content even without a catalogue delta`: replaces an index entry with stale content at the same path; complete scan restores current Markdown text and removes the stale term.
- Both tests failed for the expected missing search result before the production fix, then passed after it. Existing protected-conflict, partial-scan, and true-deletion assertions were left intact.

## Verification

- `npx --yes --package=node@24 --package=npm@10 -c 'npm run typecheck && node_modules/.bin/vitest run tests/integration/local-search.test.ts'` — exit 0, 30 local-search tests passed.
- `npx --yes --package=node@24 --package=npm@10 -c 'npm run verify'` — exit 0, 558 unit/contract tests (35 files), typecheck and build passed.
- `npx --yes --package=node@24 --package=npm@10 -c 'npm run test:integration'` — exit 0, 492 integration tests (22 files) passed, including both new regressions.
- `git diff --check` — exit 0.

## Not fixed

None in this finding.
