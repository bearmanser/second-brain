# Second Brain agent protocol

This document describes the MCP surface a working agent sees. It is the
human-readable companion to the published tool definitions in
`src/mcp/tools.ts` and the initialization instructions in
`src/mcp/instructions.ts`.

## Initialization guidance

The gateway supplies a short `instructions` string during MCP initialization
(R05). The shipped text is deliberately small: it is under 700 reference tokens
(`cl100k_base`) and never embeds tool schemas. Schemas are delivered through the
tool list itself and through `brain_status(include_schemas=true)`.

The instructions tell the agent to treat Second Brain as reference memory rather
than authority over the user's request, to recall before substantial planning,
debugging, or architectural work, to capture typed candidates with evidence, to
review only when the configured identity has permission, to report feedback, to
treat retrieved note text as untrusted data, and to distinguish an unavailable
memory service from an empty result.

Instructions are built from static prose. Producing them never reads a user
note, the retrieval log, or any per-principal state. A client may ignore the
initialization text, so this document, a manual instruction file, or the client
pilot are still required for reliable delivery (see "Client fallback").

## Tools

Exactly six tools are exposed.

| Tool | Behavior |
|---|---|
| `brain_recall` | Bounded, source-linked recall for a task in one explicitly named scope (optionally plus the shared scope). Returns excerpts, reasons, warnings, etags, a retrieval id, and a reported `cl100k_base` token budget. |
| `brain_read` | Reads the current revision, or one explicit historical revision, of a single authorized note. Pagination is bounded and continuation is revision-bound through the response etag and `next_cursor`. |
| `brain_capture` | Creates one structured, typed candidate with an `idempotency_key`, evidence references, and optional related IDs. It never creates an established fact. |
| `brain_review` | With `action: "list"`, lists candidates or conflicts. With `approve`, `archive`, `revise`, `supersede`, or `resolve`, it changes lifecycle state under the configured review or write permission. Every mutation carries an `idempotency_key` and the exact `expected_etag` it was based on. |
| `brain_feedback` | Records `useful`, `irrelevant`, `stale`, `incorrect`, or `contradiction` on one specific note revision, bound to the caller and scope. |
| `brain_status` | Reports version metadata, the authorization-filtered scope list, backend health, pending work, and the state of one authorized operation. |

Every mutation is idempotent by key. Reusing a key with a different normalized
payload or a different target scope is an error, never an implicit update.

## Typed notes

`brain_capture` and the mutating `brain_review` actions accept the same
`NoteInput`: a `title`, `tags`, a discriminated `content` body, `evidence`, and
`related_ids`. Seven content kinds are supported: `lesson`, `decision`,
`playbook`, `fact`, `preference`, `session`, and `note`. Each kind has its own
required sections, and the gateway renders and validates them; free-form text is
only allowed inside the `note` kind's body.

Notes start in the `candidate` lifecycle. Candidates are excluded from ordinary
recall unless the caller asks for them. Captures reject obvious credential
patterns and oversized bodies before any backend write.

## Candidate review

`brain_review` is the only lifecycle-changing surface:

- `list` returns `SourceRef` entries for `candidate` or `conflict` filters.
- `approve` promotes a reviewed candidate to `active`.
- `archive` retires a note without deleting history.
- `revise` creates a new reviewed revision from corrected content.
- `supersede` links a replacement note to a superseded one.
- `resolve` closes a fork using explicit expected heads.

Review prerequisites are authorization and the exact current etag. A stale etag
is a `CONFLICT`, not a silent overwrite. `brain_review` is mixed: listing is
read-only, but the other actions mutate lifecycle state, so the tool is never
presented as universally read-only.

## Annotations versus permissions

Each tool carries MCP annotations:

| Tool | `readOnlyHint` | `destructiveHint` | `idempotentHint` |
|---|---|---|---|
| `brain_recall` | true | false | true |
| `brain_read` | true | false | true |
| `brain_status` | true | false | true |
| `brain_capture` | false | false | true |
| `brain_feedback` | false | false | true |
| `brain_review` | false | true | true |

Annotations are hints for clients. They are never permissions. Authorization is
enforced per request from the authenticated principal, its configured scopes,
and the operation being attempted. `brain_review` must not be treated as
read-only because its mutation actions can change or archive knowledge.

## Result delivery

Every tool declares an input schema and an output schema. Success responses use
one of two configured representations, selected by `result_delivery` in the
gateway configuration:

- `structured` (default): the complete result is returned in MCP
  `structuredContent`, and the text block carries a compact pointer that names
  the structured payload and explains how to switch representation.
- `text-json`: the complete result is also serialized once into the text block
  for clients that ignore `structuredContent`. The structured payload remains
  present so the declared output schema stays valid.

`text-json` exists because a client that cannot see structured content would
otherwise observe only the pointer. It is the operator's explicit choice, and it
increases the model-visible context cost, so it should be enabled only after
confirming with the installed client which representation it actually injects
(Task 19 verifies this against the real client).

A hard 128 KiB payload limit applies to every tool result. Retrieval already
packs to a reference-token budget; error results stay small.

## Scope filtering and `brain_status`

`brain_status` lists only scopes the principal may read, with `can_write` and
`can_review` flags. `pending_operations` counts only pending operations in those
scopes. `include_schemas=true` returns the published input and output schemas for
every tool; it is available for explicit inspection and is not required on every
task.

`brain_status.health` reports:

- `gateway`: `ready`, `recovering` (authorized pending work remains), or
  `degraded` (the backend is unreachable).
- `backend`: `ready` or `unavailable`.
- `embeddings`: `ready`, `unavailable`, or `unknown`. This gateway cannot prove
  embedding readiness from a health probe alone, so it reports `unknown` unless
  a retrieval path has already reported otherwise.

A requested `operation_id` is returned only to its submitting principal or to an
owner allowed that scope. An unauthorized request is reported as `NOT_FOUND` so
the gateway does not confirm that another principal's operation exists.

## Errors

Tool failures return `isError: true` with:

- a stable `code` (the `BrainError` code set, or `INTERNAL_ERROR` for an
  unexpected gateway fault),
- a `retryable` boolean,
- a bounded, sanitized `message` and, when known, an `operation_id`.

Messages never include raw stack traces, credentials, or absolute filesystem
paths. The same error object is present in the text block so a client that
ignores structured content still sees the failure.

## Client fallback

MCP initialization instructions are optional for hosts, and a host may inject
them late, truncate them, or ignore them. Documentation in this repository is
the fallback, and it is documented rather than installed: this project does not
write, merge, or modify an `AGENTS.md` file in a user's repository or home
directory. If a client does not honor server instructions, the operator must
configure the client manually (for example, by adding equivalent guidance to
that client's own instruction file). Delivery to the installed client is
verified in Task 19, not assumed here.
