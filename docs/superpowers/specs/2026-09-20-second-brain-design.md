# Second Brain: implementation design

Date: 2026-09-20  
Status: The high-level draft was approved in the conversation. This document records the detailed design that accompanies the implementation plan; the full package is awaiting review.  
Companion plan: `../plans/2026-09-20-second-brain.md`

## 1. Outcome and scope

Build a portable personal memory system that an AI coding agent can use through one remote MCP connection. An agent can find prior knowledge, submit structured discoveries, review candidates, report bad memories, and resume work using temporary handoff notes. The owner can browse and edit the underlying Markdown in Obsidian.

The deployment is one source repository and one Docker Compose application containing two services: a custom TypeScript MCP gateway and an unexposed Basic Memory backend. The gateway is the only public application interface. There is no OpenCode plugin, separate REST application API, dedicated curator model service, or custom web interface.

The existing agent interprets natural language and authors the knowledge. The gateway validates data and applies explicit rules. Basic Memory supplies indexing and retrieval. The vault holds the knowledge. Embeddings are local, but notes returned to a cloud-hosted working agent do enter that agent's context.

## 2. Requirements carried into every task

These identifiers are used by the plan's coverage matrix.

| ID | Requirement |
|---|---|
| R01 | One repository; two long-running Compose services; only the gateway's MCP endpoint is published. |
| R02 | No custom OpenCode plugin, no separate REST application API, no server-side chat-model dependency, and no automatic transcript ingestion. |
| R03 | Use Node.js 24 LTS and TypeScript for the gateway. Use the official MCP TypeScript SDK, Zod 4, local SQLite operational storage, and the Basic Memory adapter. |
| R04 | Use MCP Streamable HTTP at `/mcp`, authenticated on every request. Bind the published host port to `127.0.0.1:7331` by default. |
| R05 | Publish memory-use guidance during MCP initialization. Verify actual OpenCode instruction delivery and behavior; do not assume all clients inject that text. |
| R06 | Support seven initial note kinds: `lesson`, `decision`, `playbook`, `fact`, `preference`, `session`, and flexible `note`. |
| R07 | Preserve Markdown as authoritative knowledge. Search indexes and the note catalogue are rebuildable; the operation journal and feedback are separate persistent state requiring backup. |
| R08 | Authenticate the caller before scope resolution. Only explicitly allowed scopes may be searched, read, written, reviewed, or linked. |
| R09 | New captures are candidates, not verified facts. A review decision is distinct from validation and from independent factual verification. |
| R10 | Agent writes are non-destructive, idempotent, and revision-aware. Never overwrite an existing knowledge revision through Basic Memory. |
| R11 | Manual Obsidian edits are supported. Detect malformed content, changed approval fingerprints, duplicate identities, missing parents, and revision forks; never silently overwrite them. |
| R12 | Return bounded, source-linked context. Separate empty results from failures, partial searches, stale content, and unavailable embeddings. |
| R13 | The service does not execute note content, fetch evidence URLs automatically, or treat notes as permission to override instructions. |
| R14 | Reject obvious credentials in captures, keep private data out of normal logs, and document that redaction is best-effort rather than a complete privacy guarantee. |
| R15 | Persist state across restarts; reconcile uncertain writes; provide a tested backup, restore, and index-rebuild procedure. |
| R16 | Deliver unit, contract, integration, fault-injection, security, and retrieval-evaluation tests, plus an OpenCode pilot. |
| R17 | Do not add source-code comments unless requested. Do not implement deferred integrations during this plan. |
| R18 | Pin dependencies and container digests after an executable compatibility probe. Do not invent tested versions or ship floating `latest` references. |

## 3. Documented capabilities versus implementation assumptions

The following facts were checked against primary documentation on 2026-09-20. They are not a claim that this deployment has been run.

