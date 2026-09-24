# Evaluation record

This document records how the second-brain gateway was evaluated against a
disposable Brain and the OpenCode client. Every number below is observed output.
Nothing is projected from the design. Where a run could not be completed it is
marked **NOT RUN** with the exact blocker.

Observed on the execution host on 2026-09-21 (opencode `v2.0.10`).

## What the evaluator is

`tests/eval/run.mts` has three explicit modes:

| Mode | What it drives | Chat model |
|---|---|---|
| `--mode retrieval` (default) | a disposable Brain over real MCP/HTTP | no |
| `--mode instruction` | a disposable probe MCP server plus one OpenCode session | opt-in (`--allow-model`) |
| `--mode agent` | six synthetic tasks, two repeats, memory on/off | opt-in (`--allow-model`) |

Retrieval mode starts a disposable gateway with `startHttpHarness()` (a real
runtime, real vault files, real MCP transport, throwaway directories) and seeds
the corpus through the real `brain_capture` / `brain_review` tools. It never
contacts a chat model and never mounts a user vault.

Retrieval scoring uses recorded labels, not backend scores:

```ts
scoreRetrieval(actual, relevant) // recall_at_k and precision_at_k from the label set
```

The unit test for that function is `tests/unit/evaluation.test.ts`.

## Retrieval evaluation

### Corpus

`tests/eval/corpus.json` holds 11 synthetic FreeLLMAPI-style notes with unique
identities. It covers every required fixture shape:

| Category | Key | Lifecycle |
|---|---|---|
| Known streaming lesson | `streaming-lesson` | active |
| Routing decision | `routing-decision` | active |
| Superseded decision | `legacy-routing-superseded` | superseded |
| Current playbook | `cache-warm-playbook` | active |
| Candidate hypothesis | `batching-hypothesis` | candidate |
| Expired fact | `quota-expired-fact` | active, `valid_until` in 2020 |
| Unrelated project secret marker | `profile-secret` (scope `profile`) | active |
| Session handoff | `handoff-session` | active |
| Misleading note | `misleading-note` | active |
| Same-concept paraphrase | `ttft-paraphrase` | active |
| Shared-scope note | `shared-handoff-playbook` | active |

`tests/eval/retrieval.json` holds 14 positive and 9 negative/scoping queries.
Positive queries carry the expected note keys; negative queries expect an empty
result and also act as the scope-leak probes.

### Deterministic retrieval backend

The evaluator replaces the fixture backend's `search` with a deterministic
lexical ranker (`tests/eval/lexical-backend.mts`: lowercased token overlap with
a title boost). The existing test-double backend matches the whole query string
as one substring, which cannot represent natural multi-word queries, so a
tokenizing ranker is used instead. This is a synthetic measurement of the
gateway's scope, lifecycle, and packing pipeline over a labeled fixture; it is
**not** a measurement of Basic Memory semantic retrieval. The embedding-backed
backend remains the production path.

### Results

Run `retrieval-2026-09-21T02:42:12.396Z-28a14147` (23 queries, 11 notes):

| Metric | Value |
|---|---|
| Positive queries | 14 |
| Recall at five | 1.0 |
| Precision at five | 0.5262 |
| Negative/scoping queries | 9 |
| Negative queries with an empty result | 9 / 9 |
| Forbidden-marker leakage events | 0 |
| Mean recall elapsed time | 50.1 ms |
| Corpus seeding (capture + review) | 3498 ms, 22 tool calls |
| Functional gate | pass |

The recall target is at least 0.8 at five. The result clears it on this 14-query
set. Precision is 0.53 because a single lexical query returns every note that
shares a term, including the deliberately misleading note and the paraphrase
pair; this is reported as observed and is not hidden. Do not generalise these
numbers to semantic retrieval quality: the fixture ranker is lexical and the
corpus is small.

The functional gate is **zero scope leaks**. No response for any of the 23
queries contained either forbidden marker (`ZYPHERQUARTZ-9Z` from the `profile`
scope, `MORVEXPLUME-4K` from the `shared` scope), including the two queries that
used those marker strings verbatim against `freellmapi`. No secret, private
chat, token, or absolute host path is committed; the evaluator only stores
synthetic note keys, counts, timings, and token usage.

Raw sanitized aggregate: `tests/eval/results/retrieval.json`.

