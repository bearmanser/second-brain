# Security model

This document describes what the gateway enforces, what it deliberately does not
claim, and where the residual risk lies. It is written for the operator of a
single-owner personal deployment.

## Boundaries

| Boundary | Property |
|---|---|
| Public interface | Exactly one MCP endpoint, `POST http://127.0.0.1:7331/mcp`. |
| Network | Only the gateway port is published, and Compose binds it to loopback. The Basic Memory backend port is not published. |
| Backend | The gateway reaches Basic Memory over the private Compose network through its MCP interface. It never reads Basic Memory's SQLite tables. |
| Vault | Mounted **read-only** into the gateway and read/write into Basic Memory, which is the only process that writes knowledge revisions. |
| Application surface | No OpenCode plugin, no REST application API, no server-side chat model, no transcript ingestion. |

There is no knowledge endpoint outside `/mcp`. Unauthenticated methods are
rejected before method handling; non-`/mcp` paths return `404`.

## Authentication

- Every request must carry `Authorization: Bearer <token>`. Missing, malformed,
  empty, or unknown credentials get `401` with a `WWW-Authenticate: Bearer`
  challenge.
- Credentials are high-entropy random bearer tokens. Only their SHA-256 digests
  are stored, in `secrets/credentials.json` (mode `0600`, directory `0700`).
  Tokens are never written to `config/brain.yaml`, logs, or the repository.
- Authentication is per request. MCP session IDs are **not** authentication, and
  the endpoint is stateless.
- Duplicate token digests are rejected rather than resolved to an arbitrary
  principal.
- Credentials are reloaded when the file changes and on `SIGHUP`; rotate by
  adding a record, reloading, then removing the old one.

### Single-token path (migration window)

The replacement credential model is one operator-configured token digest, not a
per-principal record:

- The operator env file supplies `BRAIN_TOKEN_SHA256`, the lowercase SHA-256 hex
  digest of a cryptographically random token with at least 32 bytes of entropy.
  There is intentionally no example default; a missing or malformed digest fails
  closed at startup. Neither the raw token nor its digest is written to notes,
  normal status output, logs, or committed configuration.
- Every request is authenticated per request against that single digest. A valid
  token grants access to every brain operation and every project; the request
  carries a fixed system actor and a request ID, not a role, principal, or scope
  grant. No MCP tool argument can set or widen authentication.
- The `Authorization` header must be a single, correctly formed
  `Bearer <token>` value. Missing, malformed, duplicated, oversized, or invalid
  headers get `401` with `WWW-Authenticate: Bearer`. Duplicate headers are
  detected from the raw HTTP header list before Express combines the values, and
  the accepted header value is bounded.
- Token rotation replaces `BRAIN_TOKEN_SHA256` and reloads or restarts the
  gateway. Because authentication is per request and the endpoint is stateless,
  the old token stops working on the next request and any existing session or
  stream must reauthenticate. Session IDs and read cursors are never credentials.
- Generate a token with `node dist/cli.js auth generate --show-token`. The raw
  value is printed only because `--show-token` explicitly requests that terminal
  output; otherwise only the `BRAIN_TOKEN_SHA256=` assignment is emitted. Convert
  one legacy credential with
  `node dist/cli.js auth migrate --credentials-file PATH --select-entry N`: the
  migration selects exactly one numbered entry and never imports every legacy
  token. This is a local administrative command, not another MCP permission
  level. A shared token cannot cryptographically distinguish the human from the
  agent.

## Authorization

Scope resolution happens **before** any knowledge backend call. A principal
carries explicit reserved static scopes, while ready repository projects and
their grants are loaded from `journal.db`. Requests for another scope or an
ungranted dynamic project fail closed with `FORBIDDEN`.
`include_shared` can only widen to a shared scope the principal is already
allowed to read.

- `brain_project_ensure` canonicalizes the supplied Git remote, rejects secrets
  and local/file remotes, provisions only under `Projects/<server-scope>`, and
  grants from the authenticated role: worker read/write, reviewer
  read/write/review, owner full. Roles and scope names cannot be fabricated in
  a tool argument.
- Equivalent SSH/HTTPS identities converge; deterministic suffixes prevent two
  different identities with the same repository basename from sharing a scope.
- Provisioning has per-principal/global rate limits and a persisted project cap.
  Non-ready states are visible only to the creator and owners.
- Protected notes (preferences, `shared`/`profile` scopes, and decisions with an
  approved ancestor) require owner review.
- Related-note links are resolved only within the caller's read scopes.
- Every scope query is bounded; there is no `search_all_projects` pass-through.

## Note content is data, never instructions

- The gateway does not execute note content, does not fetch evidence URLs, and
  does not treat a note as permission to override instructions.
