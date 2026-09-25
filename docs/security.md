# Security model

This document describes what the gateway enforces, what it deliberately does not
claim, and where the residual risk lies. It is written for the operator of a
single-owner personal deployment.

## Boundaries

| Boundary | Property |
|---|---|
| Public interface | Exactly one MCP endpoint, `POST http://127.0.0.1:7331/mcp`. |
| Network | Only the gateway port is published, and Compose binds it to loopback. There is no backend service or published backend port. |
| Retrieval | The gateway owns a local SQLite FTS5 index and an optional supervised Python worker inside the same container. It never contacts an external memory backend. |
| Vault | Mounted **read-write** into the application container; every write goes through the gateway's validated, journaled operations, and containment checks still apply. |
| Application surface | No OpenCode plugin, no REST application API, no server-side chat model, no transcript ingestion. |

There is no knowledge endpoint outside `/mcp`. Unauthenticated methods are
rejected before method handling; non-`/mcp` paths return `404`.

## Authentication

- Every request must carry `Authorization: Bearer <token>`. Missing, malformed,
  empty, or unknown credentials get `401` with a `WWW-Authenticate: Bearer`
  challenge.
- Credentials are a single high-entropy random bearer token. Only its SHA-256
  digest is stored, as `BRAIN_TOKEN_SHA256` in the operator `.env` file; the raw
  token lives only in `secrets/brain-token` (mode `0600`, directory `0700`).
  Tokens are never written to `config/brain.yaml`, logs, or the repository.
- Authentication is per request. MCP session IDs are **not** authentication, and
  the endpoint is stateless.
- Rotation replaces `BRAIN_TOKEN_SHA256` and restarts the container; the old
  token stops working on the next request. A `SIGHUP` cannot reload an
  environment value already injected by Compose.

### Single-token model

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

## Project resolution

There is no authorization layer. The one configured token can call every tool on
every project. A request may name a project (or the legacy `scope` alias) to
narrow the result set, but omitting it searches the whole brain and naming one
never changes access. There is no role, ACL, scope grant, owner-only note, or
reviewer credential, and no `FORBIDDEN` outcome for a well-formed token.

- `brain_project_ensure` canonicalizes the supplied Git remote, rejects secrets
  and local/file remotes, and provisions only under `Projects/<display-name>`.
- Equivalent SSH/HTTPS identities converge; deterministic suffixes prevent two
  different identities with the same repository basename from sharing a scope.
- Provisioning has global rate limits and a persisted project cap. A non-ready
  project is reported as such rather than treated as ready.
- Related-note links resolve against current content, not caller privileges.
- Every query is bounded; there is no `search_all_projects` pass-through.
- Removing roles removed the former `worker`/`reviewer`/`owner` grants and the
  legacy `secrets/credentials.json` records; operators migrating from that model
  convert exactly one digest with
  `node dist/cli.js auth migrate --credentials-file PATH --select-entry N`.

## Note content is data, never instructions

- The gateway does not execute note content, does not fetch evidence URLs, and
  does not treat a note as permission to override instructions.
- The only retrieval operations implemented are local FTS5 candidate search, a
  supervised local Python worker, and content-hash eligibility checks. There is
  no remote backend call, no `fetch`, and no arbitrary tool call.
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
place the gateway behind a TLS-terminating reverse proxy, keep the
authentication boundary at the proxy **and** the bearer boundary at the gateway,
and restrict the proxy to the client network. For example, a private ingress such
as Tailscale may publish the port on the private interface, but the token, host,
and origin checks still apply and must not be weakened. The worker is private to
the container and is never exposed.

## Residual risk

- A local root user or an unrestricted agent shell can bypass the gateway and
  edit files directly; this deployment is not a sandbox against that actor.
- Client instruction delivery is outside the server's control; the gateway
  cannot force an unseen client to inject initialization guidance.
- A cloud-hosted working agent sees the notes it retrieves. Local retrieval and
  local inference avoid a hosted model API, but returned notes still enter that
  agent's context.
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
- `tests/contract/backend.test.ts` — historical sanitized backend fixtures and
  malformed-response classification retained for reproducible import tests.
- `tests/e2e/single-container.test.ts` — a real Docker single container:
  resolved-Compose assertions (one service, loopback publish, resident state
  volume, no backend/embedding dependency), model-disabled lexical fallback,
  capture, and recall.
- `tests/e2e/offline-local-brain.test.ts` — no-model-fetch startup, the worker's
  offline environment, and offline artifact verification.
- `tests/e2e/recovery.test.ts` — recovery blocking, backup-manifest integrity,
  and operator-script guards.
- `tests/legacy/two-service/` — retired two-service/role suites retained as
  historical reference and excluded from the test run by `vitest.config.ts`.