## Instruction delivery versus tool delivery

### Deterministic SDK check (green)

`tests/unit/evaluation.test.ts` connects an MCP SDK client to a disposable
gateway and asserts that the initialization response carries the shipped
guidance (it must contain `brain_recall`, `candidate`, and `untrusted data`).
This proves the *server* sends instructions. It does **not** prove that a client
or model receives or obeys them.

### Live instruction probe (RUN)

`tests/eval/run.mts --mode instruction --allow-model` starts a disposable probe
MCP server (stdio) whose `initialize` instructions carry a random marker and
whose `probe_fixture` tool returns a random fact. The runner runs an **MCP
visibility preflight** before launching the model: it parses the resolved
configuration from `opencode debug config` and merges the `mcp.servers` entries
in document order. The model is **not launched** unless the disposable server is
present and enabled in that effective configuration. `opencode run --standalone`
is used with `PWD` set to the disposable project; without `--standalone` the run
can attach to a shared background service and mask the disposable project's
configuration.

`RUN` requires all three of: (a) the preflight listed the disposable server,
(b) the model process exited 0 without timing out, and (c) the random
instruction marker was observed in the model's own stdout. `fact_seen` alone can
never produce `RUN`. If the preflight does not list the server, the model is not
launched and the status is `NOT RUN` with the preflight evidence.

Observed result for `deepseek/deepseek-v4-flash` on opencode `v2.0.10`:

| Run | Preflight server | Marker observed | Fact observed | Exit | Status |
|---|---|---|---|---|---|
| `structured` | `evalprobe…` listed | yes | **no** | 0 | RUN |
| `text-json` | `evalprobe…` listed | yes | **yes** | 0 | RUN |

- **Instruction delivery is observed**: in both runs the model reported the
  random instruction marker, which exists only in the MCP initialization
  response. This is behavioral evidence from the model's own output; no
  model-bound instruction trace was inspected, so it is not definitive
  inspection.
- **Structured content is not model-visible in this client**: with the default
  `structured` delivery the model received only the pointer and could not report
  the fact. The verified `result_delivery` mode for OpenCode is **`text-json`**.
- The gateway's `result_delivery` setting lives in the Brain configuration
  (`config/brain.example.yaml`), not in the client config. The shipped example
  still shows `structured`; deploy with `result_delivery: text-json` when OpenCode
  is the client. `config/opencode.example.jsonc` records this requirement.
- Raw sanitized runs, including per-run token usage and the preflight server
  list, are in `tests/eval/results/instruction-delivery.json` (stdout is stored
  only as a sha256 digest plus a character count).
- A missing response must not be read as proof that instructions are absent.
  Here both values were positively observed, so delivery is confirmed for this
  client and model combination.
- Evidence is read only from the model's own `text` output events, never from the
  raw tool-call payloads in the event stream. A tool result embedded in an event
  but not surfaced to the model would otherwise be a false green; a unit test
  covers that guard (`modelTextFromEvents`).
- `opencode mcp list` still reports `No MCP servers configured` for disposable
  projects even when `debug config` and the run itself show the server, so the
  effective-config preflight is authoritative and the `mcp list` text is kept as
  supplementary evidence only.

Transport note: the same probe exposed the model to a **remote** Streamable HTTP
MCP server first, and in this environment the installed client timed out before
sending any request to it, while a **local stdio** server connected reliably.
The stdio path is used for the recorded result. The remote path remains the
production transport and should be re-verified when the deployment client is
finalized.

### Manual fallback

If the client does not deliver server guidance, the operator can add equivalent
guidance to that client's own instruction file. OpenCode loads `AGENTS.md`
files; the V2 `instructions` configuration field is accepted but its entries are
not loaded (see the V2 instructions and config guides). This repository
documents that fallback and **does not install it**: no `AGENTS.md` file and no
plugin is created or modified by this project.

## Agent pilot

### Plan

Six synthetic tasks (`tests/eval/tasks.json`), two repeats each, with memory
enabled and disabled: 24 runs. Model, task input, repository revision, and
generation settings are matched; memory-enabled and memory-disabled runs
alternate by task parity; every run gets a fresh OpenCode session, a fresh
disposable Brain, and a fresh vault. The run cap is computed from
`min(tasks * repeats * 2, 24, --budget)` before any run starts. No paid provider
is used and no budget is raised.

