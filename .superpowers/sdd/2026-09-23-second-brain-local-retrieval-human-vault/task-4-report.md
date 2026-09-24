# Task 4 Report: Define and render readable V2 documents

**Status:** COMPLETE
**Branch:** `feat/local-brain-v2`
**Base commit:** `19a0a39`
**Commit:** `58e620ba9559c04094284f27992bacbbb607edca` — `feat: add human-readable Obsidian document format`

## Implementation

### New modules

- `src/notes/document.ts` — the readable current-document schema:
  - `BRAIN_SCHEMA_VERSION = 2`
  - `DOCUMENT_STATUSES = ['candidate','active','superseded','archived']` (verbatim)
  - `DEFAULT_TYPE_FOR_KIND` (verbatim; all seven structured kinds map to their own type)
  - `HUMAN_DOCUMENT_TYPES`, `SOURCE_SECTION_TITLE = 'Sources'`
  - `CurrentDocument = {id?, path, title, type, status, project?, aliases, tags, created?, updated?, properties, body}`
  - `isDocumentStatus`, `contentKindForType` (seven structured kinds keep their content shape;
    any other human type uses the flexible `note` shape).
- `src/notes/document-codec.ts` — `parseDocument(raw, path): CurrentDocument`,
  `renderDocument(document): string`, plus supporting readable-evidence and structured-agent helpers:
  `documentFromNote`, `renderNoteBody`, `renderSources`, `parseSources`, `DocumentMetadata`, `ParsedSources`.

### Behavior

- **Parsing never allocates an ID.** `id` is read only; if present it must be a UUID. Ordinary Markdown without
  frontmatter is readable with safe defaults (`type: note`, `status: candidate`, empty properties).
- **Frontmatter** is split with an exact `---` column-0 delimiter, so an indented `---` inside a YAML block
  scalar does not close the block early. YAML is parsed with the core schema; document errors (duplicate keys,
  malformed YAML), warnings (explicit tags), explicit tag nodes, and aliases are rejected as typed
  `BrainError`s (`INVALID_INPUT`), and a newer `brain_schema_version` is `UNSUPPORTED_SCHEMA`. A malformed file
  is therefore reportable per file without stopping a whole-vault index pass.
- **Recognized properties:** `id`, `brain_schema_version`, `type`, `status`, `project`, `aliases`, `tags`,
  `created`, `updated`. Everything else is preserved verbatim in `properties` as a flat record (scalars,
  nested maps, and lists keep their parsed values).
- **Dates:** `created`/`updated` accept ISO date-only (`2026-09-23`) or RFC3339 with a timezone
  (`2026-09-23T14:30:00+02:00`); the exact string is preserved. A timestamp without a timezone is malformed.
- **Lifecycle:** `status` is preserved when valid and defaults to `candidate` when absent, so an old AI
  hypothesis is never promoted to an approved fact. Status is never inferred from directory names.
- **Title:** derived from the first level-1 body heading, falling back to the path basename. It is not written
  into frontmatter, so the human-authored body (including the H1, callouts, code fences, `---` rules) is
  preserved byte-for-byte apart from the fixed blank line after frontmatter.
- **Rendering** emits deterministic ordered frontmatter (`id`, `brain_schema_version`, `type`, `status`,
  `project`, `created`, `updated`, `aliases`, `tags`, then unknown properties sorted by key) followed by the
  body. Empty alias/tag lists are omitted; unknown properties are re-emitted.
- **Readable evidence:** `renderSources` produces a `## Sources` section of single-line entries
  `- **<kind>** <ref-as-link-or-code> (observed <date>) — <description>`. URLs render as labeled Markdown
  links; other refs render as backticked text. `parseSources` deterministically recovers service-generated
  entries (with kind/observed date) and retains any unmatched human lines verbatim in `human`. No fenced YAML
  blobs are required or produced for sources or relationships.
