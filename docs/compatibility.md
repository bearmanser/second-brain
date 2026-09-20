# Compatibility baseline

Task 1 executable compatibility baseline for the second-brain gateway. Every version,
digest, tool name, and wire shape below was observed on the execution host on 2026-09-20.
Nothing here is inferred from documentation. Where a value could not be observed it is
marked as such.

## Observed toolchain

| Component | Version |
|---|---|
| Node.js (host, `process.version`) | v24.21.0 |
| Node.js (pinned image `node:24-alpine`) | v24.21.0 |
| npm | 11.19.0 |
| TypeScript | 7.0.2 |
| Vitest | 5.0.1 |
| tsx | 4.23.15 |
| `@modelcontextprotocol/sdk` | 1.30.0 (v1 client import paths) |
| Zod | 4.6.5 |
| Express | 5.2.1 |
| YAML | 2.9.1 |
| better-sqlite3 | 13.0.3 |
| js-tiktoken | 1.0.21 |
| mdast-util-from-markdown | 2.0.3 |
| `@types/node` | 24.13.6 |
| `@types/express` | 5.0.6 |
| `@types/better-sqlite3` | 9.6.0 |

`package.json` records these as exact versions (`npm install --save-exact`).
`config/dependency-lock.json` repeats the resolved versions, the exact Node patch,
the npm version, and the engine range `>=24 <25`.

## Pinned container images

Recorded by `scripts/lock-images.mjs`, which inspects already-pulled images with
`execFileSync('docker', ['image', 'inspect', ...])` (argument array, no shell string) and
writes the `RepoDigest` values to both `config/images.env` and `config/dependency-lock.json`.

| Image | Reference in lock |
|---|---|
| Node base | `node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1` |
| Basic Memory | `ghcr.io/basicmachines-co/basic-memory@sha256:939f1173d96626c280763e14622f2381d49fbbb7db17cae2e832f4f639405643` |

The floating discovery inputs `node:24-alpine` and
`ghcr.io/basicmachines-co/basic-memory:latest` are accepted only as arguments to
`scripts/lock-images.mjs`. They are not written to `config/images.env` or the JSON lock.

### Basic Memory backend identity

| Field | Value |
|---|---|
| OCI image version label | 0.23.2 |
| OCI image revision label | c0bd87c6d5a4a58034b1d6c8c5018e443b0bd048 |
| MCP `serverInfo.version` | 4.0.0b1 |
| MCP framework | FastMCP 4.0.0b1 |
| Negotiated protocol version | 2025-11-25 |
| Transport / path / port | `streamable-http` / `/mcp` / `8000` |

The image tag version (0.23.2) and the MCP server version (4.0.0b1) differ. Both are
recorded; a documentation version is not treated as a tested image version.

## Disposable probe environment

The user's real vault was never mounted. Each probe run used a fresh throwaway directory
with an empty home volume, an empty vault for project `probe`, and an empty vault for
project `probe-b`:

```text
BASE=/tmp/opencode/bm-probe-<n>
$BASE/home        -> /home/appuser                              (config + SQLite + model cache)
$BASE/vault-a     -> /app/data/probe                            (project "probe")
$BASE/vault-b     -> /app/data/probe-b                          (project "probe-b")

basic-memory project add probe   /app/data/probe
basic-memory project add probe-b /app/data/probe-b

docker run -d --name bm-probe-<n> \
  -e BASIC_MEMORY_HOME=/home/appuser/.basic-memory \
  -v $BASE/home:/home/appuser \
  -v $BASE/vault-a:/app/data/probe \
  -v $BASE/vault-b:/app/data/probe-b \
  -p 127.0.0.1:<port>:8000 \
  --entrypoint basic-memory \
  ghcr.io/basicmachines-co/basic-memory:latest \
  mcp --transport streamable-http --host 0.0.0.0 --port 8000

BACKEND_MCP_URL=http://127.0.0.1:<port>/mcp \
PROBE_OUTPUT_DIR=$BASE/raw \
npx tsx scripts/probe-compatibility.mts
```

The probe connects with the SDK v1 `Client` + `StreamableHTTPClientTransport`, calls
`connect()`, walks `listTools()` pagination (a single page of 21 tools; no cursor was
returned), then asserts backend capabilities. It was run twice against two independent
fresh disposable data sets; both runs passed with the same shapes.

## Probe results