| Documented fact | Design consequence | Source |
|---|---|---|
| OpenCode V2 supports remote MCP, configurable headers, and disabling OAuth for a preconfigured credential. | Use one configured MCP connection; no plugin is required for access. | [S01] |
| OpenCode documents MCP guidance in its initial instruction ordering. | Test that the installed client actually exposes the server instructions before a memory tool call. | [S02] |
| MCP initialization has an optional server `instructions` field; hosts decide how to use it. | Provide a documented instructions-file fallback, but do not install it by default. | [S03] |
| Streamable HTTP supports a single MCP endpoint and requires Origin validation when the header is present. | Use SDK transport handling plus authentication, explicit host validation, and an Origin allowlist. | [S04] |
| Basic Memory has an official Docker image; its container endpoints are not secured by Basic Memory itself. | Keep its port private and authenticate at the gateway. | [S05] |
| Basic Memory supports typed Markdown/frontmatter, structured metadata filters, and hybrid search. | Reuse these capabilities instead of writing a second semantic search engine. | [S06], [S07], [S08] |
| The tool reference documents `overwrite=false` for note creation and describes checksum-based reviewed edits as Cloud functionality. | Do not assume local compare-and-swap edits exist. Use create-only retained revisions. | [S09] |
| Basic Memory's defaults include a local FastEmbed model and SQLite vector storage. | No paid embedding API is required. Cache model assets and test startup without network access after warm-up. | [S08] |
| Node.js 24 is listed as an LTS line. | Target that major, then record the exact patch and image digest in the compatibility lock. | [S10] |
| Zod supports discriminated unions and JSON Schema generation. | Derive validation, MCP input schemas, and examples from one registry. | [S11], [S12] |

The integration probe must establish real response shapes, metadata round-tripping, materialization timing, local project routing, usable Streamable HTTP transport, and model-cache paths. No downstream code may assume these from a prose diagram.

## 4. Architecture and boundaries

The working agent calls the gateway's six tools. The gateway authenticates, validates the tool request, resolves the allowed scope, and invokes a feature service. Feature services share the schema registry, catalogue, operation journal, and Basic Memory adapter.

The adapter talks to the backend through its private MCP endpoint. It never reaches into Basic Memory's database tables. The gateway also receives a read-only mount of the vault: this lets it verify exact materialized files and detect manual changes without relying on search-index freshness. Basic Memory is the only application process writing knowledge revisions.

The gateway owns a separate SQLite database for idempotency, mutation recovery, feedback, audit metadata, and a rebuildable catalogue. It is not a duplicate document database. Pending write payloads are retained only until recovery and audit requirements are satisfied.

Use one gateway process and one gateway replica for this release. Multiple agent sessions are supported. Multiple independent gateway writers sharing the same vault are not supported; acquire an instance lock and refuse the second writer.

### Storage layout

The host chooses `VAULT_PATH`. The default is a gitignored `./vault`. The directory is opened as an Obsidian vault. The entire directory is mounted read/write into Basic Memory and read-only into the gateway.

Logical scopes map to separate Basic Memory local projects and fixed paths:

| Scope ID | Vault path | Typical contents |
|---|---|---|
| `shared` | `Shared/` | Explicitly generalized lessons and playbooks. |
| `profile` | `Profile/` | Owner-approved preferences and environment facts. |
| `freellmapi` | `Projects/freellmapi/` | Pilot project memories. |

Project scope IDs are not inferred from a folder basename. They are configured and supplied explicitly by the agent, optionally assisted by a configured repository-remote alias. Ambiguous or unauthorized identifiers fail closed. No `search_all_projects` pass-through is exposed.

Within each scope, route by note kind into `Lessons`, `Decisions`, `Playbooks`, `Facts`, `Preferences`, `Sessions`, or `Notes`. Each logical note gets a stable UUID directory. Each revision is a separate Markdown file under that directory, with a unique title suffix derived from its revision UUID. Store the human title separately as `brain_title` so the gateway presents a clean title.

Example physical organization:

```text
vault/
  Shared/
    Lessons/
  Profile/
    Preferences/
  Projects/
    freellmapi/
      Lessons/
        <logical-note-id>/
          compare-streaming-r<revision-id>.md
      Decisions/
      Playbooks/
      Facts/
      Preferences/
      Sessions/
      Notes/
```

Angle-bracket values in this tree describe runtime-generated UUIDs, not filenames to create literally. Executable examples in the plan use concrete fixture IDs.

