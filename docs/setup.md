# Setup

## Requirements

- **Node 24** (the `engines` field requires `>=24 <25`). Use a Node 24 runtime;
  the system default may be older.
- **Docker** for the containerized path (`docker compose`).

## Local development

```bash
npm ci
npm test
npm run typecheck
npm run build
```

Then run the gateway against a scratch vault and state directory:

```bash
BRAIN_TOKEN_SHA256=$(printf %s "$TOKEN" | node dist/cli.js token digest) \
BRAIN_VAULT_DIR=/tmp/vault BRAIN_STATE_DIR=/tmp/brain-state node dist/cli.js serve
```

`node dist/cli.js serve` is the default command; the gateway logs a `ready`
line with its URL once the initial scan finishes and the listener is bound.

## Generating and rotating tokens

Generate a token and its digest:

```bash
node dist/cli.js token
```

This prints two lines: `token:` (the bearer token your MCP client sends) and
`token_sha256:` (the SHA-256 digest of that token). Store the **raw token**
with the MCP client, and put only the **digest** in `BRAIN_TOKEN_SHA256`. The
raw token never reaches the gateway.

To rotate, run `node dist/cli.js token` again, give the new raw token to the
client, and update `BRAIN_TOKEN_SHA256` to the new digest. The digest is read
once at startup, so a restart is required for the new value to take effect.

To compute the digest for a token you already have (for example an existing
client token you want to keep), pipe it into `token digest`:

```bash
printf %s "$TOKEN" | node dist/cli.js token digest
```

## Connecting an MCP client

The gateway serves Streamable HTTP MCP at `http://127.0.0.1:7331/mcp`. Only
`POST` is accepted. The client must send `Authorization: Bearer <token>`, where
`<token>` is the raw token whose digest is `BRAIN_TOKEN_SHA256`.

A minimal `opencode.jsonc` that names the server and passes the header:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "second-brain": {
      "type": "remote",
      "url": "http://127.0.0.1:7331/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

Replace `<token>` with the raw token. If the gateway is reachable from a
different host, widen `BRAIN_ALLOWED_HOSTS` accordingly and re-check the
`BRAIN_ALLOWED_ORIGINS` setting before exposing it.

## Container user

The image runs as uid/gid `1000` and pre-creates `/vault` and
`/var/lib/second-brain` with that ownership; a fresh named volume inherits it.
Keep `BRAIN_UID`/`BRAIN_GID` at their `1000` default unless both the vault bind
mount and the state volume are owned by the same alternate uid. Changing them
to a different uid makes the process unable to write the state volume and it
fails at startup — recreate the volume (or `chown` it to the new uid) first.