### Disabled-condition isolation

A memory-disabled run must not inherit a second-brain MCP server from the user or
global configuration. Each run performs an effective-config preflight with
`opencode debug config`, merging every `mcp.servers` entry in document order:

- Disabled runs first write a project configuration with no MCP servers, then
  read the inherited server list and explicitly override **every inherited
  server by name** with `disabled: true`. Isolation is not name-filtered: an
  inherited Brain endpoint under any alias is caught because the rule disables
  all inherited servers.
- A second preflight must then prove that the effective configuration contains
  **zero enabled MCP servers of any name**. If any enabled server remains, the
  run is recorded as `invalid_isolation` and the model is **not launched**; it is
  never presented as a valid disabled comparison.
- Enabled runs must show the project `second-brain` server enabled in the
  preflight, otherwise they are also recorded as `invalid_isolation`.
- If any run in the pilot has `invalid_isolation`, the aggregate pilot status is
  `INVALID` and `failed: true`, never `RUN`.

The same preflight helper backs the instruction probe, so both model-driven
paths prove MCP visibility before launching a model. Unit tests cover the merge,
the zero-enabled rule (including an aliased Brain server), and the aggregate
gating (`effectiveMcpServers`, `disabledIsolationOk`, `pilotOutcome`).

### Result: NOT RUN

- The configured default provider (`freellmapi/auto`) rejects its API key:
  `opencode run --model freellmapi/auto "…"` exits with `Error: Invalid API key`,
  and `FREELLMAPI_API_KEY` is not exported in this environment.
- The only authenticated provider in this environment is a priced provider
  (recorded catalog cost). Switching the pilot to it without approval is
  forbidden by the task, so the 24-run pilot was not started.

Blocker: no approved, working, free chat provider. The pilot code path is
implemented and gated behind `--allow-model --model <provider/model>`; it records
per-run case, condition, model identifier, client version, tool timeline,
retrieved note IDs, isolation/preflight evidence, outcome, elapsed time, and
reported token usage (null when unavailable).

### Automatic repository provisioning pilot: NOT RUN

The gated agent pilot now creates real temporary Git repositories with two
distinct `origin` remotes, provisions the corresponding project for worker and
reviewer identities, seeds project notes into the returned dynamic scope, and
records whether the client called `brain_project_ensure` before recall. The
model-driven run was not executed because no external-model budget was
approved. No claim is made that the installed client followed initialization
instructions automatically; run with `--allow-model --model <provider/model>`
only after explicit approval.

## OpenCode configuration verification

`opencode --version` on the execution host: **opencode v2.0.10**.

- V2 places MCP servers under `mcp.servers.<name>`. A server name directly under
  `mcp` is not the documented V2 shape.
- `config/opencode.example.jsonc` uses `mcp.servers.second-brain` with
  `type: "remote"`, `url`, `oauth: false`, an `Authorization` header using
  `{env:SECOND_BRAIN_TOKEN}`, and `codemode: false`.
- `codemode: false` is a real V2 field: Code Mode is the default and groups MCP
  tools; setting it to `false` keeps a server's tools on the provider's native
  tool list. The V2 MCP guide documents `disabled` (not `enabled`) to keep a
  server configured without connecting it.
- The schema served from `https://opencode.ai/config.json` is the V1 schema even
  though V2 configuration files include the URL for editor validation. The
  installed V2 CLI's own resolved config (`opencode debug config`) accepted and
  preserved the `mcp.servers` block, so the example was verified against the
  installed CLI and the V2 documentation, not against that JSON file alone.
- Merge the block into the existing configuration instead of replacing it. The
  example contains only the `mcp` block; an existing `opencode.jsonc` may have
  other settings that must be preserved.
- Export `SECOND_BRAIN_TOKEN` in the environment of the **WSL OpenCode server
  process** (`opencode serve` / the background service), not only in a Windows
  desktop client, because `{env:SECOND_BRAIN_TOKEN}` is expanded by the server
  process that loads the configuration.

## Reproduce