The operational database, Basic Memory configuration/index, and model cache use separate named volumes on the Linux filesystem. Do not synchronize live SQLite databases through Obsidian Sync, a network share, or a Windows/WSL shared-file path.

## 5. Revision model: a deliberate detailed-design choice

This is a clarification of the draft's safe-update requirement, not an already implemented feature.

A logical note has a stable `brain_id`. A revision has its own `brain_revision_id`, zero or more parent revision IDs, content, evidence, and lifecycle state. Capture, promotion, revision, supersession, and archival create new revision files. Existing revision files are never overwritten or deleted by an agent operation.

The service presents one logical head per note. Older revisions remain available through explicit history reads. For ordinary recall, only the valid current head is eligible. Do not select a head merely by modification time or a largest revision number. Validate the parent graph. Multiple heads, missing parents, duplicate revision IDs, or cycles produce a conflict state requiring review.

Each mutation supplies an `expected_etag` for every existing note it changes. The etag binds the head revision and the raw materialized content hash. The gateway serializes its own mutations and checks those etags. If an Obsidian edit occurs after a preflight check, the original file is still not overwritten: the new revision remains retained, and reconciliation flags the branch or changed-parent conflict. An operation may consequently return `stored_conflict` rather than pretend an automatic merge succeeded.

The tradeoff is visible retained revision files in Obsidian. This version does not create a mutable `current.md` copy or a second canonical note representation. A cleaner generated browser index can be added separately; correctness does not depend on one.

Ordinary fork resolution requires parseable revisions with intact ancestry. Missing parents, cycles, future schemas, and changed historical-parent hashes require explicit owner recovery, not an invented automatic merge. Restoring retained bytes from a backup is the preferred repair; newly captured reviewed content may be used while damaged history stays quarantined.

## 6. Note envelope and typed content

All generated notes retain Basic Memory's fields `title`, `type`, `permalink`, `tags`, `created`, and `modified`. Use UTC ISO-8601 timestamps. `created` and `modified` are record timestamps, not automatically a fact's observation date.

Gateway-owned flat properties are namespaced with `brain_`: schema version, logical ID, revision ID, parent IDs, logical scope, human title, lifecycle state, operation ID, and approval fingerprint. The agent cannot supply these reserved properties directly. Path scope is checked against metadata; metadata cannot grant access.

The content payload is a discriminated union:

| Kind | Required content | Optional content |
|---|---|---|
| `lesson` | situation, lesson, applicability | limitations |
| `decision` | context, decision, rationale | alternatives, consequences, reconsider_when |
| `playbook` | use_when, prerequisites, nonempty steps, verification | cautions |
| `fact` | claim, applicability | valid_until |
| `preference` | preference, applicability, source_statement_ref | exceptions |
| `session` | task, state, next_actions, session_id | blockers, branch, repository_ref |
| `note` | summary, body_markdown | no additional fixed sections |

Evidence records are separate from content and may be empty for an unverified candidate. They carry a kind, an opaque reference, a short description, and an optional observation timestamp. Evidence kinds are `user_statement`, `repository`, `test_run`, `observation`, `reference`, and `hypothesis`. Supplying a reference does not prove the reference is genuine or that a test proves the explanation.

A registry entry supplies validation, Markdown section mappings, a parser, a renderer, required evidence for promotion, and retrieval defaults. Keep presentation and validation derived from the same versioned registry. Additional fields do not become universal requirements for unrelated types.

Manual additional frontmatter and unknown Markdown sections are preserved when a new revision is prepared. Reserved identity fields, scope fields, and schema versions cannot be silently changed. Unknown or malformed structures are reported for owner review, not forcibly reformatted or returned as validated typed notes. There is no general bidirectional conversion of arbitrary Markdown into structured truth.

## 7. Lifecycle and review

Persist `candidate`, `active`, `superseded`, and `archived` as lifecycle states. Track freshness, suspected errors, and parse/revision conflicts as separate effective flags. Do not overload status with both trust and temporary workflow state.