- **Structured agent inputs:** `documentFromNote`/`renderNoteBody` turn the seven structured content kinds
  into normal `## Heading` sections (prose and readable bullet lists), append `## Sources` and `## Related`
  as plain bullet lists, and never emit a ```yaml fence. Later human edits to those headings are ordinary
  flexible body content.

### V1 preservation

`src/notes/codec.ts`, `src/notes/registry.ts`, `src/contracts/content.ts`, and `src/core/types.ts` were changed
only to name the V1 surface explicitly, with no behavioral change:

- `codec.ts`: `V1_SCHEMA_VERSION = 1` (`CURRENT_SCHEMA_VERSION` now derives from it) and
  `decodeRevisionV1`/`renderRevisionV1`/`encodeRevisionV1`/`payloadHashV1` aliases.
- `registry.ts`: `V1_EVIDENCE_SECTION_TITLE`, `V1_RELATED_SECTION_TITLE`, `V1_NOTE_REGISTRY`.
- `content.ts`: `noteContentSchemaV1`, `noteInputSchemaV1`, `evidenceSchemaV1`.
- `types.ts`: `NoteContentV1`, `NoteInputV1`, `StoredRevisionV1`.

The strict V1 decoder (`decodeRevision`) and all existing V1 tests are unchanged and green.

## Files

Created:
- `src/notes/document.ts`
- `src/notes/document-codec.ts`
- `tests/unit/document-codec.test.ts`
- `tests/fixtures/vault-v2/readable-decision.md`

Modified (V1 preservation only):
- `src/notes/codec.ts`
- `src/notes/registry.ts`
- `src/contracts/content.ts`
- `src/core/types.ts`

No files outside the Task 4 file list were touched. No comments were added to product code.

## Tests

`tests/unit/document-codec.test.ts` (25 tests):
- the brief's round-trip/ordinary-Markdown test (verbatim);
- exact `DEFAULT_TYPE_FOR_KIND` and `DOCUMENT_STATUSES` values;
- all seven legacy structured kinds render into normal headings and round-trip;
- date-only and RFC3339-offset properties; timezone-less timestamp rejected;
- malformed YAML, unterminated frontmatter, duplicate keys, explicit tags, unsafe aliases;
- unsupported/newer schema version and legacy version 1 rejected by the V2 decoder;
- callouts and code fences, and an indented `---` inside a YAML block scalar;
- a malformed file is reportable without stopping a whole-vault index pass;
- ordinary Markdown without frontmatter with safe defaults;
- parsing never allocates an ID; lifecycle defaults to `candidate` and is not inferred from a directory;
- an old AI hypothesis is not promoted to an approved fact (hypothesis evidence kind preserved);
- custom properties stay flat values across a deterministic round trip;
- type-versus-tag rules (`contentKindForType`);
- human aliases/tags survive an agent revision;
- readable `## Sources` rendering (labeled links/text, kind, observed date) and deterministic parsing;
- human additions to `## Sources` retained verbatim;
- structured agent input renders headings + sources with no YAML fence;
- the `readable-decision.md` fixture round-trips with custom properties, callout, and its source entry intact;
- explicit V1 decoding remains available beside the V2 codec.

## TDD evidence

**RED** (before implementation):

```
FAIL tests/unit/document-codec.test.ts
Error: Cannot find module '../../src/notes/document-codec.js'
 imported from /root/git/second-brain-v2/tests/unit/document-codec.test.ts
Test Files 1 failed (1)   Tests no tests
```

**GREEN** (final):

```
✓ tests/unit/document-codec.test.ts (25 tests) 58ms
Test Files 1 passed (1)   Tests 25 passed (25)
```

Full verification:
- `npm run verify` → typecheck clean, **392 unit/contract tests passed** (26 files), build succeeded.
- `npm run test:integration` → **358 tests passed** (17 files).

Both were re-run after the last code change and are green.

## Self-review

- Required interfaces `parseDocument(raw, path)` and `renderDocument(document)` are exported with the exact
  signatures; `CurrentDocument` has exactly the required fields.
- `DEFAULT_TYPE_FOR_KIND` and `DOCUMENT_STATUSES` match the brief's code block verbatim.
- `properties` preserves unrecognized YAML values; `body` preserves user-authored Markdown; parsing allocates
  no ID.
- Evidence renders as a readable `## Sources` section; the service-generated entry format is parsed
  deterministically and human additions are retained verbatim; no fenced YAML is required for sources or
  relationships.
- Structured agent inputs render into ordinary headings; a later heading edit is just body content.
- Old AI hypotheses default to `candidate`; lifecycle is never inferred from directories.
- Custom-property preservation and type-versus-tag rules are documented by descriptively named tests and by the
  fixture document.
- V1 decoding is preserved and explicitly named; all pre-existing tests pass.

## Concerns