| Probe | Required observation | Observed |
|---|---|---|
| Initialization | Valid handshake and tool discovery before any memory call | Pass. Protocol `2025-11-25`, 21 tools discovered before the first `write_note`. |
| Create-only write | New note appears on disk; repeat with overwrite disabled cannot replace it | Pass. First write returned `action: "created"`, file `Notes/probe/Probe Revision 1.md` appeared in the `probe` vault. Repeat with `overwrite: false` returned `action: "conflict"`, `error: "NOTE_ALREADY_EXISTS"`, `file_path: null`; the file was unchanged. |
| Custom fields | `type`, tags, unique permalink, namespaced metadata survive read/write | Pass. `note_type: "decision"` stored as `type: decision`; tags `["alpha","beta"]`; project-scoped permalink; nested metadata (`nested.level`, `nested.flag`) and `brain_*` keys round-tripped through `read_note`. |
| Search | Keyword, hybrid, note-kind filters, metadata filtering | Pass. `search_type: "text"`, `"hybrid"`, `note_types: ["note"]`, `metadata_filters: {"brain_status":"candidate"}`, and `tags: ["alpha"]` each returned the expected note. |
| Project mapping | Two projects → different folders; explicit project call stays in-project | Pass. `probe` → `/app/data/probe` (vault-a), `probe-b` → `/app/data/probe-b` (vault-b); writes landed only in the requested project's vault. |
| Materialization | Record whether the write response precedes file materialization and index readiness | Response precedes file materialization. Write returned in ~74 ms with `action: "created"` and `file_path`, but the file was **not** present on disk at response time; it materialized ~100 ms later. The note was already returned by a text search at response time (index readiness at/just after the response). |
| Manual edit | Changed file discoverable after indexing without restarting Obsidian | Pass. A manually created file became discoverable ~500 ms after write; a content edit became discoverable ~250 ms later; `read_note` returned the edited content. No restart. |
| Model assets | Determine and persist the actual embedding cache path; repeat offline | Pass. Cache path `/home/appuser/.basic-memory/fastembed_cache` (persisted in the mounted home volume, ~65 MB, `models--qdrant--bge-small-en-v1.5-onnx-q`). Hybrid and vector search succeeded in a `--network none` container using the cached model. |

No probe failed, so the plan's stop rule for a failed capability was not triggered.

## Observed backend tool surface

`tools/list` returned 21 tools (order as observed):

```text
basic_memory_diagnostics, delete_note, read_content, build_context, recent_activity,
search_notes, read_note, view_note, write_note, list_directory, edit_note, move_note,
list_workspaces, list_memory_projects, create_memory_project, delete_project, search,
fetch, schema_validate, schema_infer, schema_diff
```

The capability assertion requires `write_note`, `search_notes`, `read_note`, and
`list_memory_projects`; all four are present. The sanitized `inputSchema` for every tool
is committed in `tests/fixtures/backend/tools-list.json`.

## Wire shapes

Sanitized captures committed under `tests/fixtures/backend/`:

| File | Shape |
|---|---|
| `initialize.json` | `{ protocolVersion, capabilities, serverInfo, instructions }` |
| `tools-list.json` | `{ observedToolCount, tools: [{ name, title, inputSchema, annotations? }] }` |
| `write-note.json` | `{ content: [{ type: "text", text }], structuredContent: { result }, isError }` |
| `write-note-duplicate.json` | Same envelope, `result.action: "conflict"`, `error: "NOTE_ALREADY_EXISTS"` |
| `search-notes.json` | Same envelope, `result` = `{ results, current_page, page_size, total, total_is_exact, has_more }` |
| `read-note.json` | Same envelope, `result` = `{ title, permalink, file_path, content, frontmatter }` |
| `list-memory-projects.json` | Same envelope, `result` = `{ projects, default_project, constrained_project }` |

FastMCP wraps every tool result with `_meta.fastmcp.wrap_result: true`, a `content`
text block containing the JSON string, and a parallel `structuredContent.result`.

Representative create-only conflict result (sanitized):

```json
{
  "structuredContent": {
    "result": {
      "title": "Probe Revision 1",
      "permalink": "notes/probe/probe-revision-1",
      "file_path": null,
      "checksum": null,
      "action": "conflict",
      "error": "NOTE_ALREADY_EXISTS"
    }
  },
  "isError": false
}
```

### Sanitization applied to fixtures

- Tool and schema `description` strings were removed to keep the fixture small; the
  uncommitted full capture measured ~72 KB. Structure, types, defaults, enums, and
  `required` fields are preserved.
- Generated UUIDs (`external_id`) were replaced with deterministic placeholder UUIDs.
- The container home path in `list-memory-projects.json` was replaced with a neutral
  `/data/...` path.
- No tokens, API keys, credentials, `/tmp/opencode` paths, or user vault paths are present;
  the contract test asserts this.

## Toolchain notes for later tasks

- TypeScript resolved to 7.0.2. It no longer auto-includes `@types/*` packages, so
  `tsconfig.json` declares `"types": ["node"]`. Without it `npm run typecheck` fails with
  `TS2591`.
- `npm run build` (`tsc -p tsconfig.build.json`) targets `src/**/*.ts`, which Task 2
  introduces. With no `src` sources yet it reports `TS18003: No inputs were found`; this is
  the expected greenfield state for Task 1.
- The embedding model is fetched on first semantic use into the `BASIC_MEMORY_HOME`
  volume. Runtime deployment must mount a persistent path for
  `$BASIC_MEMORY_HOME/fastembed_cache` to keep offline search working after a cold start.

## Reproduce

```bash
npm ci
npm test
npm run typecheck
node scripts/lock-images.mjs
BACKEND_MCP_URL=http://127.0.0.1:8000/mcp npx tsx scripts/probe-compatibility.mts
```