Session notes use the same lifecycle but are retrieved only for an explicitly matching session or explicit session search. Default expiry is seven days after the last meaningful session update. Expiry excludes a handoff from ordinary use; it does not delete it.

Promotion requires a reviewer-authorized credential, the exact etag, a rationale, and the type's minimum evidence. Routine project lessons can be reviewed by the existing orchestrating agent. A worker identity can capture but cannot approve. Protected preferences, profile changes, shared/global promotions, and approved architecture decisions require owner permissions. These are static credential permissions, not a role string the model can invent in a tool request.

No independent-review claim is made when the same configured agent captures and reviews. A server-side model is not introduced for review. The caller reads related notes and supplies judgment; the gateway checks the declared transition and permissions.

`brain_review` must provide a way to list pending candidates. Without that operation, candidates would accumulate with no path into normal retrieval.

For duplicate handling, exact idempotency is enforced in code. Similar search results are only possible duplicates. Do not auto-merge on a similarity threshold. A reviewer may revise one note using another as evidence, then supersede the source in an idempotent follow-up operation. Multi-note knowledge changes are not claimed to be atomic transactions.

## 8. MCP surface

Expose exactly six tools. Keep tool descriptions short and use nested discriminated content schemas where necessary.

| Tool | Main behavior |
|---|---|
| `brain_recall` | Scoped text/hybrid retrieval with phase, kind, and context-budget options. |
| `brain_read` | Current revision or explicit historical revision, with bounded pagination and an etag. |
| `brain_capture` | Create a structured candidate with evidence and an idempotency key. |
| `brain_review` | List candidates/conflicts, or approve, revise, supersede, archive, or resolve a fork. |
| `brain_feedback` | Store useful, irrelevant, stale, incorrect, or contradictory feedback on a specific revision. |
| `brain_status` | Authorized scope list, schema/version information, backend health, pending work, and a specific operation's state. |

All mutation tools require a client-supplied UUID idempotency key. Reusing a key with different normalized payload or different target scope is an error, never an implicit update.

Use MCP `structuredContent` and a compact text representation. Do not duplicate a long retrieved document in both representations by default: the default text representation is a compact guide to the structured payload. For clients that ignore structured fields, a configured text-JSON delivery mode sends the complete result in text instead. Client evaluation must confirm the real payload reaches the model and measure its actual context cost. Standard tool errors use `isError: true` and a stable error code. A stored-but-not-indexed mutation is a successful durable operation with explicit availability flags, not an unqualified "ready" message.

The MCP server does not need prompts, sampling, resource subscriptions, OAuth hosting, or a separate REST API for this release. Operational CLI commands and Docker health checks are not additional public application APIs.

## 9. Retrieval rules

Resolve allowed scope IDs before any backend call. A request for a project plus shared context searches only that project and explicitly permitted shared scopes. The default is the named scope only. Reapply scope and lifecycle checks when reading actual files; never trust stale indexed metadata alone.

Start with Basic Memory hybrid search and a bounded candidate window. Use text search when requested. If embeddings fail, return an explicit degraded result only if the caller allows text fallback. Otherwise return a typed backend error. An empty search result is not an embedding or network failure.

Collapse results by logical note ID and validate the hit's revision against the catalogue. Do not return a fragment from an older revision as though it described the current note. Filter candidates, archived notes, superseded notes, conflicted notes, and unrelated session handoffs by default. Paginate within a configured work cap to find eligible heads; return `partial=true` if the cap or deadline stops the search.

Use deterministic ranking adjustments for phase/kind affinity and freshness after backend ranking. They are heuristics, not calibrated probabilities. Do not report an unexplained confidence such as 0.97. Return retrieval reasons, warnings, source references, revision IDs, and etags.

The default briefing budget is 1,500 reference tokens and six notes; the maximum is 4,000 reference tokens and twelve notes. Use one documented reference tokenizer and report its name. These limits do not promise the same token count for every model family. Apply a separate hard response byte limit. A read can request paginated content up to 8,000 reference tokens per page.

No LLM query rewriting or summarization runs in the gateway. The agent can supply concise topics and a rewritten query using its existing understanding. The gateway combines those strings, applies filters, and selects relevant sections without inventing content.