- `parseSources` assumes each service-generated source entry is a single line. Embedded newlines in an evidence
  description or ref are collapsed to spaces at render time. This keeps the format deterministic and readable;
  multi-paragraph source prose belongs in the human addition area (retained verbatim).
  **Resolved in Fix Round 1:** entries now use a reversible escaped representation, so multi-line refs,
  descriptions, and observed dates round-trip exactly (see below).
- Title is derived from the first H1 or the path basename and is intentionally not stored in frontmatter, per the
  plan's human-facing frontmatter example and Obsidian conventions. A caller that constructs a document with no
  H1 in `body` should set a meaningful `path` (or add the H1) to preserve the intended title.
- Timestamps without a timezone are rejected as malformed by design (section 4.1 requires a timezone for
  timestamp forms); date-only values remain accepted.
- `V2` parsing of a legacy `brain_schema_version: 1` document throws `UNSUPPORTED_SCHEMA`; legacy revisions must
  be decoded with `decodeRevisionV1`. This is intentional so the V1 decoder stays the single source for legacy
  bytes and migration (Task 10) can map them explicitly.

## Fix Round 1

**Commit:** `3e42eab0a4f9906678bdba4489523e92d9a339f3` — `fix: harden readable document codec round trips`
(does not rewrite `58e620b`).

Findings fixed: **1, 2, 3, 4, 5** (all four Important and the Minor).

### Finding 1 — body bytes preserved exactly

`renderDocument` no longer strips leading newlines from `document.body`; it emits
`---\n<frontmatter>\n---\n` followed by the body verbatim. Because `splitFrontmatter` consumes exactly the newline
that terminates the closing `---`, the leading separator newline is structural and the body bytes are preserved.
`renderNoteBody` now begins its generated body with that leading newline so newly created documents still render
with a blank line after the frontmatter.

Test: `body bytes including leading blank lines survive an exact round trip` asserts `parsed.body` equals
`'\n\n\n# Spaced\n\ntext\n'`, that `parseDocument(renderDocument(parsed)).body` is identical, and that a second
render is byte-identical.

### Finding 2 — Sources parsing is Markdown-aware and lossless

`parseSources` now:
- locates the `## Sources` heading and parses only that section, stopping at the next level-1/2 heading
  (`## Related` is no longer absorbed);
- tracks fenced code blocks, so a human example such as
  `` - **repository** `not-a-real-source` — Human example `` inside a fence stays human text;
- matches entries on the raw line (no trimming), so an indented human line is never reclassified;
- preserves every unmatched line, including internal and surrounding blank lines, and skips only the single
  structural blank line the renderer emits after the heading.

Tests: `a fenced code example inside Sources is not reclassified as evidence`,
`multi-line human additions and their blank lines are preserved exactly`, and
`a following section is not absorbed into Sources`.

### Finding 3 — renderer and parser are mutually reversible

Source fields now use a reversible escape (`\` → `\\`, CR/LF → `\r`/`\n`, plus delimiter-specific escapes) and
follow a single unambiguous shape:
`- **kind** [label](<target>) (observed date) — description` for allowlisted schemes, or
`` - **kind** `escaped-ref` (observed date) — description `` otherwise. The URL target is always angle-bracketed,
so `)` and spaces are handled, and non-URL refs keep backticks exactly.

Test: `rendered sources reverse exactly for punctuation and multiline values` asserts
`parseSources(renderSources(evidence)).evidence` deep-equals evidence for a parenthesised URL, a URL with a space
and parentheses, a backtick-containing ref, and multi-line ref/description/observed values.

### Finding 4 — preservation-aware revision path

Added `reviseDocument(base, note, meta?)`. It keeps the base identity/path/lifecycle, merges custom properties,
preserves human aliases and tags unless overridden, regenerates only the kind's managed section headings and
`## Sources`/`## Related`, re-attaches human lines found inside the old `## Sources`, keeps non-managed human
sections and content after `## Related`, and appends preserved human blocks. `documentFromNote` remains the
creation-only helper.

Test: `a revision preserves human sections and source additions` revises the fixture decision, asserts the
managed context is replaced, and asserts the custom property, aliases, `related` property, identity, source human
addition, callout, and code fence all survive.

### Finding 5 (Minor) — safe link schemes and escaping

