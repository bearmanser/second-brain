# Second Brain

A portable personal memory system that an AI coding agent can use through one
authenticated remote MCP connection, with the knowledge stored as plain Markdown
that the owner can open in Obsidian.

The deployment is **one repository** and **one Docker Compose application with
two services**:

| Service | Role | Published? |
|---|---|---|
| `brain` | Custom TypeScript MCP gateway; the only application interface | `127.0.0.1:7331/mcp` (loopback only) |
| `memory` | Basic Memory MCP backend; indexing and retrieval | not published |

There is **no OpenCode plugin, no separate REST application API, no server-side
chat model, and no automatic transcript ingestion**. The working agent calls one
MCP endpoint; the gateway validates requests, authorizes scopes, serializes
writes, and adapts to Basic Memory.

## What it provides

- Seven typed note kinds: `lesson`, `decision`, `playbook`, `fact`,
  `preference`, `session`, and flexible `note`.
- Candidate capture and an explicit, owner-aware review workflow.
- Non-destructive, idempotent revisions; manual Obsidian edits are detected and
  never silently overwritten.
- Scope authorization: a project, its explicitly permitted shared scope, and an
  owner-only profile scope, never inferred from a folder name.
- Bounded retrieval with explicit empty/partial/degraded states, not invented
  confidence.
- Cold backup, restore verification, and index rebuild procedures.
- Offline hybrid search after the local embedding model has been warmed once.

## The six tools

| Tool | Purpose |
|---|---|
| `brain_recall` | Scoped text/hybrid retrieval with phase, kind, and budget options. |
| `brain_read` | Current or explicit historical revision with bounded pagination and an etag. |
| `brain_capture` | Create a structured candidate with evidence and an idempotency key. |
| `brain_review` | List candidates/conflicts; approve, revise, supersede, archive, or resolve. |
| `brain_feedback` | Record useful/irrelevant/stale/incorrect/contradiction feedback. |
| `brain_status` | Authorized scopes, schema/version, backend health, pending work, operation state. |

Raw Basic Memory tools (`write_note`, `search_notes`, `delete_note`,
`read_note`, `fetch`, ...) are **not exposed**; the backend port is private to
the Compose network.

## Quick start

```sh
# 1. Load the pinned image references and build once.
bash scripts/setup.sh

# 2. Start the two services.
docker compose up -d

# 3. Verify.
docker compose exec brain node dist/cli.js health
```

Then register the gateway with your MCP client. A verified OpenCode v2 snippet is
in `config/opencode.example.jsonc`. Full detail, prerequisites, token loading in
WSL, Obsidian setup, operations, and limitations are in
[docs/setup.md](docs/setup.md).

## Documentation

| Document | Contents |
|---|---|
| [docs/setup.md](docs/setup.md) | User runbook: setup, client registration, tools, credentials, upgrades. |
| [docs/security.md](docs/security.md) | Authentication, authorization, note-as-data, logging, network exposure. |
| [docs/operations.md](docs/operations.md) | Recovery, backup, restore, index rebuild, logs, safe upgrades. |
| [docs/agent-protocol.md](docs/agent-protocol.md) | Wire protocol and error codes. |
| [docs/compatibility.md](docs/compatibility.md) | Observed toolchain, pinned digests, and release-gate results. |
| [docs/evaluation.md](docs/evaluation.md) | Retrieval evaluation and client pilot record (including NOT RUN items). |
| [docs/requirement-coverage.md](docs/requirement-coverage.md) | Requirement-by-requirement implementation and test evidence. |

## Verification

| Command | What it runs |
|---|---|
| `npm run verify` | Type check, offline unit and contract tests, production build. |
| `npm run test:contract` | Pinned backend wire-contract tests (offline fixtures). |
| `npm run test:integration` | In-process gateway integration suites. |
| `npm run test:e2e` | Docker end-to-end, security, lifecycle, and operations suites. |
| `npm run eval:retrieval` | Labeled retrieval evaluation against a real disposable Docker Brain and pinned Basic Memory backend (no chat model). Needs Docker; the offline lexical fallback is not the release-gate metric. |

Docker-dependent suites are explicit jobs, not silent skips. Tests that require
an external chat model (the instruction/agent pilot) are **NOT RUN** without an
approved budget and are recorded as not run, never as green.

## Limitations

- **Instruction delivery is client-controlled.** The gateway publishes
  memory-use guidance in MCP initialization, but MCP hosts decide whether and how
  to inject it. Instruction delivery must be verified per client; the server
  cannot enforce that an unseen client injected it.
- **Compaction capture is not guaranteed.** The system cannot observe an agent's
  context compaction. Memory capture depends on the agent choosing to call
  `brain_capture`; the gateway never ingests transcripts.
- **The gateway is not a sandbox.** A local root user or an unrestricted agent
  shell can bypass the MCP gateway and modify files directly.
- Create-only retained revisions leave visible revision files in Obsidian. This
  version does not maintain a mutable `current.md` copy.
- Redaction of credentials in logs is best-effort, not a complete privacy
  guarantee.
- Retrieval limits are reference-token estimates for one documented tokenizer
  (`cl100k_base`); they are not guaranteed to match every model family.

## Third-party component: Basic Memory

The `memory` service runs the unmodified Basic Memory Docker image pinned in
`config/images.env` and `config/dependency-lock.json`
(`ghcr.io/basicmachines-co/basic-memory@sha256:939f1173...`, OCI image version
`0.23.2`, MCP server `4.0.0b1`). Basic Memory is a **third-party component**, not
part of this repository, and it is used through its published MCP interface only.

The license and notices found in that pinned distribution are:

- `LICENSE`: **GNU Affero General Public License, Version 3** (`AGPL-3.0-or-later`).
- `pyproject.toml`: `license = { text = "AGPL-3.0-or-later" }`.
- Author metadata: `Basic Machines <hello@basic-machines.co>`.
- Project: `basic-memory` (https://github.com/basicmachines-co/basic-memory).

No legal interpretation is given here. Operators distributing a system that
includes or links this component should review the AGPL-3.0-or-later terms and
Basic Memory's own notices. This repository does not vendor Basic Memory source or
relicense it. The license for this repository's own code is an owner decision
that must be made before public distribution.
