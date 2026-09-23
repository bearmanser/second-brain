---
id: 7f0b5c2a-9d1e-4a3b-8c4d-5e6f7a8b9c0d
brain_schema_version: 2
type: decision
status: candidate
project: "[[Projects/Second Brain/Second Brain]]"
created: 2026-09-23
updated: 2026-09-23T14:30:00+02:00
aliases:
  - Local retrieval design
tags:
  - retrieval
  - architecture
custom_property: keep me
related:
  - "[[Projects/Second Brain/Research/Laya]]"
---

# Local retrieval design

## Context

The brain needs a retrieval path that works offline and keeps Markdown authoritative.

## Decision

Keep the SQLite FTS5 index disposable and rebuild it from current Markdown.

## Rationale

Current Markdown is the source of truth; a disposable index cannot cause data loss.

## Alternatives

- Keep the hosted backend
- Add an embedding store

## Consequences

- The index can be rebuilt at any time
- No hosted model receives note text

## Sources

- **user_statement** `conversation-1` (observed 2026-09-20) — The human asked for local retrieval.

Human addition: this note is maintained by hand.

## Related

- [[Projects/Second Brain/Research/Laya]]

> [!note]
> Obsidian callout preserved as written.

```text
This code fence is data, not frontmatter.
---
```