`renderReference` only emits a Markdown link for allowlisted schemes (`http`, `https`, `mailto`); anything else
(including `javascript:`) is emitted as inert escaped text. Labels, targets, refs, dates, and descriptions are
escaped so untrusted evidence cannot break out of the link syntax.

Test: `unsafe link schemes are inert text and labels stay escaped`.

### Fix-round verification

```
npx vitest run tests/unit/document-codec.test.ts      → 32 passed (32)
npm run verify                                         → typecheck clean, 401 tests passed (26 files), build succeeded
npm run test:integration                               → 358 tests passed (17 files)
```

All pre-existing assertions were retained; the only changed expectation is the URL link form, which now uses the
angle-bracketed target introduced by Finding 3/5. No product-code comments were added.

## Fix Round 2

**Commit:** `1dd370a0331b01f27f76e2b6ff7ce2a810650b74` — `fix: keep human content and legacy source links in V2 documents`
(does not rewrite `3e42eab`).

Findings fixed: **2, 4, 5**, plus the **new Important compatibility regression**.

### Finding 2 — parse only a genuine, fence-aware Sources section

- `findSourceHeadingIndex` scans for a `## Sources` heading while tracking fenced code blocks, so a
  source-shaped example inside a fence is never mistaken for the heading.
- When there is no genuine Sources heading, `parseSources` returns every line as `human` and **no** evidence;
  it never reclassifies arbitrary body text.
- Section boundaries (`##`/`#` headings) still end the section, so a source-shaped line after
  `## Related` is not evidence.

Tests: `source-shaped lines outside a genuine Sources section stay body text`,
`without a Sources heading no body line is reclassified as evidence`, and
`a source-shaped line after the Sources section is not evidence`.

### Finding 4 — origin-tracked revision preserves all human additions

`reviseDocument(base, note, { previous, meta? })` now requires the **previous note** used to generate the base
body. `subtractGenerated` re-renders that previous note's managed skeleton deterministically and removes only the
exact generated blocks from the base body, in order. Everything left is human content and is preserved verbatim
and re-attached to its section:

- a human-added related link (not an agent-generated `- [[<uuid>]]`) stays under `## Related`;
- a paragraph/callout added inside a managed heading (for example `## Context`) stays in that section rather than
  being discarded with the heading's old range;
- source additions and non-managed human sections are retained.

Tests: `a revision preserves a human-added related link`,
`a revision preserves human content added inside a managed heading`, and the rewritten
`a revision preserves human sections and source additions` (generated base + injected human context note, source
note, related link; asserts identity, aliases, tags, and custom property).

### Finding 5 (Minor) — escape Markdown label metacharacters

`renderReference` now escapes `[`, `]`, `*`, and `_` in link labels, so a reference containing `*text*` cannot
create emphasis. Test: `link label metacharacters are escaped and survive a round trip` asserts the escaped form
`` \*star\* `` is emitted and that the label still round-trips.

### New regression — accept the pre-fix ordinary-link form

`SOURCE_ENTRY_PATTERN` now accepts both `[label](<target>)` (current) and `[label](target)` (pre-fix ordinary
links) plus the backticked text form. A document produced by the original Task 4 renderer therefore still parses
its service-generated sources as evidence instead of human text.

Tests: `a pre-fix ordinary-link source still parses after the format change` and
`a pre-fix ordinary-link source with an observed date still parses`.

### Fix-round verification

```
npx vitest run tests/unit/document-codec.test.ts      → 40 passed (40)
npm run verify                                         → typecheck clean, 409 tests passed (26 files), build succeeded
npm run test:integration                               → 358 tests passed (17 files)
```

Note: `reviseDocument`'s third argument changed from `RevisionMetadata` to `{ previous, meta? }` so origin
tracking is explicit; it is a Task 4-only helper with no other callers. No product-code comments were added.

## Fix Round 3

**Commit:** `d599c138da3d1e34a209dbee8fd2c8eeb9ef6b83` — `fix: locate Sources and remove skeletons by Markdown structure`
(does not rewrite `1dd370a`).

Items fixed: **2 and 4**, both structurally rather than by extending the previous special cases.

### Item 2 — Sources location uses the Markdown AST

The hand-rolled fence tracker was removed. `parseSources` now calls `fromMarkdown` and:
- finds the first **top-level** level-1/2 heading whose text is `Sources`; a `## Sources` inside a fenced code
  block is content of a `code` node, so it is never treated as a heading;