```bash
# Release-gate retrieval: real disposable Docker Brain, no chat model. Needs Docker.
npx tsx tests/eval/run.mts --mode retrieval
# Offline fallback only (no Docker); not the release-gate metric.
npx tsx tests/eval/run.mts --mode retrieval --backend lexical-fixture
npx tsx tests/eval/run.mts --mode instruction --allow-model --model deepseek/deepseek-v4-flash
npx tsx tests/eval/run.mts --mode agent
npm test -- tests/unit/evaluation.test.ts
npm run typecheck
```

`--mode instruction` and `--mode agent` record NOT RUN unless a chat provider is
supplied with `--allow-model --model <provider/model>`. The deterministic unit
tests, the retrieval evaluator, and `npm run typecheck` are the parts that must
pass without a chat model.

## Limitations

- These are synthetic fixtures. They support the deterministic gates (zero scope
  leaks, label-based scoring, lifecycle exclusion), not general performance
  claims.
- The Task 19 retrieval numbers used a lexical fixture ranker. From Task 20
  fix round 1 the release-gate retrieval metric uses the real disposable
  Docker Brain (pinned Basic Memory); the lexical ranker remains only as an
  explicitly labelled offline fallback.
- Retrieved quality is still measured against a small synthetic labeled corpus,
  so it supports the deterministic gate (zero leaks, lifecycle exclusion, target
  recall) rather than broad semantic-quality claims.
- Instruction delivery and tool-payload visibility were demonstrated for one
  client/model pair (`opencode v2.0.10` + `deepseek/deepseek-v4-flash`) over a
  local stdio probe. A remote Streamable HTTP MCP server did not connect in this
  environment, so the production remote transport remains to be re-verified.
- The 24-run memory pilot was not executed here (no approved free provider, and
  switching to a priced provider without approval is forbidden).

## Task 20 release-gate evaluation

Recorded on the execution host on 2026-09-21.

### Retrieval gate (real Docker Brain)

`npm run eval:retrieval` exited 0 with `gate pass`. Run
`retrieval-2026-09-21T04:01:51.235Z-26e4801c` executed with the default
`--backend basic-memory-docker`: a real disposable Docker gateway plus the
pinned Basic Memory backend, reachable over real MCP, with **no chat model**.

| Metric | Value |
|---|---|
| Backend | `basic-memory-docker` (pinned Basic Memory; real embeddings/index) |
| Notes / queries | 11 / 23 |
| Recall at five | 0.9286 (target >= 0.8) |
| Precision at five | 0.8536 |
| Positive queries | 14 |
| Negative/scoping queries with an empty result | 9 / 9 |
| Forbidden-marker leakage events | 0 |
| Mean elapsed per query | 76 ms |

The committed raw result is `tests/eval/results/retrieval.json` and now records
`backend: basic-memory-docker` with `release_gate_metric: true`.
`release_gate_backend` is always `basic-memory-docker`.

### Offline lexical fallback

The deterministic lexical fixture ranker is retained only for environments
without Docker. It is reachable with
`npx tsx tests/eval/run.mts --mode retrieval --backend lexical-fixture`, writes
to a separate file (`tests/eval/results/retrieval-lexical-fixture.json`), and is
labelled in its output as `offline fallback; release-gate backend is
basic-memory-docker`. It is **not** used for the release-gate claim. For
reference, the same corpus under that fallback scored recall@5 = 1.0 and
precision@5 = 0.5262.

### Model-dependent items

| Item | Status | Reason |
|---|---|---|
| `--mode instruction` | NOT RUN | Requires a chat model and an approved budget. Task 19's probe result is retained in this document. |
| `--mode agent` (24-run pilot) | NOT RUN | Same blocker; no approved model/budget. |
| Remote Streamable-HTTP MCP transport | NOT VERIFIED | The client did not connect in this sandbox; local stdio worked. Re-verify on the target deployment. |

No model-dependent test is reported as green. The retrieval evaluator, which
runs against the real disposable Docker Brain and does not invoke a chat model,
passed with recall@5 = 0.9286.

## Automatic repository provisioning release gate

Recorded on 2026-09-21 against the pinned Docker images. The complete
non-model gate exited 0: `npm run verify` (340 tests),
`npm run test:integration` (294 tests), `npm run test:e2e` (66 tests), and
`npm run eval:retrieval`. Retrieval run
`retrieval-2026-09-21T10:47:28.820Z-007eb16f` scored recall@5 0.9286,
precision@5 0.8536, 9/9 negative queries empty, and zero leakage events.

