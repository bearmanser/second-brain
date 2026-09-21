# Setup and user runbook

This is the operator runbook for the second-brain gateway. It covers a clean
checkout through day-two operations. The design reference is
`docs/superpowers/specs/2026-09-20-second-brain-design.md`, and the requirement
coverage record is `docs/requirement-coverage.md`.

## Prerequisites

- **Docker Engine with Compose v2** (`docker version`, `docker compose version`).
  The pinned Node 24 and Basic Memory images are pulled as digests from
  `config/images.env`; there is no floating `latest`.
- **Bash** for `scripts/setup.sh`, `scripts/backup.sh`, `scripts/restore.sh`, and
  `scripts/rebuild.sh`.
- **A host directory for the vault.** The default is a gitignored `./vault`. The
  vault is mounted read/write into Basic Memory and read-only into the gateway.
- **Node.js is not required on the agent host.** It is only needed to develop or
  run the test suites; the containers carry their own runtime.
- **Obsidian is optional** and is not required for the gateway to run.
- On Linux, the runtime runs as UID/GID 1000 by default. Override both together
  with `BRAIN_UID`/`BRAIN_GID` if your vault owner differs.

Do not put the vault, the operational SQLite databases, or the model cache on a
network share, Obsidian Sync, or a Windows/WSL shared folder. Keep them on a
local Linux filesystem.

## One-time setup

```sh
git clone <this repository> second-brain
cd second-brain
bash scripts/setup.sh
```

`scripts/setup.sh` is idempotent. It:

1. parses `config/images.env`, requiring digest-pinned references and rejecting
   floating tags or shell syntax;
2. builds the gateway image `second-brain:local` from the pinned Node base;
3. generates `config/brain.yaml`, `secrets/credentials.json`,
   `secrets/brain-token`, and `secrets/cursor-key` (only if absent);
4. creates the `brain-state`, `memory-state`, and `model-cache` named volumes
   and validates that an existing volume is writable by the runtime UID without
   ever changing ownership of an existing volume;
5. seeds only the reserved Basic Memory project mappings (`shared`, `profile`)
   exactly once. Repository projects are created on demand.

For compatibility with a deployment that already uses a statically named
project, set `BRAIN_SCOPE` explicitly (for example
`BRAIN_SCOPE=freellmapi bash scripts/setup.sh`). That scope is seeded alongside
`shared` and `profile`; it is no longer the fresh-install default.

By default `setup.sh` writes a **reviewer** credential. Request an owner
credential explicitly by setting `BRAIN_OWNER_CREDENTIAL=1` before running it:

```sh
BRAIN_OWNER_CREDENTIAL=1 bash scripts/setup.sh
# owner token is written to secrets/owner-token
```

Keep `secrets/` out of version control (the repository `.gitignore` already
excludes it).

## Open the vault in Obsidian

1. Point Obsidian's "Open folder as vault" at the host `VAULT_PATH`
   (`./vault` by default), **not** into the containers.
2. Notes appear under scope roots:
   - `Shared/` — generalized lessons and playbooks (`shared`).
   - `Profile/` — owner-approved preferences and environment facts (`profile`).
   - `Projects/<scope>/` — repository projects created on demand.
3. Within a scope, notes route by kind: `Lessons/`, `Decisions/`, `Playbooks/`,
   `Facts/`, `Preferences/`, `Sessions/`, `Notes/`.
4. Each logical note has a stable UUID directory and each revision is its own
   Markdown file. Basic Memory writes the files; edit them freely, but see the
   manual-edit behavior below.

## Start the services

```sh
docker compose up -d
docker compose exec brain node dist/cli.js health   # prints "healthy" and exits 0
```

Only the gateway port is published, and only on loopback:

```sh
docker compose port brain 7331   # 127.0.0.1:<port>
docker compose port memory 8000  # nothing
```

The gateway has a healthcheck and restarts unless stopped. Recreate after a
configuration change with `docker compose up -d --build`.

## Register the MCP connection

The gateway speaks **Streamable HTTP at `http://127.0.0.1:7331/mcp`**,
authenticated on every request with a bearer token. There is no second endpoint.

For OpenCode v2, merge the `mcp.servers` block from
`config/opencode.example.jsonc` into your project or global `opencode.jsonc`:

```jsonc
{
  "mcp": {
    "servers": {
      "second-brain": {
        "type": "remote",
        "url": "http://127.0.0.1:7331/mcp",
        "oauth": false,
        "headers": { "Authorization": "Bearer {env:SECOND_BRAIN_TOKEN}" },
        "codemode": false
      }
    }
  }
}
```

Notes verified against the installed client (`opencode v2.0.10`):

- V2 stores servers under `mcp.servers.<name>`; it does not accept a server name
  directly under `mcp`.
- `oauth: false` disables the client's OAuth flow for a preconfigured bearer token.
- `codemode: false` exposes the seven tools on the model's native tool list.
- In the Task 19 probe the model with the default `structured` delivery received
  only the compact pointer, so the verified `result_delivery` mode for this
  client is **`text-json`** (`config/brain.example.yaml`). Confirm which
  representation your client actually injects before changing it.
- `opencode mcp list` may report no servers for a disposable project even when
  the merged config and the run show the server; trust the merged config and the
  run.
- Use `--standalone` (or a project `PWD`) so a run does not attach to a shared
  background service and mask the project configuration.

Other MCP hosts: register a remote Streamable-HTTP server with an
`Authorization: Bearer <token>` header. Hosts that ignore `structuredContent`
should be configured with `result_delivery: text-json`; hosts that require no
authentication are not supported.

### Loading the token in WSL

The token lives in `secrets/brain-token` on the host. Export it in the shell
that starts the client so the `{env:...}` reference resolves:

```sh
export SECOND_BRAIN_TOKEN="$(tr -d '\n' < secrets/brain-token)"
```

- In WSL, keep the repository and vault on the Linux filesystem
  (`/home/...`, not `/mnt/c/...`) so Docker bind mounts and SQLite files stay on a
  local filesystem.
- `docker compose` reads `secrets/` relative to the Compose project directory.
- For a systemd-managed service, provide the token through an environment file
  with `0600` permissions, not on the Docker command line.
- Rotating a token means adding a new credential record and reloading the
  gateway (the gateway watches the credentials file and also reloads on
  `SIGHUP`); remove the old record afterwards.

## Automatic repository projects

In each Git checkout, the agent should first obtain the configured origin
without sending repository contents:

```sh
git remote get-url origin
```

It then calls `brain_project_ensure` with a new UUID `idempotency_key` and that
`remote_url`. Equivalent HTTPS and SSH remotes resolve to the same canonical
identity (for example `https://github.com/acme/widget.git` and
`git@github.com:acme/widget.git` both identify `github.com/acme/widget`). The
gateway strips the optional `.git`, lowercases the host, rejects credentials,
query strings, fragments, local paths, and malformed remotes, and never logs the
raw URL.

The returned `scope` is used for subsequent recall, capture, and review calls.
If there is no `origin`, the client must ask the user for a remote or explicit
repository identity; it must not invent one from the directory name. Scope-name
collisions are resolved deterministically with a short identity-derived suffix.
Repeated calls are idempotent and reuse the same project.

Access follows the authenticated role: a worker receives read/write, a reviewer
receives read/write/review, and an owner has full access to every ready dynamic
project. One principal ensuring a project does not grant unrelated principals
access. Provisioning is bounded by per-principal and global minute limits and a
configured total-project cap. A failed ambiguous provision is reported as
`recovery_required` to its creator and owners and requires explicit owner
recovery; it is never silently treated as ready.

The server publishes this workflow in MCP initialization instructions, but a
client may ignore those instructions. Configure equivalent repository-startup
guidance in that client's own instruction file when necessary.

## The seven tools

| Tool | Use it to |
|---|---|
| `brain_project_ensure` | Create or reuse the project for `{ idempotency_key, remote_url }` and receive its role-matched permissions. |
| `brain_recall` | Find prior knowledge: `{ scope, query, topics?, phase?, kinds?, include_shared?, include_candidates?, session_id?, mode?, allow_text_fallback?, budget_tokens?, limit? }`. |
| `brain_read` | Read a current or historical revision, or the next page: `{ scope, id, revision_id?, cursor?, budget_tokens? }`. |
| `brain_capture` | Submit a candidate: `{ idempotency_key, scope, note }`. |
| `brain_review` | List candidates/conflicts, or `approve`, `revise`, `supersede`, `archive`, `resolve`. |
| `brain_feedback` | Record `useful`, `irrelevant`, `stale`, `incorrect`, or `contradiction` on a revision. |
| `brain_status` | Read authorized scopes, versions, backend health, pending work, and one operation's state. |

