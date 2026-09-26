# Second Brain clean core — design

Date: 2026-09-25
Status: approved in conversation, pending written-spec review
Branch: `feat/clean-core` (from `feat/local-brain-v2` @ `7af8836`)

## 1. Purpose

Replace the current codebase (~38k lines of `src`, ~46k lines of tests, five state stores, 11 migrations, two note models) with a small, focused gateway in which every module, field, and file has a live purpose. The operator's existing notes must port into it cleanly and stay findable.

Success means:

- `src` is about 3.7k lines. It has no Laya, no Basic Memory, no V1 revision layout, no review lifecycle, no revision history, no permalinks, no legacy request compatibility, and no migration machinery for old formats.
- The 35 live notes and 5 projects port, with every path-qualified wikilink rewritten, and they are searchable immediately.
- After cutover and decommission, nothing on the host or in the repository still depends on or describes the old system. Git history is the only exception.

## 2. Decisions

| Topic | Decision |
|---|---|
| What ports | **Current notes only.** Revision history, feedback, retrieval telemetry, approvals, and idempotency records are not carried over. The one exception is repository remotes, which are project data needed for `brain_project_ensure` (see §8). |
| Capabilities | Capture, read, FTS5 recall, **feedback**, and **auto-project from git remote**. The following are removed: review lifecycle, edit history, Obsidian assets, backup/restore commands, retrieval evaluation tooling. |
| Changing notes | **Create, update, and delete over MCP**, with a content-hash check on update and delete. |
| Note model | **Type label plus free Markdown.** There are no per-kind schemas or section parsing. |
| Projects | **Defined in the vault:** a folder plus a project note that lists repository remotes. |
| Approach | **Rebuild a clean core in this repo**, salvaging the FTS5 index, chunker, auth, MCP/HTTP wiring, and remote normalization. |
| Feedback | **Shown and affects ranking.** Negative feedback demotes a note until the note changes. |
| Configuration | **Environment variables only.** There is no `brain.yaml`. |
| Health | Unauthenticated `GET /health`. |
| Archived test note | Skipped by the porter and reported. |
| Importer | Deleted after cutover is accepted. |

Non-goals:
- semantic or reranked search, embeddings, graph expansion, or token-budget packing;
- multi-user permissions or roles;
- note history or conflict forks;
- Obsidian templates or Bases views;
- backup tooling (the runbook uses `tar`);
- keeping any old tool schema compatible.

## 3. Vault format

The vault is the source of truth for notes and projects. The gateway never stores note content anywhere else.

### 3.1 Layout

```
<vault>/
  Projects/<Project Name>/<Project Name>.md     project note
  Projects/<Project Name>/<Note filename>.md    notes (flat; no type subfolders)
  Notes/<Note filename>.md                      notes that belong to no project
  .obsidian/                                    Obsidian settings; never indexed or written
  .trash/                                       deleted notes; never indexed
```

Every other `*.md` file outside `.obsidian/` and `.trash/` is indexed as a note. The exception is project notes (§3.3), which are never indexed. A note's project is determined by where it sits:
- a file under `Projects/<Name>/` (at any depth) belongs to project `<Name>`;
- any other file belongs to no project.

### 3.2 Note file

```markdown
---
id: 8a431d1f-1cd5-4892-9386-50bbca8307d1
type: lesson
tags: [laya, performance]
created: 2026-09-24T07:36:00.360Z
updated: 2026-09-24T07:36:00.360Z
---

# Laya multilingual CPU inference cost exceeds the 4 s reranker budget for 30 candidates

…free Markdown…
```

The recognised frontmatter keys are `id`, `type`, `tags`, `created`, and `updated`. Any other key in a hand-written file is preserved byte-for-byte on MCP updates and otherwise ignored. The gateway itself only ever writes these five keys.

