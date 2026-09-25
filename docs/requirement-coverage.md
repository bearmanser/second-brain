# Requirement coverage record

This record maps the design requirements (`R01`-`R18` in
`docs/superpowers/specs/2026-09-20-second-brain-design.md`) to their
implementation and verification evidence. It supersedes the task-number-only
matrix in the plan's section E by naming the concrete checks. Every entry below
was exercised by the automated suites unless marked otherwise.

## Local V2 acceptance coverage (AC01-AC16)

The authoritative acceptance matrix for the local V2 plan is AC01-AC16 in
`.superpowers/sdd/2026-09-23-second-brain-local-retrieval-human-vault/plan.md`
section 9. The table below records the owning tasks, the release evidence, and
the observed outcome for the release verification performed on 2026-09-25
(commit series ending at the release-verification commit). Full command,
environment, and evidence detail is in
`docs/release-gate/local-brain-v2/checklist.md`; the raw retrieval outputs are in
`docs/release-gate/local-brain-v2/*.json`.

| ID | Required outcome | Owning tasks | Verification evidence | Status |
|---|---|---|---|---|
| AC01 | One valid token can call every tool and access every project/category | 2, 3, 14, 19 | `tests/e2e/local-brain-v2-lifecycle.test.ts` (seven-tool matrix before and after rotation), `tests/integration/token-rotation.test.ts`, `tests/integration/single-brain-access.test.ts` | PASS |
| AC02 | No live roles, ACLs, owner-only logic, or dynamic grants remain | 3, 14, 18 | `tests/integration/single-brain-access.test.ts`, `tests/unit/permissions.test.ts`, `tests/unit/legacy-credentials.test.ts`, `tests/e2e/single-container.test.ts` (compose/config review) | PASS |
| AC03 | No UUID folder/filename is generated for current notes | 5, 10, 15 | `tests/integration/vault-v2-migration.test.ts`, `tests/unit/human-paths.test.ts`, `tests/e2e/local-brain-v2-lifecycle.test.ts` | PASS |
| AC04 | Original logical IDs and historical revisions survive migration | 6, 10, 17 | `tests/integration/vault-v2-migration.test.ts`, `tests/integration/local-recovery.test.ts`, `tests/e2e/local-brain-v2-lifecycle.test.ts` (history directory and ID reads) | PASS |
| AC05 | Manual notes/edits remain usable and stale writes do not overwrite them silently | 4, 6, 9, 14 | `tests/integration/manual-edits.test.ts`, `tests/integration/manual-vault-edits.test.ts`, `tests/e2e/local-brain-v2-lifecycle.test.ts` (manual edit + rename survive rebuild/restart) | PASS |
| AC06 | Genuine links, anchors, embeds, aliases, and attachments survive moves | 7, 8, 10, 15 | `tests/unit/link-resolution.test.ts`, `tests/unit/obsidian-links.test.ts`, `tests/integration/vault-v2-migration.test.ts`, `tests/e2e/local-brain-v2-lifecycle.test.ts` (human note attachment link preserved) | PASS (Obsidian GUI re-check open under AC07) |
| AC07 | Properties, templates, project pages, Bases, and daily organization are usable | 4, 15 | `tests/unit/obsidian-assets.test.ts`, `tests/integration/obsidian-install.test.ts`, `tests/e2e/local-brain-v2-lifecycle.test.ts` (properties/status preserved) | NOT RUN for the manual Obsidian GUI/version check (no display on the host) |
| AC08 | Local FTS/property/link search is rebuildable and returns attributable excerpts | 9, 11, 14, 17 | `tests/integration/local-search.test.ts`, `tests/integration/local-rebuild.test.ts`, `tests/e2e/local-brain-v2-lifecycle.test.ts` (`rebuild-index` then unchanged content) | PASS |
| AC09 | Laya runs locally with locked artifacts and real token limits | 12, 18 | `tests/integration/laya-local.test.ts` (gated), `tests/contract/laya-worker.test.ts`, `python3 -m unittest discover -s workers/laya/tests` | NOT RUN (no prepared model artifacts under `/var/lib/second-brain`) |
| AC10 | Laya failure cannot block safe read/write or silently change search mode | 12, 13, 14 | `tests/integration/reranker-fallback.test.ts`, `tests/e2e/local-brain-v2-lifecycle.test.ts` (worker disabled; recall stays `text`) | PASS |
| AC11 | Retrieval quality and resource targets are measured before cutover | 1, 11, 16, 19 | Committed fixture + cross-mode harness (`docs/release-gate/local-brain-v2/retrieval-*.json`); `tests/integration/local-search.test.ts` | PASS for the local candidate-recall gate on the synthetic fixture (candidate recall@50 0.9252, graph recall@10 0.0748, nDCG@10 0.9252, MRR 0.9159). NOT RUN for the reranking-specific latency/RSS gate. |
| AC12 | Classifier outputs cannot grant access, auto-approve, or rewrite factual metadata | 3, 13, 16 | `tests/unit/classifier-policy.test.ts`, `tests/unit/feedback-export.test.ts`, `tests/integration/feedback.test.ts` | PASS |
| AC13 | Feedback can produce a private, explicitly labeled, leakage-controlled dataset | 16 | `tests/unit/feedback-export.test.ts`, `tests/integration/feedback.test.ts`, `tests/integration/local-operation-coordination.test.ts` | PASS for the export logic and leakage controls. The live `feedback export` CLI run is NOT RUN on this host (no `/var/lib/second-brain/journal.db` or real dataset). |
| AC14 | Migration has read-only planning, verified backup, safe resume, and rollback | 1, 10, 17, 19 | `tests/integration/vault-v2-migration.test.ts` (fault injection at every phase, rollback, verified backup), `tests/e2e/local-brain-v2-lifecycle.test.ts` (inspect → plan → verified apply → verify) | PASS |
| AC15 | Production has one application container and no live Basic Memory requirement | 14, 18, 19 | `tests/e2e/single-container.test.ts`, `tests/e2e/offline-local-brain.test.ts`, `tests/e2e/local-brain-v2-lifecycle.test.ts` | PASS |
| AC16 | Existing image/env/mount/client conventions remain operable | 14, 18, 19 | `tests/e2e/single-container.test.ts` (resolved Compose, env file, vault/state mounts), `tests/integration/mcp.test.ts`, `tests/unit/local-capabilities.test.ts` | PASS |

