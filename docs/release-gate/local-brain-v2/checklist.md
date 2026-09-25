# Local Brain V2 release gate checklist

- **Release-verification commit:** `c05d252fc2be81c381035d9e4c035c27d39e9f18`
  (`test: verify local Brain V2 migration and lifecycle`), on top of the
  verified task 1-18 series at `a883dcf98ba53ec38e5611f1c5febe8952be7383`.
- **Recorded:** 2026-09-25.
- **Host:** Linux (WSL2 kernel) 6.8.0, x86_64, 11th Gen Intel Core i5-1135G7,
  8 vCPU, 15 GiB RAM, Ubuntu, CPU-only (no GPU).
- **Toolchain:** Node `v24.21.0`, npm `11.19.0`, Python `3.12.3`,
  Docker `29.3.0`.
- **Pinned images:** `config/images.env`
  (`NODE_IMAGE=node@sha256:0e0ff40c...`, `PYTHON_IMAGE=python@sha256:2f17fc04...`).
- **Real-state prerequisites that are absent on this host:**
  `/var/lib/second-brain` does not exist, so the real evaluation dataset,
  prepared Laya model artifacts, and a live journal are unavailable. Anything
  that depends on them is recorded **NOT RUN**, never PASS.

## Release commands and actual outcomes

| Command | Prerequisite | Outcome | Evidence |
|---|---|---|---|
| `npm ci` | network/npm cache | PASS | 185 packages; `better-sqlite3` and `esbuild` prebuilt bindings loaded under Node 24 (`node -e` SQLite probe OK). |
| `npm run verify` | Node 24 | PASS | typecheck clean; 712 unit/contract tests in 45 files passed; `tsc -p tsconfig.build.json` build passed. |
| `npm run test:integration` | Node 24 | PASS | 667 tests in 38 files passed (4m06s). `tests/integration/laya-local.test.ts` excluded by the script. |
| `python3 -m unittest discover -s workers/laya/tests -p 'test_*.py'` | Python 3.12 | PASS | 54 tests run, 6 skipped, `OK`. |
| `npm run test:laya` | prepared Laya artifacts under `/var/lib/second-brain/models` | **NOT RUN (fails closed)** | 11 tests failed in the setup gate: `requiredArtifacts` cannot find the configured model directory, so the worker never reports `ready`. This is the accepted task 12/16/18 limitation, not a green run. |
| `npm run test:e2e` (`BRAIN_E2E_LIVE=1`) | Docker + pinned images | PASS | 4 files, 28 passed, 1 skipped (`offline-local-brain` artifact check). `single-container` built and served the single container with reranking disabled; `local-brain-v2-lifecycle` passed; `recovery` passed. |
| `tests/e2e/local-brain-v2-lifecycle.test.ts` (included in `test:e2e`) | Docker + Node 24 | PASS | Full disposable lifecycle (below). |
| `npm run eval:retrieval -- --backend local --mode text --dataset /var/lib/second-brain/evaluations/retrieval.jsonl` | real dataset | **NOT RUN** | exit 1, `ENOENT ... /var/lib/second-brain/evaluations/retrieval.jsonl`. |
| `npm run eval:retrieval -- --backend local --mode reranked --dataset /var/lib/second-brain/evaluations/retrieval.jsonl` | real dataset + model artifacts | **NOT RUN** | exit 1, same `ENOENT`. |
| `npm run eval:retrieval -- --backend local --mode text --dataset tests/eval/fixtures/local-retrieval/dataset.jsonl` | committed fixture | PASS (with open quality item) | exit 0; candidate recall@50 0.9252, graph recall@10 0.0748, nDCG@10 0.9252, MRR 0.9159, unjudged 0, **12 no-answer queries; 12/12 returned a candidate — the strict empty-result gate was not met on this fixture**, p50 10 ms; `docs/release-gate/local-brain-v2/retrieval-text-fixture.json`. |
| `npm run eval:retrieval -- --backend local --mode reranked --dataset tests/eval/fixtures/local-retrieval/dataset.jsonl` | committed fixture | PASS (mode label only, **not** a model run) | exit 0; identical offline metrics. No Laya worker was loaded; this is a mode label, never a reranking claim. Raw output in `retrieval-reranked-fixture.json`. |
| `npm run eval:retrieval -- --backend local --compare true --dataset tests/eval/fixtures/local-retrieval/dataset.jsonl` | committed fixture | PASS | exit 0; `local_text` recall@50 0.9252 / nDCG@10 0.9252; `local_text_graph` recall@50 1.0 / nDCG@10 0.9724 / graph recall@10 0.0748; `laya_reranked` reported **NOT RUN** with the lexical fallback order reported separately. `retrieval-compare-fixture.json`. |