| Field | Rule |
|---|---|
| `id` | UUID v4. It is optional in hand-written files: such notes are indexed and readable by `path`, and the first MCP update adds an `id`. |
| `type` | One of `lesson`, `decision`, `playbook`, `fact`, `preference`, `session`, `note`. A missing or unknown value is treated as `note`. |
| `tags` | A list of strings. A missing value means empty. |
| `created`, `updated` | ISO-8601 UTC timestamps, set by the gateway on MCP writes. When a hand-written file lacks them, the file's mtime is reported and nothing is written back until the first MCP update, which sets `created` from the mtime. |
| title | The first line of the content, if it is a `# ` H1. If the file has no H1, the filename without `.md` is used, and the first MCP update inserts `# <title>`. |
| body | Everything after the title H1 and its following blank line. `brain_read` returns this body without the H1. |
| project | Derived from the folder. It is never stored in frontmatter. |

**Filename from title.** The characters `\ / : * ? " < > |` and control characters are replaced with a space. Runs of whitespace are then collapsed, the result is trimmed, trailing dots are stripped, and it is cut to 100 characters before `.md` is appended. If the name collides with another file in the same folder, ` (2)`, ` (3)`, … is appended; the H1 is not changed. When an MCP update changes the title, the file is renamed.

### 3.3 Project note

A project note lives at `Projects/<Name>/<Name>.md`:

```markdown
---
type: project
repositories:
  - github.com/bearmanser/second-brain
---
# Second Brain
```

- **Name and key.** The project name is the folder name. Its key is a slug of the name: lowercase, with each run of non-alphanumeric characters turned into `-` and leading or trailing `-` trimmed (for example `second-brain` or `freellm-api`). Tools accept either the name (case-insensitive) or the key.
- **Repositories.** `repositories` is a list of normalized remote identities (see §4). You can add more by editing the file.
- **Missing project notes.** A project folder without a project note is still a project, with no repositories. This is not reported as a problem. `brain_project_ensure` creates the note when it binds a remote to the folder.
- **Indexing.** Project notes are not indexed as notes, and recall never returns them.

## 4. MCP tools

The transport is Streamable HTTP at `POST /mcp`. Every tool returns structured content. A tool failure returns `{ code, message }`, where `code` is one of `INVALID_INPUT`, `NOT_FOUND`, `CONFLICT`, `LIMIT_EXCEEDED`, or `INTERNAL`. Failures at the HTTP layer are not tool results: a missing or invalid token is `401`, a rejected host or origin is `403`, an unsupported method is `405`, and an oversized body is `413`.

In the tables below, a note is addressed by `id` or `path` (vault-relative, `.md`); exactly one must be given. `hash` is the lowercase hex SHA-256 of the file's bytes.

| Tool | Input | Output |
|---|---|---|
| `brain_capture` | `title` (1–200), `body` (Markdown content *below* the title; a body whose first line is an H1 is rejected with `INVALID_INPUT`, because the gateway writes `# <title>` itself), `type?`, `tags?` (≤ 32), `project?` (name or key; must exist), `idempotency_key?` (8–128 chars) | `id`, `path`, `hash` |
| `brain_update` | `id` \| `path`, `expected_hash`, at least one of `title` / `body` / `type` / `tags` / `project` | `id`, `path`, `hash` |
| `brain_delete` | `id` \| `path`, `expected_hash` | `trashed_path` |
| `brain_read` | `id` \| `path` | `id`, `path`, `project`, `title`, `type`, `tags`, `created`, `updated`, `hash`, `body`, `feedback`, `demoted` |
| `brain_recall` | `query` (1–1000), `project?`, `types?`, `limit?` (1–20, default 5) | `items[]`: `id`, `path`, `project`, `title`, `type`, `tags`, `heading`, `excerpt`, `feedback`, `demoted` |
| `brain_feedback` | `id` \| `path`, `verdict` (`useful` \| `irrelevant` \| `stale` \| `incorrect` \| `contradiction`), `reason?` (≤ 1000) | `recorded: true` |
| `brain_project_ensure` | `remote_url`, `idempotency_key?` (8–128 chars; accepted for client compatibility and ignored, because binding an already-bound remote returns the existing project) | `project` (`name`, `key`, `repositories`, `notePath`, `hasNote`), `created` |
| `brain_status` | — | `version`, `notes`, `projects[]` (`name`, `key`, `repositories`, `notes`), `problems[]` (`path`, `problem`) |

Behaviour of each tool:

- **`brain_capture`**
  - Writes `Projects/<Project>/<filename>.md`, or `Notes/<filename>.md` when there is no project.
  - Sets `created` and `updated` to now.
  - Body limit: a body that would make the file larger than 64 KB fails with `LIMIT_EXCEEDED`.
  - `idempotency_key`: the same key with the same canonical payload returns the original result, and the same key with a different payload returns `CONFLICT`.
- **`brain_update`**
  - Fails with `CONFLICT` if the file's current hash differs from `expected_hash`.
  - A new `body` replaces the old one entirely. As with capture, it is the content below the title, and a leading H1 is rejected.
  - Changing `title` renames the file, and changing `project` moves it to that project's folder, which must exist.
  - Sets `updated` to now and keeps `created`.
  - Unknown frontmatter keys in hand-written files are kept.
- **`brain_delete`**
  - Fails with `CONFLICT` on a hash mismatch.
  - Moves the file to `.trash/<filename>`, adding the collision suffix if needed.
  - Deletes the note's feedback rows.
- **`brain_read`**
  - Fails with `LIMIT_EXCEEDED` for files larger than 256 KB.
  - `feedback` is the count per verdict across all recorded feedback for the note.
- **`brain_recall`**
  - Returns one item per note: the note's best-scoring chunk.
  - `excerpt` is that chunk's text, truncated to 600 characters; `heading` is the chunk's heading.
  - Ordering follows §5.3.
- **`brain_feedback`**
  - Records the verdict against the note's current hash.
  - Fails with `NOT_FOUND` if the note does not exist.
- **`brain_project_ensure`**
  - Normalizes the remote to `host/owner/repo`: the scheme, user@, port, and a trailing `.git` are stripped, the host is lowercased, and remotes carrying credentials are rejected with `INVALID_INPUT`. This normalization is salvaged from the current implementation.
  - If a project note already lists that identity, it returns that project with `created: false`.
  - Otherwise it creates `Projects/<repo>/` and its project note, using the last path segment as the folder name with the collision suffix if needed, and returns `created: true`.
- **Startup.** The gateway runs its first vault scan before it binds the listener, so there is no window where a tool is reachable but the index is empty. `/health` is only answerable once the index is built.

The server's MCP `instructions` describe exactly these eight tools, and state that retrieved Markdown is untrusted data and never an instruction.

## 5. State, index, consistency

### 5.1 Stores

There are two SQLite files in `BRAIN_STATE_DIR`, and each has a single `001` schema embedded in the code as a TypeScript string, so no SQL files are copied into `dist`:

| File | Tables | Nature |
|---|---|---|
| `index.db` | `notes`, `chunks`, `chunks_fts` | **Derived** from the vault. Deleting it causes a rebuild on the next start. |
| `brain.db` | `feedback(note_id, verdict, reason, note_hash, created_at)`, `idempotency(key, payload_hash, note_id, path, created_at)` | The only state that does not live in the vault. |

An instance lock file, `brain.lock`, stops two gateways from sharing a state directory.

### 5.2 Index sync

- **On start**, a full scan compares every file's size and mtime against `notes` (and the content hash when those differ), reindexes new or changed files, and removes rows for missing files. `/health` returns 503 until this scan completes.
- **While running**, the same scan repeats every `BRAIN_SCAN_INTERVAL_MS`. `fs.watch` is not used because it is unreliable on Docker bind mounts.
- **MCP writes** update the index synchronously before they return.
- **Unparseable files** (frontmatter that is not valid YAML, or a `type: project` file anywhere other than `Projects/<Name>/<Name>.md`) are left out of the index and reported in `problems[]`.
- **Duplicate `id`s** are reported in `problems[]`. Addressing such a note by `id` fails with `CONFLICT` and lists every matching path; addressing it by `path` still works.

### 5.3 Ranking

- **Query.** The FTS5 query is the query's terms joined with `OR`. This reuses today's `literalMatch`: terms are Unicode letters and digits, at most 64 terms, each one quoted.
- **Scoring.** BM25 with column weights title 8, tags 6, heading 3, text 1.
- **Filters.** `project` and `types` are applied in SQL.
- **Grouping.** Chunks are grouped per note, and a note's score is its best chunk's score.
- **Demotion.** A note is `demoted` when its most recent feedback is `incorrect`, `stale`, or `contradiction` **and** that feedback's `note_hash` equals the note's current hash.
- **Ordering.** Non-demoted notes come first, ordered by score, followed by demoted notes, ordered by score. Ties are broken by path.