Definition of done, per plan section 9: backend replacement is releasable only
when AC01-AC08 and AC10-AC16 pass the applicable release checks. AC09 and the
reranking-specific part of AC11 remain NOT RUN because the host has no prepared
Laya model artifacts; the deployment therefore ships with reranking **disabled**
(`search_mode: text`). AC07 also carries an explicit open manual Obsidian GUI
check. See the open blockers in the release-gate checklist.

---

## Historical coverage (September 2026 Basic Memory design, superseded)

The following `R01`-`R18` rows record the pre-V2 Basic Memory design. They are
retained for provenance only. Rows that referenced the retired two-service
suites (`tests/e2e/docker.test.ts`, `tests/e2e/security.test.ts`) are superseded
by the AC01-AC16 matrix above and by the single-container suites.


| Requirement | Implementation | Verification |
|---|---|---|
| **R01** One repository; two Compose services; only the gateway's MCP endpoint is published. | `compose.yaml` (services `brain`, `memory`); `config/brain.yaml`. | `tests/e2e/docker.test.ts`, `tests/e2e/security.test.ts` (loopback publishing, no backend port). |
| **R02** No plugin, REST application API, chat-model dependency, or automatic transcript ingestion. | `src/mcp/http.ts` serves only `/mcp`; no plugin/REST/curator modules. | `tests/integration/http-security.test.ts` (404 for other paths); `tests/e2e/security.test.ts` (`/mcp`-only, seven controlled tools). |
| **R03** Node.js 24 LTS + TypeScript; MCP TypeScript SDK, Zod 4, SQLite, Basic Memory adapter. | `package.json`, `Dockerfile`, `config/dependency-lock.json`. | `tests/contract/capabilities.test.ts`; `npm run verify`. |
| **R04** MCP Streamable HTTP at `/mcp`, authenticated every request, loopback by default. | `src/mcp/http.ts`, `src/security/authenticate.ts`; Compose port mapping. | `tests/integration/http-security.test.ts`; `tests/e2e/security.test.ts`. |
| **R05** Publish memory-use guidance at initialization; verify real client delivery, do not assume. | `src/mcp/instructions.ts`; `buildInstructions()`. | `tests/unit/instructions.test.ts`; `tests/eval/instruction.mts` (model-dependent, recorded in `docs/evaluation.md`). |
| **R06** Seven note kinds. | `src/contracts/content.ts`, `src/notes/registry.ts`. | `tests/unit/contracts.test.ts`, `tests/unit/codec.test.ts`; end-to-end capture/read in `tests/e2e/lifecycle.test.ts`. |
| **R07** Markdown authoritative; catalogue/search rebuildable; journal, mappings, grants, and feedback separate. | `src/notes/catalogue.ts`, `src/storage/journal.ts`, `src/storage/vault.ts`; `scripts/backup.sh`, `scripts/rebuild.sh`. | `tests/unit/journal.test.ts`, `tests/unit/catalogue.test.ts`, `tests/e2e/operations.test.ts`, `tests/e2e/recovery.test.ts`. |
| **R08** Authenticate before scope resolution; only static scopes and role-matched dynamic grants are usable. | `src/security/authorise.ts`, `src/security/authenticate.ts`, `src/projects/scope-registry.ts`. | `tests/unit/security.test.ts`; `tests/e2e/security.test.ts` (cross-scope token, automatic-project isolation, forbidden marker). |
| **R09** Captures are candidates; review is distinct from validation. | `src/features/capture.ts`, `src/features/review.ts`. | `tests/integration/capture.test.ts`, `tests/integration/review.test.ts`; `tests/e2e/lifecycle.test.ts`. |
| **R10** Non-destructive, idempotent, revision-aware agent writes. | `src/core/mutation.ts`, create-only backend adapter. | `tests/integration/mutation.test.ts`, `tests/e2e/recovery.test.ts`, `tests/e2e/security.test.ts` (lost acknowledgment). |
| **R11** Detect malformed content, changed fingerprints, duplicate identities, missing parents, forks; never overwrite. | `src/notes/catalogue.ts`, `src/notes/codec.ts`. | `tests/unit/catalogue.test.ts`; `tests/e2e/lifecycle.test.ts` (human edit, duplicate identity, future schema). |
| **R12** Bounded, source-linked context; separate empty/partial/stale/degraded. | `src/features/recall.ts`, `src/retrieval/budget.ts`, `src/retrieval/rank.ts`. | `tests/integration/recall.test.ts`, `tests/unit/budget.test.ts`, `tests/e2e/security.test.ts` (degraded/fallback); `npm run eval:retrieval` against the real Docker Brain. |
| **R13** Notes are not executable instructions; no automatic URL fetch. | `src/storage/basic-memory.ts` (five fixed operations), no `fetch` tool. | `tests/e2e/security.test.ts` (poison note, raw backend tool requests). |
| **R14** Reject obvious credentials; keep private data out of logs; document best-effort redaction. | `src/security/redact.ts`. | `tests/unit/redaction.test.ts`, `tests/unit/security.test.ts`; `docs/security.md`. |
| **R15** Persist across restart; reconcile uncertain writes; tested backup/restore/rebuild. | `src/operations/recovery.ts`, `src/operations/backup.ts`, scripts. | `tests/e2e/recovery.test.ts`, `tests/e2e/operations.test.ts`, `tests/e2e/lifecycle.test.ts`. |
| **R16** Unit, contract, integration, fault-injection, security, retrieval evaluation, plus an OpenCode pilot. | `tests/{unit,contract,integration,e2e,eval}`; `docs/evaluation.md`. | `npm run verify`, `npm run test:integration`, `npm run test:e2e`, `npm run eval:retrieval` (real Docker Brain); the model-dependent pilot is recorded as NOT RUN in `docs/evaluation.md`. |
| **R17** No source-code comments unless requested; no deferred integrations. | Source has no explanatory comments; no plugin/REST/curator added. | Final whole-branch review; `docs/compatibility.md`. |
| **R18** Pin dependencies and container digests after an executable probe; no floating `latest`. | `package-lock.json`, `config/dependency-lock.json`, `config/images.env`. | `tests/contract/capabilities.test.ts`; `scripts/setup.sh` rejects floating tags. |