Fixture hashes: `dataset.jsonl`
`125446ec549360e7ed7fbfc8019bd6fa1e7301955317f2a924a74f507158c822`,
`source-hashes.json`
`8b0cb23b368555cb9ec3489e1cd4b6e3ab777659459d2d3fcfdb34281cad70c2`.

### Lifecycle test coverage

`tests/e2e/local-brain-v2-lifecycle.test.ts` is a single disposable scenario
that restores the frozen V1 fixture
(`tests/fixtures/vault-v2/manifest-cases.json`), then, using the in-process
`runCli` module (not a spawned `dist/cli` process) and a real in-process MCP
runtime:

1. writes a Brain config and materializes the frozen V1 vault;
2. runs `vault-v2 inspect` and `vault-v2 plan`, and asserts the deliberate fork
   blocker is reported for `0b8f1c2d-...`;
3. copies the exact source fingerprint media and writes the hash receipt, then
   runs `vault-v2 apply --maintenance --partial` and `vault-v2 verify`;
4. asserts readable current paths with no UUID filename segments, preserved
   legacy blocked notes, preserved human note/attachment/`.obsidian`, preserved
   `id`/`status`, and durable history copies;
5. initializes the fresh V2 journal explicitly with
   `rebuild-catalogue --accept-operational-loss` (the documented explicit path
   for a new deployment with no V1 operational state);
6. starts the V2 runtime with **one token** and confirms the seven-tool list;
7. executes all seven tools and, separately, approves + recalls + reads +
   records feedback for captured notes;
8. manually edits one current note and renames another on disk;
9. rotates the token and asserts the old session is rejected and the valid
   token can call every tool again;
10. confirms Laya is stopped (`health.worker = disabled`) and recall stays in
    `text` mode;
11. closes the runtime, rebuilds the index with `rebuild-index`, and restarts;
12. asserts the vault hashes are byte-for-byte unchanged, the manual edit and
    rename are preserved by logical ID, and an idempotent capture replay returns
    the original `id`, `revision_id`, and `operation_id`.

The lifecycle test uncovered one real integration gap: after a documented partial
migration, preserved **non-V2-schema** notes (any `brain_schema_version` other
than 2, not only schema 1) made `LocalMutationCoordinator.resolveConflictHeads`
throw `UNSUPPORTED_SCHEMA` while scanning conflict heads, blocking every mutation
with a precondition. The minimal fix (committed with the test) skips documents
whose schema version is not the supported V2 version during that scan, while a
malformed schema-2 document still fails closed; it does not weaken any existing
assertion and no owner/role credential is used to bypass the model. The focused
regression test is
`tests/integration/conflict-head-schema-skip.test.ts` (seeds schema-1 and
schema-3 preserved notes plus a malformed schema-2 document).

## AC01-AC16 requirement-coverage matrix