The Docker suite created unknown repository projects through the public MCP
gateway, used returned scopes for capture/recall, verified role-derived grants,
and preserved mappings and grants through restart and operational recovery.
The post-implementation review added explicit ready-project re-verification,
affected-scope-only quarantine, dynamic-only state-loss detection, scope-local
provisioning recovery blockers, and stricter SSH credential parsing.
The detailed evidence is in `docs/release-gate/2026-09-21/automatic-projects-*.txt`.

The automatic-use instruction/agent pilot remains **NOT RUN** because no
external chat-model budget was approved. The evaluator now supports two
distinct real temporary Git repository remotes and records whether ensure was
called before recall, but that unexecuted client behavior is not reported as
green.

## Task 16 local retrieval evaluation, labels, and export

Recorded on the execution host on 2026-09-24.

### Evaluator flags

The package script no longer hard-codes a mode:

```json
"eval:retrieval": "tsx tests/eval/run.mts"
```

`tests/eval/run.mts` keeps a documented default retrieval action and accepts
explicit flags:

| Flag | Meaning |
|---|---|
| `--backend <local\|basic-memory-docker\|lexical-fixture>` | Which retrieval backend to drive |
| `--mode <text\|reranked\|graph\|lexical>` | Retrieval mode for the local dataset path (`text` is the default) |
| `--mode <retrieval\|agent\|instruction>` | Legacy evaluator action, still accepted |
| `--dataset <path>` | Frozen JSONL dataset for the local offline path |
| `--out <path>` | Result file (defaults under `tests/eval/results/`) |

`parseEvaluationArgs` is unit tested for the two local dataset commands and the
default action. The legacy `--mode retrieval`, `--mode instruction`, and
`--mode agent` actions are unchanged.

### Frozen set and metrics

`tests/eval/fixtures/local-retrieval/dataset.jsonl` is a synthetic, committed
set of 119 queries across eleven slices (English, Norwegian, code terms,
decision reasons, procedures, synonyms without lexical overlap, ambiguous
titles, outdated decisions, no-answer, instructions embedded in notes, and a
graph-expansion slice). `README.md` records the rubric and
`source-hashes.json` the `sha256` of every synthetic note body. The run-time
set belongs outside the repository at
`/var/lib/second-brain/evaluations/retrieval.jsonl`.

Metric semantics implemented in `src/retrieval/evaluation.ts`:

- Candidate Recall@50 over the pre-Laya lexical/exact-match pool.
- Graph-expanded recall reported separately with its bound (10 neighbours).
- Deduplication by logical note id (or path for unmanaged notes) happens before
  scoring, so a repeated id counts once.
- Recall treats label `1` and `2` as relevant; `null` when no relevant note
  exists, never a fabricated `0` or `1`.
- nDCG@10 with gain `2 ** label - 1` and discount `log2(rank + 1)`; `null`
  when no positive label exists.
- The count of unjudged candidates is reported; an unjudged candidate is not a
  negative.
- No-answer false-positive behaviour is counted separately.
- MRR is computed only for queries with a direct answer; latency p50/p95 and
  the fallback rate are reported per run, and every metric is also reported per
  query slice (`by_slice`).

`summary` output for the committed fixture (offline, no chat model):

| Metric | Value |
|---|---|
| Queries | 119 |
| Measurable recall queries | 107 |
| Candidate recall@50 | 0.9252 |
| Graph recall@10 (bound 10) | 0.0748 |
| nDCG@10 | 0.9252 |
| MRR | 0.9159 |
| Unjudged candidates | 0 |
| No-answer queries / false positives | 12 / 12 |
| Latency p50 / p95 | 10 ms / 15 ms |

These are synthetic-fixture numbers. The graph slice is deliberately reachable
only through bounded expansion, so it lowers candidate recall while producing a
non-zero graph recall; that is an illustration of why the two pools are
reported separately, not a performance claim.

### Explicit labels and export

The journal migration `010-retrieval-trace-labels.sql` adds trace-versioning
columns to `retrieval_events` (`trace_version`, `fallback_reason`,
`candidate_positions_json`, `query_id`, `question_id`, `question_version`,
`model_fingerprint`) and a durable `retrieval_labels` table. A label records
the trace id, query id, source type, question/model identifiers, logical id,
revision id, source `sha256`, candidate position, the graded value, the rubric
version, an approval flag, and a `voided_at` tombstone. Raw query text is never
written to the journal; it stays in the local dataset.