Every mutation requires a client-supplied UUID `idempotency_key`. Reusing a key
with a different payload or scope is an error, never an implicit update.

## Typed notes

`brain_capture` takes a `note` with `title`, `tags`, `content`, `evidence`, and
`related_ids`. The `content.kind` selects the required sections:

| Kind | Required | Optional |
|---|---|---|
| `lesson` | situation, lesson, applicability | limitations |
| `decision` | context, decision, rationale | alternatives, consequences, reconsider_when |
| `playbook` | use_when, prerequisites, nonempty steps, verification | cautions |
| `fact` | claim, applicability | valid_until |
| `preference` | preference, applicability, source_statement_ref | exceptions |
| `session` | task, state, next_actions, session_id | blockers, branch, repository_ref |
| `note` | summary, body_markdown | — |

Evidence carries `kind` (`user_statement`, `repository`, `test_run`,
`observation`, `reference`, `hypothesis`), an opaque `ref`, a short
`description`, and an optional `observed_at`. Additional frontmatter and unknown
Markdown sections are preserved; reserved identity, scope, and schema fields
cannot be supplied by the agent.

## Candidate review

A capture is a **candidate**, not a verified fact.

- List candidates: `brain_review` with
  `{ scope, operation: { action: "list", filter: "candidate" } }`.
- Promote one: `approve` with the exact `id` and `expected_etag`, a rationale,
  and the kind's minimum non-hypothesis evidence for factual kinds.
- Revise, supersede, archive, or resolve a fork through the same tool.

A worker identity can capture but cannot approve. Reviewers can approve ordinary
project lessons. Protected preferences, profile/shared promotions, and approved
architecture decisions require owner review. Review is a recorded decision, not
independent factual verification.

## Immutable revision tradeoffs

Agent operations never overwrite or delete an existing revision file; capture,
promotion, revision, supersession, and archival all create new files under the
logical note's UUID directory. Consequences:

- **Visible history.** Obsidian shows every retained revision, not one mutable
  `current.md`. There is no second canonical copy.
- **Conflict is explicit.** Multiple heads, missing parents, duplicate revision
  IDs, or cycles produce a reviewable conflict instead of a silent merge.
- **Manual edits are never lost.** If you edit a materialized revision in
  Obsidian, the gateway detects the changed approval fingerprint and reports the
  head as `manual_unreviewed` with a warning; a stale `expected_etag` mutation is
  rejected with `CONFLICT`.
- **Fork repair is deliberate.** Missing parents and damaged history stay
  quarantined and require owner recovery (prefer restoring retained bytes from a
  backup). New reviewed content can be captured while damaged history is
  quarantined.

## Owner versus worker credentials

Credentials are static bearer tokens in `secrets/credentials.json`; each record
maps a token digest to a principal with a role and reserved static scopes.
Repository-project grants are persisted in `journal.db` when
`brain_project_ensure` succeeds. They are derived from the authenticated role,
never from a role or scope supplied in tool arguments.

- **Worker:** capture into its project scope; read its project plus permitted
  shared scope; cannot review.
- **Reviewer:** worker capabilities plus review of ordinary project notes.
- **Owner:** all scopes plus protected review and owner-only operational
  commands (`recover-state`, backup/restore/rebuild helpers).

A token cannot read or write an unrelated repository project. There is no
`search_all_projects` pass-through.

## Logs, status, and permissions

```sh
docker compose logs -f brain        # gateway logs
docker compose logs -f memory       # backend logs
docker compose exec brain node dist/cli.js health
docker compose exec brain node dist/cli.js recover        # inspect/recover pending ops
docker compose exec brain node dist/cli.js verify-backup --root /backup --manifest /backup/manifest.json
docker compose ps
```

- Normal logs carry opaque IDs, sizes, durations, outcomes, and error codes —
  not note bodies, queries, or credentials. A stored-but-not-indexed mutation is
  reported as a successful durable operation with explicit `materialized` and
  `indexed` flags.