## 10. Security and privacy

Use a generated high-entropy bearer token for each configured identity. Store token hashes or a Docker secret-backed token file, never credentials in the repository or ordinary logs. Check authorization on each MCP request and do not use MCP session IDs as authentication.

Use an explicit Host allowlist and validate Origin when present. Reject unsupported methods and content types through the transport layer. Limit input size, note size, array lengths, concurrency, and backend timeouts. Do not publish Basic Memory's port or expose its raw tools to the working agent.

All file locations derive from server-owned scope mappings and generated IDs. Reject traversal, absolute paths, encoded traversal, symlinks, and paths outside the read-only vault root. Raw backend URLs, SQL, regular expressions, and filesystem paths are not public tool parameters.

A local root user or an unrestricted agent shell can still bypass the MCP gateway and modify files. This personal deployment is not a sandbox against that actor. Client and company isolation beyond the gateway needs separate deployment permissions or separate instances.

Do not send note bodies, queries, credentials, or full evidence to default logs. Store only opaque IDs, sizes, durations, outcomes, and error codes. Debug logging remains redacted. Reject obvious private keys and recognizable credential patterns, but document that no detector can guarantee that a note has no sensitive data. No patient data is used in the pilot or fixtures.

## 11. Durability and recovery

Before any backend write, persist the operation ID, payload digest, intended logical/revision IDs, target scope, and recovery payload in the gateway journal. Once the unique revision file is materialized and verified, persist the receipt. Indexing is a separate readiness state.

On timeout or process death, do not blindly submit a second write. Reconcile the intended operation ID and revision identity against the vault and backend. An ambiguous operation remains blocked until reconciled; reads may continue. Identical retries return the same receipt.

Recover pending operations before permitting new mutations. Catalogue rebuilding validates graph structure and hashes. It must never revive an archived/superseded head merely because an old active revision appears first in a scan.

Provide cold backup and restore commands. Pause human edits and external sync, stop writes and both application services, verify stable before/after file manifests, copy the vault and persistent volumes, record a manifest and hashes, then restart. Do not copy a live SQLite file without its supported snapshot procedure. Restore into fresh paths first and verify note and operation counts before switching the production paths.

Rebuilding the Basic Memory index is different from restoring the gateway operation journal. The first is derived; the second preserves retry and feedback history. A missing operational database triggers explicit recovery mode, not silent fresh initialization on a nonempty vault.

## 12. Verification and release

The release gate is reproducible functional correctness, not a promised speedup. Test schema behavior, authorization, metadata round-trip, instructions at initialization, idempotency, interruption at each write stage, manual edits, forks, expired sessions, stale index fragments, poisoned notes, malformed backend output, and persistence across restarts.

Use synthetic FreeLLMAPI-like memories for initial integration tests. Measure recall against a small manually labeled corpus, then run multiple memory-enabled and memory-disabled agent tasks with the same model and task settings. Record actual tokens and elapsed time rather than assuming memory reduces cost.

The client pilot must separately report: instructions received, tools available, recall called before substantive work, candidates captured, review performed, and measured task outcomes. The service cannot count tasks where the agent never called it without client traces; no plugin telemetry is invented.

No implementation is authorized by the existence of this document alone. Review this design and the companion full plan before execution.

## Sources

[S01]: https://opencode.ai/v2/docs/mcp-servers
[S02]: https://opencode.ai/v2/docs/instructions
[S03]: https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
[S04]: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
[S05]: https://docs.basicmemory.com/reference/docker
[S06]: https://docs.basicmemory.com/concepts/knowledge-format
[S07]: https://docs.basicmemory.com/concepts/metadata-search
[S08]: https://docs.basicmemory.com/concepts/semantic-search
[S09]: https://docs.basicmemory.com/reference/mcp-tools-reference
[S10]: https://nodejs.org/en/about/previous-releases
[S11]: https://zod.dev/api
[S12]: https://zod.dev/json-schema

All source links were consulted for planning on 2026-09-20. Version-specific deployment behavior remains subject to Task 1's executable compatibility gate.