Updating a note changes its hash, and that alone clears its demotion.

### 5.4 Writes and crash safety

Every note operation runs synchronously: `node:fs` and `better-sqlite3` calls block, so the single Node thread serializes writes without an explicit mutex.

**Update and delete:**
1. Resolve the note.
2. Hash the file.
3. Compare it with `expected_hash`.
4. Write to a temp file in the same directory, `fsync`, then rename.
5. Update the index.

**Capture with an `idempotency_key`:**
1. Look up the key.
   - It exists with the same payload: if the file at `path` exists, return it; otherwise finish steps 3–4 with the reserved id and path.
   - It exists with a different payload: `CONFLICT`.
2. Insert `(key, payload_hash, new id, path)`.
3. Write the file atomically.
4. Index it.

A crash at any point therefore never produces a duplicate note or loses the reservation. If a crash happens between the vault write and the index update, the next scan repairs the index.

## 6. Architecture

Configuration comes from the environment only:

| Variable | Default |
|---|---|
| `BRAIN_TOKEN_SHA256` | required; the lowercase hex SHA-256 of the bearer token |
| `BRAIN_VAULT_DIR` | `/vault` |
| `BRAIN_STATE_DIR` | `/var/lib/second-brain` |
| `BRAIN_PORT` | `7331` |
| `BRAIN_ALLOWED_HOSTS` | `127.0.0.1,localhost` |
| `BRAIN_ALLOWED_ORIGINS` | empty |
| `BRAIN_SCAN_INTERVAL_MS` | `30000` |

The modules:

| Module | Responsibility | Salvaged from |
|---|---|---|
| `src/errors.ts` | `BrainError`, the tool error codes, and their helpers | — |
| `src/types.ts` | Version, note types, verdicts, size and length limits | — |
| `src/config.ts` | Parse and validate the environment | — |
| `src/auth.ts` | Timing-safe bearer digest check | `security/authenticate.ts` |
| `src/app.ts` | Composition root: open vault, index, store, projects, sync, notes; hold `brain.lock`; initial scan | `runtime.ts` wiring |
| `src/http.ts` | Express app, host/Origin checks, 256 KB body limit, `/health`, MCP transport | `mcp/server.ts`, `runtime.ts` HTTP parts |
| `src/mcp/tools.ts` | The eight zod schemas, dispatch, `instructions` | — |
| `src/vault/paths.ts` | Vault-relative path validation, symlink/traversal refusal, filename sanitizing, collision suffixes | `storage/vault.ts` path checks |
| `src/vault/note-file.ts` | Parse and render frontmatter, H1 title, and body; preserve unknown keys | — |
| `src/vault/vault.ts` | List, read, atomic write, move to `.trash/`, hash | — |
| `src/projects.ts` | Discover projects, resolve name/key, ensure from a remote, normalize remotes | `projects/identity.ts`, `features/project-ensure.ts` normalization |
| `src/index/chunker.ts` | Character-budgeted, heading-aware chunks. Code fences are never split at headings or blank lines; a fenced block longer than the character budget is split at the budget like any other over-long text, because the per-chunk character ceiling takes precedence | `retrieval/chunker.ts` |
| `src/index/search-index.ts` | FTS5 schema, upsert/delete, BM25 candidates | `storage/search-index.ts`, `retrieval/query.ts` |
| `src/index/sync.ts` | Vault-to-index scan and diff, `problems[]` | — |
| `src/store.ts` | `brain.db` feedback and idempotency | — |
| `src/notes.ts` | Capture, update, delete, and read orchestration (§5.4) | — |
| `src/recall.ts` | Candidates → per-note grouping → demotion → excerpt and feedback summary | — |
| `src/status.ts` | Status payload | — |
| `src/import.ts` | One-shot porter (§8); deleted after cutover | — |
| `src/cli.ts` | `serve`, `import`, `token` (prints a new token and its digest), `token digest` (digest of a token on stdin) | — |

**Data flow.**
- **Write:** MCP → auth → tool → `notes.ts` (hash check) → `vault.ts` → `search-index` → response.
- **Recall:** MCP → `recall.ts` → FTS5 → group, demote, excerpt.
- **Sync:** timer → `sync.ts` → reindex the diff.