- `brain_status` reports `health.gateway` (`ready`/`recovering`/`degraded`),
  `health.backend`, `health.embeddings`, and `pending_operations`. A pending
  operation keeps reads available and refuses new mutations with
  `RECOVERY_REQUIRED` until reconciled.
- File permissions: the gateway vault mount is read-only; both services run as
  UID/GID 1000; `secrets/` is `0700` with `0600` files. `setup.sh` never changes
  ownership of an existing volume.

## Offline cache

The first semantic (hybrid) search downloads the local FastEmbed model
(`bge-small-en-v1.5-onnx-q`) into the `model-cache` volume at
`/home/appuser/.basic-memory/fastembed_cache`. After it is warm:

- hybrid search keeps working with no external network;
- a restart or cold start reuses the cached model;
- only text search is available before warm-up if embeddings are unavailable
  (and only when the caller allows text fallback, in which case the result is
  marked degraded).

The model cache is disposable derived data; it does not contain your notes.

## Backup and restore

See `docs/operations.md` for the full procedure. The short version:

```sh
# Pause Obsidian edits and external sync first.
scripts/backup.sh /srv/backups/second-brain-<date>
scripts/restore.sh /srv/backups/second-brain-<date> /srv/restore/test --check
scripts/restore.sh /srv/backups/second-brain-<date> /srv/restore/test --acknowledge
```

A cold backup stops both services, archives the vault and every named volume
(with a manifest and checksums), and restarts them from an `EXIT` trap. The
operation journal, feedback, repository mappings, and dynamic grants live in
`brain-state` (`journal.db`) and must be backed up: an index rebuild cannot
reconstruct them.

## Index rebuild (not a restore)

```sh
BRAIN_REBUILD_ACKNOWLEDGE=yes scripts/rebuild.sh
```

This pauses mutations, runs the supported `basic-memory reindex`, rebuilds the
gateway catalogue from Markdown, verifies the graph and the byte-for-byte
preservation of the operation/feedback rows, and restarts the gateway. It
restores **derived** search and catalogue state only. It never revives an
archived or superseded head. A missing `journal.db` fails the rebuild and tells
you to restore it; only an explicit `--accept-operational-loss` proceeds and
labels the result as a lossy fresh journal.

## Safe upgrades

1. **Back up first.** Run a cold backup and verify it
   (`restore.sh --check`) before changing images or configuration.
2. **Either pin up or rebuild against pinned digests.** Replace
   `NODE_IMAGE`/`BASIC_MEMORY_IMAGE` only with a digest-pinned reference, then
   run `docker compose up -d --build`.
3. **Re-run setup idempotently** if the image changed: `bash scripts/setup.sh`.
   It preserves existing tokens, credentials, and volume ownership.
4. **Watch startup recovery.** On start the gateway reconciles pending
   operations before accepting mutations. If `brain_status` reports
   `recovering`, inspect with `node dist/cli.js recover`; ambiguous operations
   block new writes on purpose.
5. **Recreate the catalogue if the schema changed:** `rebuild-catalogue`
   requires `journal.db` and validates the graph; run it only through
   `scripts/rebuild.sh`.
6. **Roll back by digest** to the previous pinned images and `config/brain.yaml`.
   The vault is authoritative; derived state rebuilds.
7. Never publish an image or run a release workflow automatically — there is no
   registry or release repository selected.

## Limitations

- **Client-controlled instruction delivery.** The gateway publishes memory-use
  guidance in MCP initialization (`instructions`), but MCP hosts decide whether
  to inject it. Verify delivery per client; the server cannot enforce unseen
  client behavior.
- **No guaranteed compaction capture.** The gateway cannot observe an agent's
  context compaction and does not ingest transcripts. Knowledge is captured only
  when the agent chooses to call `brain_capture`.
- **Not a sandbox.** A local root user or unrestricted agent shell can bypass
  the gateway and edit files directly.
- **No plugin/REST/curator model.** There is no custom OpenCode plugin, REST
  application API, server-side chat model, or background curator.
- **Best-effort redaction.** Credential detection rejects obvious private keys
  and recognizable credential patterns, but cannot guarantee any note is free of
  sensitive data.
- **Reference tokens, not model tokens.** Budgets use one documented tokenizer
  (`cl100k_base`) and are not guaranteed to match every model family.
- **Third-party backend.** Basic Memory is a separate AGPL-3.0-or-later
  component; see the notice in `README.md`.
