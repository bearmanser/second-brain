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

Run `retrieval-2026-09-21T02:03:15.063Z-4fed9666` (23 queries, 11 notes):

| Metric | Value |
|---|---|
| Positive queries | 14 |
| Recall at five | 1.0 |
| Precision at five | 0.5262 |
| Negative/scoping queries | 9 |
| Negative queries with an empty result | 9 / 9 |
| Forbidden-marker leakage events | 0 |
| Mean recall elapsed time | 85.2 ms |
| Corpus seeding (capture + review) | 5850 ms, 22 tool calls |

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

### Live instruction probe (NOT RUN)

`tests/eval/run.mts --mode instruction --allow-model` starts a disposable probe
MCP server whose `initialize` instructions carry a random marker and whose
`probe_fixture` tool returns a random fact in `structuredContent` with a text
pointer that does not contain the fact. It then runs a fresh OpenCode session
with a prompt that contains neither value.

Result: **NOT RUN**.

- A probe MCP server built on the pinned SDK was verified directly: an SDK
  client received the marker in `instructions`, listed `probe_fixture`, and
  received the fact in `structuredContent`.
- In the same disposable project, `opencode debug config` showed the project
  document (`/tmp/probe-check-…/opencode.jsonc`) with the server configured,
  but `opencode mcp list` reported `No MCP servers configured` and the model's
  Code Mode catalog never contained the probe tools. The model fell back to
  `execute`/`search` and did not call the probe tool.
- Two delivery attempts (`structured`, then `text-json`) both returned
  `exit_code: 0` with neither the fact nor the marker present. Raw telemetry,
  including reported token usage, is in
  `tests/eval/results/instruction-delivery.json`.
- A missing response must not be read as proof that instructions are absent;
  absent delivery and ignored instructions are indistinguishable here. The
  blocker is the client's failure to surface the disposable server's tools, not
  observed instruction content.

Because the tool payload was never observed in a model response, no
`result_delivery` mode is claimed as verified. The shipped default remains
`structured`; `text-json` remains the documented fallback for a client that
cannot read structured content (`docs/agent-protocol.md`). Operators must
confirm the mode against their own installed client before relying on it.

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

### Result: NOT RUN

- The configured default provider (`freellmapi/auto`) rejects its API key:
  `opencode run --model freellmapi/auto "…"` exits with `Error: Invalid API key`,
  and `FREELLMAPI_API_KEY` is not exported in this environment.
- The only authenticated provider in this environment is a priced provider
  (recorded catalog cost). Switching the pilot to it without approval is
  forbidden by the task, so the 24-run pilot was not started.

Blocker: no approved, working, free chat provider. The pilot code path is
implemented and gated behind `--allow-model --model <provider/model>`; it will
record per-run case, condition, model identifier, client version, tool timeline,
outcome, elapsed time, and reported token usage (null when unavailable).

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
npx tsx tests/eval/run.mts --mode retrieval
npx tsx tests/eval/run.mts --mode instruction
npx tsx tests/eval/run.mts --mode agent
npm test -- tests/unit/evaluation.test.ts
npm run typecheck
```

`--mode instruction` and `--mode agent` record NOT RUN until an approved chat
provider is supplied with `--allow-model --model <provider/model>`. The
deterministic unit tests, the retrieval evaluator, and `npm run typecheck` are
the parts that must pass without a chat model.

## Limitations

- These are synthetic fixtures. They support the deterministic gates (zero scope
  leaks, label-based scoring, lifecycle exclusion), not general performance
  claims.
- Retrieval quality is measured with a lexical fixture ranker, not Basic
  Memory's embedding search.
- Instruction delivery to a real model was not demonstrated in this environment.
- The 24-run memory pilot was not executed here.