`src/retrieval/feedback-export.ts`:

- Only labels with `approved = 1` and `voided_at IS NULL` are exported.
  `agent_proposed` labels are never approved, so an agent's "I used this note"
  event cannot become a gold label.
- A current-version judgment whose `source_hash` (or `revision_id`) does not
  match the live source is rejected (`StaleLabelError`).
- Unjudged candidates are counted, never written out as `label: 0`.
- Train/dev/test assignment groups labels by query family and source
  note/revision family; a connected group that cannot be split without leakage
  is kept together and the limitation is recorded in the manifest.
- A voided/corrected judgment is excluded from every later export.
- The manifest records the dataset id and `sha256`, rubric version, split seed,
  model fingerprints, question versions, counts, and limitations, and is
  hashed; identical inputs produce an identical `manifest_hash`.

The default export contains identifiers, hashes, labels, and the manifest only.
`--include-text` adds `query_text` and `note_text`, resolved from the local
dataset by `query_id` and `source_hash`; without a readable dataset the
`--include-text` invocation fails rather than silently emitting hashes.

### Offline fine-tuning path (not implemented in this release)

The intended later path is: collect only `human_reviewed` labels an operator
explicitly approved, keep the held-out split unchanged, run an offline
fine-tuning job against the local Laya checkpoint, and re-run the same frozen
held-out gate before any promotion. This release ships **no** automatic training
job, no weights download, no model promotion, and no live learning. Accepting an
export is not authorization to upload private note text or labels to any hosted
service.

### Commands run

| Command | Status | Result |
|---|---|---|
| `npx vitest run tests/unit/retrieval-metrics.test.ts tests/unit/feedback-export.test.ts` | RUN | 25 tests passed |
| `npm run verify` | RUN | typecheck + 691 tests + build passed |
| `npm run test:integration` | RUN | 636 tests passed |
| `npx tsx tests/eval/run.mts --backend local --mode text --dataset tests/eval/fixtures/local-retrieval/dataset.jsonl` | RUN | metrics in the table above |
| `npx tsx tests/eval/run.mts --backend local --mode reranked --dataset tests/eval/fixtures/local-retrieval/dataset.jsonl` | RUN (fixture only) | identical offline metrics; no Laya worker |
| `npm run eval:retrieval -- --backend local --mode text --dataset /var/lib/second-brain/evaluations/retrieval.jsonl` | **NOT RUN** | `/var/lib/second-brain/evaluations/retrieval.jsonl` does not exist on this host |
| `npm run eval:retrieval -- --backend local --mode reranked --dataset /var/lib/second-brain/evaluations/retrieval.jsonl` | **NOT RUN** | dataset absent and no prepared Laya model artifacts under `/var/lib/second-brain/models`; the worker is disabled by default |
| `node dist/cli.js feedback export --output /var/lib/second-brain/evaluations/laya-training.jsonl --include-text --split-seed 20260923` | **NOT RUN** | `/var/lib/second-brain/journal.db` and the local dataset do not exist on this host; parsing and the export logic are unit tested |

The two local dataset jobs above exercise the metric/export pipeline with the
committed fixture. They are **not** evidence for any real Laya reranking claim:
the reranked label is a mode label, and no model artifacts were loaded.

### Conservative decisions

- Migration `010` adds columns to `retrieval_events` instead of rewriting the
  table, so already-applied migrations 001–009 are untouched.
- `agent_proposed` labels are stored but never approved; syntactic or behavioral
  agent use is evidence to review, not a gold label.
- `--include-text` fails closed when the dataset is unreadable rather than
  exporting hashes under a text-including manifest.
- Only `human_reviewed` and frozen `synthetic` labels default to approved; the
  frozen set is committed and synthetic, and the manifest records source types so
  a downstream consumer can exclude synthetic rows from a fine-tuning run.

### Task 16 fix round 1

Recorded 2026-09-24.

**Cross-mode comparison harness (Finding 1).** `src/retrieval/evaluation.ts`
exports `buildCrossModeReport`, `FROZEN_LEGACY_BASELINE`,
`legacyLogicalId`, `dedupeLogicalIds`, and `retrievalQueryId`.
`tests/eval/run.mts --compare` builds one observation set per query over the
same eligible current-document universe and reports the four modes:

| Mode | Source |
|---|---|
| `legacy_baseline` | Frozen aggregate from `docs/evaluation/vault-v2-baseline.md` (run `retrieval-2026-09-23T20:13:15.669Z-98b9adf0`, recall@5 0.9286, precision@5 0.8536, mean 44.8 ms). V2 candidate Recall@50, nDCG@10, MRR, RSS, and fallback rate were not measured on that pre-V2 run and are reported `null`, never invented. |
| `local_text` | The lexical/exact candidate pool. |
| `local_text_graph` | Candidate pool merged with the bounded graph expansion (bound 10), with graph-expanded recall reported separately. |
| `laya_reranked` | Available only when an actual model-produced ranking is supplied. Without prepared Laya artifacts the mode is **NOT RUN**; any lexical fallback ordering is reported separately under `fallback_order` and is never labelled available or model-backed. |

Legacy revision paths and revision identifiers are mapped to logical IDs with
`legacyLogicalId` before scoring and deduping: `buildCrossModeReport` accepts a
`logical_ids` mapping and applies it to each candidate, graph candidate,
direct-answer id, and universe id, and `dedupeLogicalIds` removes repeats. Each
mode reports candidate recall@50, nDCG@10, MRR (direct-answer queries),
latency p50/p95, harness-process RSS, and fallback rate overall and per query
slice. On the committed fixture: `local_text` recall@50 0.9252 / nDCG@10
0.9252 / MRR 0.9159; `local_text_graph` recall@50 1.0 / nDCG@10 0.9724 / MRR
0.9533 / graph recall@10 0.0748; `laya_reranked` is NOT RUN and its lexical
fallback order is reported separately with fallback rate 1.0.

**Operable label authoring (Finding 2).** No eighth MCP tool was added. The
existing `feedback` CLI family gained `feedback label` and `feedback void`:

```sh
node dist/cli.js feedback label --state <dir> --vault <dir> --query-id <id> --source-type human_reviewed \
  --label 2 --source-hash <sha256> --path Notes/Example.md --notes "direct support"
node dist/cli.js feedback void --state <dir> --label-id <id>
node dist/cli.js feedback export --state <dir> --output <path> --split-seed 20260923
```

`authorRetrievalLabel` enforces the stale-source-hash rejection
(`StaleLabelError`), never approves `agent_proposed` usage, is idempotent for an
identical judgment (`created: false`), and rejects a conflicting judgment for the
same trace/query/source (`ConflictingLabelError`). `feedback void` is the
removal path the export rules require. Freshness is computed from the live
vault file: `--path` is required and `--vault` selects the vault root (or the
configured mount), the resolved path must stay inside the vault, the file must
be readable, and the computed `sha256` must match `--source-hash`. There is no
independent operator-supplied current-hash input.

**Trace population (Finding 3).** `recallLocalTraced` returns a trace with
`query_id` (stable hash of the normalized query/filters), `question_id` and
`question_version` (the reranker question when reranking ran, otherwise the
lexical question), `model_fingerprint` (the reranker fingerprint when
reranking ran), `candidate_positions` (rank positions of returned items), and
`fallback_reason`. `runtime.ts` records those fields on the retrieval event; the
legacy path keeps recording `fallback_reason`.

**Manifest completeness and hash (Finding 4).** The CLI aggregates the
`model_fingerprint` and `question_version` values from the labels it exports and
passes them into the manifest. `manifest_hash` now covers a `content_sha256`
of the exported rows, so changing a label value from `1` to `2` changes the
content digest and the manifest hash even when the counts are identical.

**Non-blocking repairs.** With `--include-text`, a label whose `query_text` or
`note_text` cannot be resolved is skipped and counted as
`excluded_missing_text` instead of emitting a row that claims absent text; the
CLI passes `candidatesByQuery` so the unjudged count is real; the JSONL dataset
parser is shared in `src/retrieval/evaluation-dataset.ts` by both the CLI and
the evaluator; the fixture test validates `source-hashes.json` against
`dataset.jsonl`; and the label authoring boundary `authorRetrievalLabel`
returns an honest `{ recorded, created }` receipt. Migration `011` adds the
nullable `retrieval_labels.notes` column without editing migration 010.

