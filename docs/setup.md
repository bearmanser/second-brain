# Setup and user runbook

This is the operator runbook for the second-brain gateway. It covers a clean
checkout through day-two operations. The design reference is
`docs/superpowers/specs/2026-09-20-second-brain-design.md`, and the requirement
coverage record is `docs/requirement-coverage.md`.

## Prerequisites

- **Docker Engine with Compose v2** (`docker version`, `docker compose version`).
  The pinned Node 24 and Python 3.12 images are pulled as digests from
  `config/images.env`; there is no floating `latest`.
- **Bash** for `scripts/setup.sh`, `scripts/prepare-models.sh`,
  `scripts/backup.sh`, `scripts/restore.sh`, and `scripts/rebuild.sh`.
- **A host directory for the vault.** The default is a gitignored `./vault`. The
  vault is mounted **read-write** into the single application container; all
  writes go through the gateway's validated, journaled operations.
- **Node.js is not required on the agent host.** It is only needed to develop or
  run the test suites; the container carries its own runtime.
- **Obsidian is optional** and is not required for the gateway to run.
- On Linux, the runtime runs as UID/GID 1000 by default. Override both together
  with `BRAIN_UID`/`BRAIN_GID` if your vault owner differs.

Do not put the vault, the operational SQLite databases, or the model snapshot on
a network share, Obsidian Sync, or a Windows/WSL shared folder. Keep them on a
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
2. builds the single application image `second-brain:local` from the pinned Node
   and Python base images;
3. generates `config/brain.yaml`, `secrets/brain-token`, and `secrets/cursor-key`
   (only if absent);
4. creates the `brain-state` named volume and validates that an existing volume
   is writable by the runtime UID without ever changing ownership of an existing
   volume.

There is **one configured bearer token** for the whole brain. It grants access to
every tool and every project. Generate it during setup or rotate it later:

```sh
node dist/cli.js auth generate --show-token
```

Set the digest as `BRAIN_TOKEN_SHA256` in the operator `.env` file. There is no
committed example default. Keep `secrets/` out of version control.

For compatibility with a deployment that already uses a statically named
project, set `BRAIN_SCOPE` explicitly (for example
`BRAIN_SCOPE=freellmapi bash scripts/setup.sh`). That project is seeded alongside
`shared` and `profile`; repository projects are created on demand.

## Open the vault in Obsidian

1. Point Obsidian's "Open folder as vault" at the host `VAULT_PATH`
   (`./vault` by default), **not** into the container.
2. Human-readable paths appear under project roots:
   - `Projects/<display name>/` — repository projects created on demand.
   - `Shared/`, `Profile/`, and `Knowledge/` — non-project organization.
3. Within a project, notes route by type folder: `Lessons/`, `Decisions/`,
   `Playbooks/`, `Facts/`, `Preferences/`, `Sessions/`, `Notes/`.
4. Current content is a single readable Markdown document per managed note with a
   stable `id` property. The gateway writes it; edit it freely, but see the
   manual-edit behavior below. Historical snapshots live in durable state outside
   the vault.

## Start the application

```sh
docker compose up -d
docker compose exec brain node dist/cli.js health   # prints "healthy" and exits 0
```

Only the gateway port is published, and only on loopback:

```sh
docker compose port brain 7331   # 127.0.0.1:<port>
```

The container has a healthcheck and restarts unless stopped. Recreate after a
configuration change with `docker compose up -d --build`.

## Register the MCP connection

The gateway speaks **Streamable HTTP at `http://127.0.0.1:7331/mcp`**,
authenticated on every request with the bearer token. There is no second
endpoint. Optional private ingress (for example Tailscale) is an operator
overlay: publish the port only on the private interface and never relax the
token, host, or origin checks.

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
- Rotating a token means replacing `BRAIN_TOKEN_SHA256` in the env file and
  restarting the container. Sending `SIGHUP` cannot reload an environment value
  already injected by Compose. The old token stops authenticating on the next
  request.

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

The returned `project`/`scope` is used for subsequent recall, capture, and review
calls. If there is no `origin`, the client must ask the user for a remote or
explicit repository identity; it must not invent one from the directory name.
Scope-name collisions are resolved deterministically with a short
identity-derived suffix. Repeated calls are idempotent and reuse the same project.

The single bearer token grants access to every ready project. A project narrows
search results; it never narrows access rights. A failed ambiguous provision is
reported as `recovery_required` and requires explicit recovery; it is never
silently treated as ready.

## The seven tools

| Tool | Use it to |
|---|---|
| `brain_project_ensure` | Create or reuse the project for `{ idempotency_key, remote_url }`. |
| `brain_recall` | Find prior knowledge: `{ scope?, project?, query, topics?, phase?, kinds?, include_candidates?, session_id?, mode?, allow_text_fallback?, budget_tokens?, limit? }`. |
| `brain_read` | Read a current or historical revision, or the next page: `{ id|path|title, cursor?, budget_tokens? }`. |
| `brain_capture` | Submit a candidate: `{ idempotency_key, scope, note }`. |
| `brain_review` | List candidates/conflicts, or `approve`, `revise`, `supersede`, `archive`, `resolve`. |
| `brain_feedback` | Record `useful`, `irrelevant`, `stale`, `incorrect`, or `contradiction` on a revision. |
| `brain_status` | Read projects, versions, local gateway/index/model health, pending work, and one operation's state. |

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
Markdown sections are preserved; reserved identity and schema fields cannot be
supplied by the agent.