- computes the section end from the next top-level level-1/2 heading node;
- treats every line whose start offset falls inside any `code` node (fences included) as `human`, never
  evidence;
- when no genuine Sources heading exists, returns every input line verbatim as `human` and no evidence.

The new `analyzeSource` helper (mdast top-level headings + nested code ranges + line offsets) is shared with the
revision path.

Tests:
- `a fenced ## Sources example inside an open fence is not a heading` builds
  ```` ```markdown ```` / ```` ```ts ```` / `## Sources` / a source-shaped line / ```` ``` ```` and asserts the
  evidence list is empty **and** that both `## Sources` and the source-shaped line remain in `human`.
- `a real Sources section after a fenced example parses only the real entries` asserts only the real entry is
  evidence.
- The existing fenced, boundary, and no-heading tests still pass.

### Item 4 — skeleton removal is structural, not byte equality

`subtractGenerated` no longer matches whole generated blocks with `indexOf`. Instead:
- `generatedSkeleton(previous)` renders the previous note and derives, per managed level-2 section, the exact
  set of non-blank content lines it produced (a multiset), plus the set of generated section headings;
- `analyzeSource(base.body)` assigns every base line to its enclosing top-level H1/H2 section and marks lines
  inside fenced code;
- the first level-1 heading line and exactly the generated section heading lines are removed; each generated
  content line is removed at most as many times as the previous render produced it; fenced-code lines are never
  removed; every other line is preserved verbatim and re-attached to its section (or to general human content
  for a non-generated human section).

Because removal is per line, an insertion that breaks whole-block equality (such as a related link added before
the section's final newline) no longer leaves the old heading, generated ID, or managed content duplicated.

Tests:
- `a revision replaces the generated Related section without duplicating it` asserts the result has **exactly
  one** `## Related` heading, the old generated ID is gone, and the new ID plus the human-added link remain.
- `a revision removes the generated skeleton when a human edit replaced managed text` replaces generated
  context text, then asserts **exactly one** `## Context` heading, that `Generated context.` is gone, and that
  `Updated context.` and the human-edited text remain.
- The round-2 revision tests (human context note, human source note, human related link, human callout inside a
  managed heading) still pass unchanged.

### Fix-round verification

```
npx vitest run tests/unit/document-codec.test.ts      → 44 passed (44)
npm run verify                                         → typecheck clean, 413 tests passed (26 files), build succeeded
npm run test:integration                               → 358 tests passed (17 files)
```

No product-code comments were added; only `src/notes/document-codec.ts` and its test changed.

## Fix Round 4

**Commit subject:** `fix: preserve source lines and generated section ownership` (new commit after `d599c13`).

Items fixed: **2, Regression C, Regression D**.

- **Item 2:** With a real Sources heading, `parseSources` extracts evidence only from that section and now retains source-shaped lines before and after it in `human` in source order. The genuine-section fence test also asserts that the outside fake line is retained; dedicated assertions cover lines after Sources and their ordering relative to human lines inside Sources. The existing expectation that ordinary following headings and links are not absorbed into Sources is unchanged.
- **Regression C:** Previous generated Markdown is parsed into ordered heading-delimited blocks. Revision subtraction matches each generated section to one occurrence by its previous heading position, then removes that occurrence's generated heading and content only. A human-authored second `## Context`, even one containing text identical to the previous generated field, remains a separate section with its heading and text intact when the original field has been edited.
- **Regression D:** Generated content counts are scoped to their matched generated section, including lines inside its fenced code block. The unconditional code-line exemption is gone, so the old generated fence and contents are removed while an independently added human fenced block survives.

TDD: the expanded focused codec test initially failed on all three behaviors (five assertions), then passed after the structural fix. A follow-up order/duplicate-content regression test failed and passed after matching by prior position and retaining outside lines in source order.

Verification (Node 24.15.0 via `/tmp/opencode/node-v24.15.0-linux-x64/bin`):

```
npx vitest run tests/unit/document-codec.test.ts  → 47 passed (47)
npm run verify                                   → typecheck clean, 416 unit/contract tests passed (26 files), build succeeded
npm run test:integration                         → 358 passed (17 files)
npm test                                         → timed out after 240 seconds without a final summary (no pass claim)
git diff --check                                 → clean
```

No files outside the Task 4 source, unit test, and report were changed; no product-code comments or persistent fixtures were added.
