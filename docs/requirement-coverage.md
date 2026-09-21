# Requirement coverage record

This record maps the design requirements (`R01`-`R18` in
`docs/superpowers/specs/2026-09-20-second-brain-design.md`) to their
implementation and verification evidence. It supersedes the task-number-only
matrix in the plan's section E by naming the concrete checks. Every entry below
was exercised by the automated suites unless marked otherwise.

| Requirement | Implementation | Verification |
|---|---|---|
| **R01** One repository; two Compose services; only the gateway's MCP endpoint is published. | `compose.yaml` (services `brain`, `memory`); `config/brain.yaml`. | `tests/e2e/docker.test.ts`, `tests/e2e/security.test.ts` (loopback publishing, no backend port). |
| **R02** No plugin, REST application API, chat-model dependency, or automatic transcript ingestion. | `src/mcp/http.ts` serves only `/mcp`; no plugin/REST/curator modules. | `tests/integration/http-security.test.ts` (404 for other paths); `tests/e2e/security.test.ts` (`/mcp`-only, six tools). |
| **R03** Node.js 24 LTS + TypeScript; MCP TypeScript SDK, Zod 4, SQLite, Basic Memory adapter. | `package.json`, `Dockerfile`, `config/dependency-lock.json`. | `tests/contract/capabilities.test.ts`; `npm run verify`. |
| **R04** MCP Streamable HTTP at `/mcp`, authenticated every request, loopback by default. | `src/mcp/http.ts`, `src/security/authenticate.ts`; Compose port mapping. | `tests/integration/http-security.test.ts`; `tests/e2e/security.test.ts`. |
| **R05** Publish memory-use guidance at initialization; verify real client delivery, do not assume. | `src/mcp/instructions.ts`; `buildInstructions()`. | `tests/unit/instructions.test.ts`; `tests/eval/instruction.mts` (model-dependent, recorded in `docs/evaluation.md`). |
| **R06** Seven note kinds. | `src/contracts/content.ts`, `src/notes/registry.ts`. | `tests/unit/contracts.test.ts`, `tests/unit/codec.test.ts`; end-to-end capture/read in `tests/e2e/lifecycle.test.ts`. |
| **R07** Markdown authoritative; catalogue/search rebuildable; journal and feedback separate. | `src/notes/catalogue.ts`, `src/storage/journal.ts`, `src/storage/vault.ts`; `scripts/backup.sh`, `scripts/rebuild.sh`. | `tests/unit/journal.test.ts`, `tests/unit/catalogue.test.ts`, `tests/e2e/operations.test.ts`, `tests/e2e/recovery.test.ts`. |
| **R08** Authenticate before scope resolution; only explicit scopes usable. | `src/security/authorise.ts`, `src/security/authenticate.ts`. | `tests/unit/security.test.ts`; `tests/e2e/security.test.ts` (cross-scope token, forbidden marker). |
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
| OpenCode discovers and calls all six tools without a custom plugin. | Pass (config shape) / pilot NOT RUN | `tests/eval/instruction.mts`; `docs/evaluation.md`. |
| Initialization guidance present on the wire; client use recorded separately. | Pass on the wire; client delivery recorded | `tests/unit/instructions.test.ts`; `docs/evaluation.md`. |
| Every note kind captures, renders, reads, validates without universal lesson requirements. | Pass | `tests/unit/contracts.test.ts`, `tests/unit/codec.test.ts`. |
| A captured lesson is a candidate; authorized review makes it recallable. | Pass | `tests/integration/review.test.ts`; `tests/e2e/lifecycle.test.ts`. |
| A timed-out mutation does not duplicate or lose the write. | Pass | `tests/e2e/recovery.test.ts`, `tests/e2e/security.test.ts`. |
| Concurrent agent writes reject stale etags; racing Obsidian edit remains recoverable. | Pass | `tests/integration/manual-edits.test.ts`; `tests/e2e/lifecycle.test.ts`. |
| Default retrieval excludes obsolete, expired, conflicted, unauthorized memories. | Pass | `tests/integration/recall.test.ts`; `tests/e2e/lifecycle.test.ts`. |
| Query failures, no matches, partial retrieval, embedding degradation distinguishable. | Pass | `tests/integration/recall.test.ts`, `tests/unit/budget.test.ts`. |
| Reference-token and byte limits include overhead and are tested on Unicode. | Pass | `tests/unit/budget.test.ts`; `tests/e2e/lifecycle.test.ts`. |
| Credentials/private notes do not appear in logs or the repository. | Pass | `tests/unit/redaction.test.ts`; `.gitignore` excludes `secrets/`. |
| Restart, cold restore, index rebuild preserve head/lifecycle behavior. | Pass | `tests/e2e/recovery.test.ts`, `tests/e2e/operations.test.ts`. |
| Model assets survive restart; offline warm-up behavior demonstrated. | Pass | `tests/e2e/docker.test.ts`. |
| Paired pilot reports actual results and makes no unseen-client enforcement claim. | NOT RUN (no approved budget) | `docs/evaluation.md`. |
| No plugin, REST API, background curator LLM, or transcript ingestion added. | Pass | Repository layout; `tests/e2e/security.test.ts`. |
