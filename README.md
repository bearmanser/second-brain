# second-brain

Second Brain is an Obsidian vault served over MCP. Notes are plain Markdown
files; a full-text FTS5 index powers recall, and feedback you record about a
note demotes it from recall until its content changes. Projects are defined by
folders in the vault, not by an external database — the vault is the single
source of truth.

## Tools

The gateway exposes exactly eight tools over Streamable HTTP:

| Tool | What it does |
| --- | --- |
| `brain_capture` | Create a note from a title and body, returning its id, path, and hash. |
| `brain_update` | Change an existing note's title, body, type, tags, or project, guarded by its hash. |
| `brain_delete` | Move a note to `.trash/`, guarded by its hash. |
| `brain_read` | Read one note by id or path, including its body, hash, and feedback summary. |
| `brain_recall` | Search the vault with FTS5 and return one item per note, best match first. |
| `brain_feedback` | Record whether a note was useful, irrelevant, stale, incorrect, or contradictory. |
| `brain_project_ensure` | Resolve a git remote to a `Projects/<Name>/` folder, creating it when missing. |
| `brain_status` | Report the version, note counts, projects, and any indexing problems. |

## Quick start

```bash
npm ci
npm test
npm run build
node dist/cli.js token        # prints `token` and `token_sha256`
```

The `token` line is the client token you configure in your MCP client; the
`token_sha256` line is what the gateway needs. Put the digest in your
environment and start the container:

```bash
export BRAIN_TOKEN_SHA256=<token_sha256 from above>
docker compose up -d --build
```

The gateway listens for Streamable HTTP MCP at
`http://127.0.0.1:7331/mcp`; your client must send
`Authorization: Bearer <token>`. See `docs/setup.md` for a local
(non-container) run and client wiring.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `BRAIN_TOKEN_SHA256` | — (required) | Lowercase hex SHA-256 of the bearer token the client sends. |
| `BRAIN_VAULT_DIR` | `/vault` | Directory holding the Obsidian vault. |
| `BRAIN_STATE_DIR` | `/var/lib/second-brain` | Directory for `index.db`, `brain.db`, and `brain.lock`. |
| `BRAIN_PORT` | `7331` | Port the HTTP server binds. |
| `BRAIN_ALLOWED_HOSTS` | `127.0.0.1,localhost` | Comma-separated `Host` header values accepted. |
| `BRAIN_ALLOWED_ORIGINS` | (empty) | Comma-separated bare origins accepted; empty rejects cross-origin requests. |
| `BRAIN_SCAN_INTERVAL_MS` | `30000` | How often the vault is rescanned for external edits. |

## Vault layout

```text
<vault>/
  Notes/<Title>.md               standalone notes (no project)
  Projects/<Name>/               notes belonging to project <Name>
  Projects/<Name>/<Name>.md      the project note, listing repository remotes
  .trash/                        deleted notes; never indexed
```

`Notes/` holds notes that belong to no project; `Projects/<Name>/` holds a
project's notes, with `Projects/<Name>/<Name>.md` as the project note itself.

## Further reading

- `docs/setup.md` — requirements, local development, token rotation, client wiring.
- `docs/operations.md` — state files, scanning, health, backup, and recovery.
- `docs/agent-protocol.md` — the full tool contract for MCP clients and agents.