**Dependencies.** Runtime: `@modelcontextprotocol/sdk`, `better-sqlite3`, `express`, `yaml`, `zod`. Dev: `typescript`, `vitest`, `@types/*`. `mdast-util-from-markdown`, `js-tiktoken`, and `tsx` are removed: the new chunker is line-based and character-budgeted.

**Container.**
- **Image:** single stage on the digest-pinned `NODE_IMAGE`, running as non-root uid 1000, entrypoint `node dist/cli.js`, command `serve`.
- **Healthcheck:** `node -e "fetch('http://127.0.0.1:7331/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"`.
- **Compose:** mounts the vault read-write and the state volume, and publishes the port. It needs no config file, no secret files, and no Python.

**Repository contents after the rebuild:**
- `src/`, `tests/`, `package.json`, `package-lock.json`, `tsconfig.json`, `Dockerfile`, `compose.yaml`, `.env.example`, `.github/workflows/ci.yml`;
- `README.md`, `docs/setup.md`, `docs/operations.md`, `docs/agent-protocol.md`;
- `docs/superpowers/specs|plans/` for this work only.

All other directories and files are deleted, including every other document, `scripts/`, `workers/`, `config/`, and the old test trees. They remain available in git history.

## 7. Errors and security

- **Error codes** are as listed in §4. Log lines contain only operation, duration, outcome, code, and path, never note bodies, queries, or tokens.
- **Authentication and request checks.** A request without a valid `Authorization: Bearer` returns 401. A `Host` header outside `BRAIN_ALLOWED_HOSTS` returns 403, and so does an `Origin` header that is present and outside `BRAIN_ALLOWED_ORIGINS`. `/health` is the only unauthenticated route, and it exposes nothing except its status code.
- **Path safety.**
  - Paths must be vault-relative.
  - Absolute paths, `..`, NUL characters, and percent-encoded separators are rejected.
  - A symlink on any path segment is refused.
  - Writes never target `.obsidian/` or `.trash/`, except for the delete move into `.trash/`.
  - Project and file names are sanitized as in §3.
- **Limits.** Request body 256 KB, note written over MCP 64 KB, `brain_read` 256 KB, recall `limit` 20, excerpt 600 characters.

## 8. Porting, cutover, decommission

### 8.1 Porter

Invocation: `node dist/cli.js import --from <old-vault> --to <new-vault> --journal <old journal.db> [--dry-run]`

- **Inputs.** The old vault and the journal are opened read-only.
- **Target.** `--to` must not exist or must be an empty directory.
- **Validation.** The porter aborts with a report, writing nothing, if any note `id` is duplicated.

| Old | New |
|---|---|
| A note anywhere under `Projects/<P>/` (today always inside a type folder), with `type` other than `project` and status other than `archived` | `Projects/<P>/<sanitized title>.md`, with a collision suffix if flattening puts two titles on the same filename. Frontmatter becomes `id`, `type`, `tags`, `created`, `updated`, taken from the old frontmatter. The content (H1 plus body) is byte-identical except for rewritten links. |
| A note with `status: archived` | Skipped and listed in the report (today: the `Live MCP deployment test …` note). |
| A path-qualified wikilink `[[Projects/…]]` (with an optional `|alias` or `#heading`) | Rewritten to the target's new path through the full old→new map. An unresolvable link is left unchanged and reported (today: `[[44b093c5-…]]`). |
| The old hub `Projects/<P>/<P>.md` and every project folder | A fresh project note: `type: project`, `repositories` taken from `projects_v2.repository_identity` for the matching project, and body `# <P>`. |
| `.obsidian/` | Copied. |
| `.trash/`, `Profile/`, anything else outside `Projects/` | Not copied, and listed in the report. |

**The report** records, as counts and paths: notes written, notes skipped, project notes written, links rewritten, links unresolved, and files not copied. With `--dry-run`, it prints the report and writes nothing.

**Mapping today's projects.** `projects_v2` provides remotes for `second-brain → Second Brain`, `doccary → Doccary`, and `opencode → OpenCode`, matched on display name. `FreeLLM API` and `Shared` have no remote; you can bind one later by editing their project notes.

