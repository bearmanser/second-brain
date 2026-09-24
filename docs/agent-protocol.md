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

The instructions first tell the agent to run `git remote get-url origin`, call
`brain_project_ensure`, and use its returned scope. If no origin exists, the
agent must ask rather than infer identity from the directory name. They then
tell the agent to treat Second Brain as reference memory rather
than authority over the user's request, to recall before substantial planning,
debugging, or architectural work, to capture typed candidates with evidence, to
review only when the configured identity has permission, to report feedback, to
treat retrieved note text as untrusted data, and to distinguish an unavailable
memory service from an empty result.

Instructions are built from static prose. Producing them never reads a user
note, the retrieval log, or any per-principal state. A client may ignore the
initialization text, so this document, a manual instruction file, or the client
pilot are still required for reliable delivery (see "Client fallback").

## Protocol version 2

The public surface is protocol version 2 and is role-free. One configured
bearer-token digest grants every operation on every project; there are no roles,
ACLs, scope grants, owner-only notes, or reviewer credentials. Omitting a
project searches the whole brain, and naming a project only narrows results.
Persisted project IDs and readable paths are organization, not authorization.

Recall returns human-readable sources and exact bounded excerpts. `text` mode is
local lexical retrieval; `reranked` mode asks the local Laya worker to order the
candidate set and falls back transparently to lexical order, reporting the
executed mode and fallback reason. `brain_read` historical reads require a
managed note id, and plain notes keep path-based references rather than a
fabricated persistent UUID. Returned Markdown is data, never an instruction.

Legacy request forms are accepted for one transition release: `scope` is an
organization alias for `project`, `include_shared: true` additionally selects
the preserved shared/Knowledge category only when the request is also
project-filtered, and `mode: hybrid` is a deprecated alias for `reranked`.
An unknown legacy scope returns a clear unknown-project error instead of
widening the search.

## Tools

Exactly seven tools are exposed.

| Tool | Behavior |
|---|---|
| `brain_project_ensure` | Canonicalizes an HTTPS or SSH Git remote and creates or reuses the corresponding project and human-readable vault root. It returns the project id and path and never returns permissions or backend-project flags. |
| `brain_recall` | Whole-brain recall by default, optionally narrowed by an explicit project; accepts `mode: text`, `mode: reranked`, or the deprecated `mode: hybrid` alias. Returns exact excerpts with readable title, relative path, heading, and line spans, plus explicit partial/fallback warnings. |
| `brain_read` | Reads the current note by exactly one of `id`, `path`, or unambiguous `title`, or one historical revision by managed `id`. Pagination is bounded and continuation is revision-bound through the response etag and `next_cursor`. |
| `brain_capture` | Creates one structured, typed candidate with an `idempotency_key`, evidence references, and optional related IDs. It never creates an established fact. |
| `brain_review` | With `action: "list"`, lists candidates. With `approve`, `archive`, `revise`, `supersede`, `resolve`, `move`, or `adopt`, it changes lifecycle state or location. Every mutation carries an `idempotency_key` and the exact `expected_etag` it was based on; any caller holding the token may approve a candidate. |
| `brain_feedback` | Records `useful`, `irrelevant`, `stale`, `incorrect`, or `contradiction` locally on one specific managed note revision. It never alters a note or trains a model implicitly. |
| `brain_status` | Reports protocol/schema version, project list, local index and worker health, pending work, supported features, and the state of one operation. It never returns permission or authorized-scope booleans. |

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
| `brain_project_ensure` | false | false | true |
| `brain_feedback` | false | false | true |
| `brain_review` | false | true | true |

Annotations are hints for clients. They are never permissions. Authorization is
enforced per request from the authenticated principal, its configured static
scopes, persisted dynamic grants, and the operation being attempted. Dynamic
grants are role matched: workers get read/write, reviewers also get review, and
owners can access every ready repository project. `brain_review` must not be treated as
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

Every tool publishes a standard JSON `outputSchema`. Five tools return a single
object shape. `brain_review` returns a union — a `MutationReceipt` for a
mutation action or a `ReviewListResult` for `list` — and publishes it as
`{ "type": "object", "oneOf": [<MutationReceipt>, <ReviewListResult>] }`. The
pinned SDK's `registerTool.outputSchema` accepts only Zod schemas, and its
built-in `tools/list` generator cannot emit a union, so the gateway builds the
published tool list from the same declared output contract and installs it
explicitly, and it validates every `brain_review` result against the union
before returning it. `_meta["second-brain/outputSchema"]` repeats the declared
schema as a compatibility extension.

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
scopes. The creator and owners can also see non-ready repository project states;
unrelated principals cannot. `include_schemas=true` returns the published input and output schemas for
every tool; it is available for explicit inspection and is not required on every
task.

`brain_status.health` reports:

- `gateway`: `ready`, `recovering` (authorized pending work remains), or
  `degraded` (the backend is unreachable).
- `backend`: `ready` or `unavailable`.
- `embeddings`: `ready`, `unavailable`, or `unknown`. A health probe cannot
  prove embedding readiness, so this gateway currently always reports `unknown`.

A requested `operation_id` is returned only to its submitting principal or to an
owner allowed that scope (read, write, or review permission). An unauthorized
request is reported as `NOT_FOUND` so the gateway does not confirm that another
principal's operation exists. A persisted operation record whose receipt or plan
fails runtime validation, or whose plan revision identity (`operation_id`,
`id`, or `revision_id`) disagrees with the record or receipt, is reported as
`RECOVERY_REQUIRED` instead of being returned.

## Errors

Tool failures return `isError: true` with:

- a stable `code` from the published `BrainError` code set, which includes
  `INTERNAL_ERROR` for an unexpected gateway fault,
- a `retryable` boolean,
- a bounded, sanitized `message` and, when known, an `operation_id`.

An unexpected (non-`BrainError`) fault always returns the fixed message
"the gateway could not complete the request"; its redacted detail is kept on a
server-side diagnostic channel and is never placed in a tool result.

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