| ID | Owning tasks | Release evidence | Status |
|---|---|---|---|
| AC01 | 2, 3, 14, 19 | `local-brain-v2-lifecycle` tool matrix before/after rotation; `token-rotation`, `single-brain-access` | PASS |
| AC02 | 3, 14, 18 | `single-brain-access`, `single-token` (role-free context assertions), `legacy-credentials`, `single-container`; also confirmed by code/config/schema review | PASS |
| AC03 | 5, 10, 15 | `vault-v2-migration`, `human-paths`, `local-brain-v2-lifecycle` | PASS |
| AC04 | 6, 10, 17 | `vault-v2-migration` (exact history hashes), `local-recovery`, lifecycle history dir | PASS |
| AC05 | 4, 6, 9, 14 | `manual-edits`, `manual-vault-edits`, lifecycle manual edit/rename | PASS |
| AC06 | 7, 8, 10, 15 | Machine: `link-resolution`, `obsidian-links`, `vault-v2-migration`, lifecycle attachment link. Manual Obsidian validation: not run. | PARTIAL (machine PASS; manual Obsidian NOT RUN) |
| AC07 | 4, 15 | `obsidian-assets`, `obsidian-install`, lifecycle properties | NOT RUN for the manual Obsidian GUI/version check |
| AC08 | 9, 11, 14, 17 | `local-search`, `local-rebuild`, lifecycle `rebuild-index` | PASS |
| AC09 | 12, 18 | gated `laya-local`, `laya-worker` contract, worker unit tests | NOT RUN (no model artifacts) |
| AC10 | 12, 13, 14 | `reranker-fallback`, lifecycle worker disabled/text mode | PASS |
| AC11 | 1, 11, 16, 19 | committed-fixture candidate recall + cross-mode harness | PASS (text candidate recall); NOT RUN (reranking latency/RSS) |
| AC12 | 3, 13, 16 | `classifier-policy`, `feedback-export`, `feedback` | PASS |
| AC13 | 16 | Machine: `feedback-export`, `feedback`, `local-operation-coordination`. Live export CLI: not run. | PARTIAL (machine PASS; live export NOT RUN: no journal/dataset) |
| AC14 | 1, 10, 17, 19 | `vault-v2-migration` fault injection/rollback, lifecycle inspect→plan→verified apply→verify | PASS |
| AC15 | 14, 18, 19 | `single-container`, `offline-local-brain`, lifecycle | PASS |
| AC16 | 14, 18, 19 | `single-container` resolved Compose/env/mounts, `mcp`, `local-capabilities` | PASS |

Backend replacement is releasable only when AC01-AC08 and AC10-AC16 pass the
applicable release checks. This release is **not yet authorized for full
sign-off**: AC07, AC09, and the reranking-specific part of AC11 remain NOT RUN,
and the no-answer false-positive result above is an open quality item. If a
deployment is authorized without reranking, it must use `search_mode: text` and
Laya disabled, and must not be described as an enabled Laya improvement.

## Deployment runbook (exact ordering)

This is the operational cutover sequence. The detailed command contract is in
`docs/operations/vault-v2-migration.md`; store backup/restore/rebuild commands
are in `docs/operations.md`.

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

If validation fails before writers resume, stop V2 and use the verified
migration rollback or a full cold restore with the matching old image/config. If
new writes have occurred, stop writers, take another backup, and reconcile
divergence before rollback. Never restore the old journal or files on top of new
work.

## Open release blockers and conservative decisions

1. **Laya reranking: NOT RUN (blocker).** AC09 and the reranking-specific part
   of AC11 require prepared model artifacts; `/var/lib/second-brain` is absent.
   Ship with `BRAIN_SEARCH_MODE=text` and `BRAIN_LAYA_ENABLED=false`. Do not
   describe this deployment as an enabled Laya improvement.
2. **Obsidian manual GUI check: NOT RUN (blocker).** Carried forward from task
   15; the host has no display. Asset/link/property behavior is machine-tested.
3. **Real evaluation dataset: NOT RUN (blocker).** Both release evaluation
   commands fail closed on the missing
   `/var/lib/second-brain/evaluations/retrieval.jsonl`. The synthetic fixture and
   cross-mode harness are reported as the substitute; they are not a real
   reranked/quality claim.
4. **Conservative decision:** the frozen fixture carries no V1 operational
   state, so the lifecycle test initializes the new V2 journal with the
   documented explicit `rebuild-catalogue --accept-operational-loss` path and
   labels the result lossy, rather than silently creating a journal.
5. **Conservative decision:** the partial-migration conflict-head scan now skips
   `UNSUPPORTED_SCHEMA` documents only. A malformed schema-2 current document
   still fails closed.
6. **Independent review:** the whole-branch specification review and the
   code-quality/security/recovery review are performed by the execution
   controller after this task and are not self-asserted here.