## Final acceptance checklist

| Item | Status | Evidence |
|---|---|---|
| Clean checkout initializes with Bash + Docker, no host Node or Basic Memory install. | Pass | `scripts/setup.sh`; `tests/e2e/docker.test.ts`. |
| `docker compose up -d` starts the system with persistent storage. | Pass | `tests/e2e/docker.test.ts`; release gate in `docs/compatibility.md`. |
| Only the authenticated gateway MCP endpoint is published; backend private. | Pass | `tests/e2e/security.test.ts`. |
| OpenCode discovers all seven tools without a custom plugin. | Pass (config shape) / automatic-use pilot NOT RUN | `tests/eval/instruction.mts`; `docs/evaluation.md`. |
| A Git origin creates or reuses one collision-safe project with role-matched access. | Pass | `tests/integration/project-ensure.test.ts`; `tests/e2e/security.test.ts`; `tests/e2e/lifecycle.test.ts`. |
| Initialization guidance present on the wire; client use recorded separately. | Pass on the wire; client delivery recorded | `tests/unit/instructions.test.ts`; `docs/evaluation.md`. |
| Every note kind captures, renders, reads, validates without universal lesson requirements. | Pass | `tests/unit/contracts.test.ts`, `tests/unit/codec.test.ts`. |
| A captured lesson is a candidate; authorized review makes it recallable. | Pass | `tests/integration/review.test.ts`; `tests/e2e/lifecycle.test.ts`. |
| A timed-out mutation does not duplicate or lose the write. | Pass | `tests/e2e/recovery.test.ts`, `tests/e2e/security.test.ts`. |
| Concurrent agent writes reject stale etags; racing Obsidian edit remains recoverable. | Pass | `tests/integration/manual-edits.test.ts`; `tests/e2e/lifecycle.test.ts`. |
| Default retrieval excludes obsolete, expired, conflicted, unauthorized memories. | Pass | `tests/integration/recall.test.ts`; `tests/e2e/lifecycle.test.ts`. |
| Query failures, no matches, partial retrieval, embedding degradation distinguishable. | Pass | `tests/integration/recall.test.ts`, `tests/unit/budget.test.ts`. |
| Reference-token and byte limits include overhead and are tested on Unicode. | Pass | `tests/unit/budget.test.ts`; `tests/e2e/lifecycle.test.ts`. |
| Credentials/private notes do not appear in logs or the repository. | Pass | `tests/unit/redaction.test.ts`; `.gitignore` excludes `secrets/`. |
| Restart, cold restore, index rebuild preserve notes, repository mappings, and grants. | Pass | `tests/e2e/lifecycle.test.ts`, `tests/e2e/recovery.test.ts`, `tests/e2e/operations.test.ts`. |
| Model assets survive restart; offline warm-up behavior demonstrated. | Pass | `tests/e2e/docker.test.ts`. |
| Paired pilot reports actual results and makes no unseen-client enforcement claim. | NOT RUN (no approved budget) | `docs/evaluation.md`. |
| No plugin, REST API, background curator LLM, or transcript ingestion added. | Pass | Repository layout; `tests/e2e/security.test.ts`. |

The automatic-project release gate is recorded in
`docs/release-gate/2026-09-21/automatic-projects-verify.txt`,
`automatic-projects-e2e.txt`, and `automatic-projects-compatibility.txt`.
It executed 340 unit/contract, 294 integration, and 66 Docker end-to-end tests;
the real-backend retrieval gate passed at recall@5 0.9286 with zero leakage.