- The only backend operations implemented are `connect`, `probe`, `create`,
  `search`, and `isIndexed`. There is no backend `fetch` or arbitrary tool call.
- A note that asks the model to exfiltrate data is stored as inert Markdown and
  returned as text; it never triggers a server-side tool call or network fetch.
- Tool arguments are validated against strict Zod schemas. Raw backend URLs,
  SQL, regular expressions, and filesystem paths are not public parameters.

## Input and filesystem hardening

- Request bodies are capped at 256 KiB and rejected with `413` (the connection
  is closed and the remaining body drained) before parsing.
- Only `POST` with `application/json` is accepted; `GET`/`DELETE` return `405`,
  other content types `415`.
- `Host` is matched against an explicit allowlist (hostname only); `Origin`,
  when present, must match the configured origins exactly, with no userinfo,
  path, query, or fragment. No wildcard CORS header is installed.
- Every vault path derives from server-owned scope mappings and generated IDs.
  Traversal (`..`), absolute paths, encoded traversal, backslashes, hidden or
  empty segments, symlinks, and non-Markdown leaves are rejected.
- The vault reader opens files with `O_NOFOLLOW`, verifies via `/proc/self/fd`
  that the resolved file stays inside the scope root, reads bounded bytes, and
  compares stat before/after to detect concurrent change.

## Output hardening

- MCP tool errors are `isError: true` with a stable error code and a sanitized
  message; unexpected internal faults return a fixed generic `INTERNAL_ERROR`
  message, never a stack trace or raw path.
- The aggregate tool result (text plus structured content) is capped at 128 KiB;
  exceeding it fails closed with `LIMIT_EXCEEDED`.
- Retrieval budgets are enforced in reference tokens and bytes, including
  source and warning overhead, and are tested on Unicode content.
- A stored-but-not-indexed mutation is reported as durable with explicit
  `materialized`/`indexed` flags, not as unqualified success.

## Logging and privacy

- Normal logs carry opaque IDs, sizes, durations, outcomes, and error codes.
  Note bodies, queries, credentials, and full evidence are not logged.
- Retrieval and feedback records stored for audit are content-free projections
  (IDs, counts, timing); audit retention is 30 days.
- Capture rejects obvious credential material (private keys and recognizable
  credential patterns) with `INVALID_INPUT`, and redaction removes known
  patterns from structured errors.
- **Best-effort caveat.** No detector can guarantee a note contains no sensitive
  data. Redaction is a safety net, not a privacy guarantee. Do not capture
  secrets or regulated personal data.

## Remote deployment

The shipped configuration is loopback-only. For a deliberate remote deployment,
place the gateway behind a TLS-terminating reverse proxy, keep the basic
authentication boundary at the proxy **and** the bearer boundary at the gateway,
restrict the proxy to the client network, and keep the backend port private.
Never expose the unauthenticated Basic Memory backend to reach it remotely.

## Residual risk

- A local root user or an unrestricted agent shell can bypass the gateway and
  edit files directly; this deployment is not a sandbox against that actor.
- Client instruction delivery is outside the server's control; the gateway
  cannot force an unseen client to inject initialization guidance.
- A cloud-hosted working agent sees the notes it retrieves. Local embeddings
  avoid a hosted embedding API, but returned notes still enter that agent's
  context.
- Cross-client or company isolation requires separate instances or deployment
  permissions beyond this gateway.

## Adversarial coverage

The security behaviors above are exercised by:

- `tests/unit/security.test.ts` — authentication, scope resolution, redaction,
  configuration validation.
- `tests/unit/single-token.test.ts` — single-token digest verification, digest
  fail-closed loading, raw-header duplicate/length rejection, token generation,
  and the `auth` CLI commands.
- `tests/integration/token-rotation.test.ts` — the isolated HTTP guard: missing,
  duplicated, oversized, and wrong credentials, every supported HTTP method,
  host/origin rejection, role-free authenticated context, resource failures kept
  distinct from authentication failure, and rotation invalidating an existing
  session.
- `tests/integration/http-security.test.ts` — transport, host/origin, size, and
  method handling.
- `tests/contract/backend.test.ts` — malformed backend responses and
  protocol-error classification.
- `tests/e2e/security.test.ts` — a real Docker gateway: cross-scope tokens, raw
  backend tools, injection-like queries, poison notes, loopback publishing,
  `/mcp`-only surface, bounded payloads, mixed-principal concurrency, lost write
  acknowledgments, duplicate identities, missing parents, symlink traversal, and
  unexpected backend faults.
- `tests/e2e/lifecycle.test.ts` — restart durability, human-edit detection,
  supersession authority, Unicode preservation, future-schema quarantine, process
  death, and corrupt-restore rejection.