## Candidate review

A capture is a **candidate**, not a verified fact.

- List candidates: `brain_review` with
  `{ scope, operation: { action: "list", filter: "candidate" } }`.
- Promote one: `approve` with the exact `id` and `expected_etag`, a rationale,
  and the kind's minimum non-hypothesis evidence for factual kinds.
- Revise, supersede, archive, or resolve a fork through the same tool.

Review is a recorded decision, not independent factual verification. A valid
token may review; there are no separate roles.

## Manual edits and conflicts

If you edit a materialized document in Obsidian, the gateway detects the changed
content hash and reports the head as `manual_unreviewed` with a warning; a stale
`expected_etag` mutation is rejected with `CONFLICT`. Conflicts are never
auto-merged and an occupied target path is never silently overwritten.

## Local retrieval and the model

Default mode is lexical **text** search over a rebuildable SQLite FTS5 index. It
never depends on the model. Optional Laya reranking is enabled only after the
evaluated release gate:

```sh
bash scripts/prepare-models.sh
# then set in the operator env file:
#   BRAIN_LAYA_ENABLED=true
#   BRAIN_SEARCH_MODE=reranked
docker compose up -d
```

`prepare-models.sh` fetches the immutable snapshot named by
`config/laya-model.lock.json` into
`/var/lib/second-brain/models/laya/runtime` and verifies it with networking
disabled. Normal startup never fetches models; the worker child runs with
`HF_HUB_OFFLINE=1` and telemetry disabled. If reranking is unavailable the
gateway falls back to the exact lexical ordering and marks the result, unless the
caller explicitly disables fallback. An uncalibrated `p(A) + 0.5 * p(B)` ordering
signal is never treated as a measured probability of correctness.

## Logs, status, and permissions

```sh
docker compose logs -f brain        # application and worker diagnostics
docker compose exec brain node dist/cli.js health
docker compose exec brain node dist/cli.js recover        # inspect/recover pending ops
docker compose exec brain node dist/cli.js rebuild-index  # rebuild the disposable index
docker compose exec brain node dist/cli.js verify-backup --root /backup --manifest /backup/manifest.json
docker compose ps
```

- Normal logs carry opaque IDs, sizes, durations, outcomes, and error codes —
  not note bodies, queries, or credentials. A stored-but-not-indexed mutation is
  reported as a successful durable operation with explicit `materialized` and
  `indexed` flags.
- `brain_status` reports `health.gateway` (`ready`/`recovering`/`degraded`) and a
  `local` block with `index` and `worker` states. A disabled model is not a
  gateway failure. A pending operation keeps reads available and refuses new
  mutations with `RECOVERY_REQUIRED` until reconciled.
- File permissions: the runtime writes to the vault mount through validated
  operations and runs as UID/GID 1000; `secrets/` is `0700` with `0600` files.
  `setup.sh` never changes ownership of an existing volume.

## Backup and restore

See `docs/operations.md` for the full procedure. The short version:

```sh
# Pause Obsidian edits and external sync first.
scripts/backup.sh /srv/backups/second-brain-<date>
scripts/restore.sh /srv/backups/second-brain-<date> /srv/restore/test --check
scripts/restore.sh /srv/backups/second-brain-<date> /srv/restore/test --acknowledge
```

A cold backup stops the application container, archives the vault and the
`brain-state` volume (with a manifest and checksums), and restarts it from an
`EXIT` trap. The operation journal, revision history, feedback, and repository
mappings live in `brain-state` and must be backed up: an index rebuild cannot
reconstruct them. The search index and model snapshot are reproducible derived
data and may be reacquired separately.

## Index rebuild (not a restore)

```sh
BRAIN_REBUILD_ACKNOWLEDGE=yes scripts/rebuild.sh
```

This pauses mutations, rebuilds the local search index from current Markdown
(and the catalogue when the durable journal was explicitly declared lost), and
restarts the application. It restores **derived** search and catalogue state
only. A missing `journal.db` fails the rebuild and tells you to restore it; only
an explicit `--accept-operational-loss` proceeds and labels the result as a lossy
fresh journal.

## Safe upgrades

1. **Back up first.** Run a cold backup and verify it
   (`restore.sh --check`) before changing images or configuration.
2. **Either pin up or rebuild against pinned digests.** Replace
   `NODE_IMAGE`/`PYTHON_IMAGE` only with a digest-pinned reference, then run
   `docker compose up -d --build`.
3. **Re-run setup idempotently** if the image changed: `bash scripts/setup.sh`.
   It preserves existing tokens and volume ownership.
4. **Inspect the resolved configuration** before starting the migrated
   deployment: `docker compose config` must show the existing `brain-state`
   volume, the vault mount, and the loopback endpoint.
5. **Watch startup recovery.** On start the gateway reconciles pending
   operations before accepting mutations. If `brain_status` reports
   `recovering`, inspect with `node dist/cli.js recover`.
6. **Roll back by digest** to the previous pinned images and `config/brain.yaml`.
   The vault is authoritative; derived state rebuilds.

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
- **Reranking is not enabled by default.** A failed evaluation gate leaves the
  deployment on lexical text mode; that is reported honestly, never as a semantic
  improvement.
- **Historical third-party notice.** Basic Memory is no longer installed,
  started, or contacted; its AGPL-3.0-or-later notice is retained in `README.md`
  because earlier releases shipped it.