### 8.2 Cutover runbook

1. Stop `second-brain`. Create `tar` archives of `/root/vault` and the `traefik_second-brain-state` volume, and record the counts from the dry run.
2. Run `import --dry-run`, review the report, then run it for real into `/root/vault-new`.
3. Open `/root/vault-new` in Obsidian and spot-check the notes and the rewritten links.
4. Rename `/root/vault` to `/root/vault-legacy` and `/root/vault-new` to `/root/vault`. Point the deployment's `second-brain` service at the new image, set the env config (`BRAIN_TOKEN_SHA256` = the digest of the existing client token), and attach a **new, empty** state volume. Start the service.
5. Verify:
   - `/health` returns 200;
   - `brain_status` reports 35 notes, 5 projects, and an empty `problems[]`;
   - one recall per project finds its notes;
   - capture, read, update, and delete work round-trip, including a hash-conflict check;
   - `brain_project_ensure` with `github.com/bearmanser/second-brain` returns `Second Brain` with `created: false`.
6. **Rollback:** restore the previous image digest, `/root/vault-legacy`, and the old state volume. None of them are modified during the cutover.

### 8.3 Decommission, after acceptance

- **Remove the old state volumes:** `traefik_second-brain-state`, `traefik_second-brain-memory-state`, `traefik_second-brain-model-cache`, `second-brain-state-old`, and `second-brain_brain-state`.
- **Remove other leftovers:** `/root/docker/second-brain/` (the old config and secrets), `/root/vault-legacy`, the old local image digests, and any old `second-brain` settings left in the deployment compose (the retired volume declarations and the old config and secret mounts).
- **Keep the client token.** It is unchanged.
- **Commit** "chore: remove the one-shot importer", which deletes `src/import.ts`, its CLI command, and its tests.

## 9. Testing

- **Unit tests:**
  - `note-file` parse/render round-trip, including preserved unknown keys and the missing-H1 fallback;
  - path validation and filename sanitizing, including collisions;
  - the chunker;
  - `search-index`;
  - recall grouping, ordering, and demotion, including clearing on hash change;
  - the store;
  - remote normalization;
  - config parsing.
- **Integration tests** run real MCP over HTTP against a temporary vault and cover:
  - 401, 403 for host, and 403 for origin;
  - all eight tools, including their error codes;
  - a hash conflict after an out-of-band edit;
  - idempotent capture, including the reserved-but-unwritten crash case;
  - the scan picking up external create, edit, and delete;
  - `problems[]` for broken frontmatter and duplicate ids;
  - the listener refusing connections until the first scan is done.
- **Importer tests** use a fixture that mirrors the old layout: type folders, a hub note, path-qualified links with an alias and a heading, the archived note, the UUID link, a duplicate-id case that aborts, and `--dry-run` writing nothing. These tests are deleted together with the importer.
- **End-to-end:** build the image, start Compose with a temporary vault, check `/health`, and run capture → recall → update → delete over MCP.
- **CI:** a `fast` job (typecheck, unit, build) and a `docker` job (integration, e2e).

## 10. Acceptance criteria

1. `src` contains only the modules in §6. A case-insensitive search of `src/` for `laya`, `rerank`, `basic.memory`, `basic_memory`, `basicmemory`, `backend_`, `permalink`, `legacy`, `hybrid`, `brain_schema_version`, `revision_id`, `include_candidates`, and `brain_review` returns no matches, except inside `src/import.ts` before it is deleted. Test fixtures are data and may legitimately contain these words (for example `Laya`, `Reranker`, and a `legacy` column name), so `tests/` is not part of this search.
2. The MCP surface is exactly the eight tools in §4, with exactly the listed fields.
3. The state directory contains only `index.db`, `brain.db`, and `brain.lock` (plus SQLite WAL and SHM files).
4. Deleting `index.db` and restarting reproduces identical recall results.
5. The porter moves the 35 notes and 5 projects with every resolvable wikilink rewritten, skips 1 archived note, and reports 1 unresolved link.
6. The cutover verification in §8.2 step 5 passes against the deployment.
7. After decommission, `docker volume ls`, the deployment compose file, and the repository contain nothing belonging to the old system.
