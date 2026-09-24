# Frozen local retrieval evaluation fixture

This directory holds a synthetic, committed evaluation set for the local V2
retrieval path. It contains no private note text, no real user query, and no
credential. Every note body is invented for the fixture; the run-time dataset is
stored outside the repository at `/var/lib/second-brain/evaluations/retrieval.jsonl`.

## Files

| File | Purpose |
|---|---|
| `dataset.jsonl` | One frozen query per line with its candidate pool, graded labels, optional graph candidates, optional direct answer, and the synthetic source text for that line. |
| `source-hashes.json` | `sha256` of each synthetic note body, so a judgment can be tied to an exact source version. |

The set has 119 queries across eleven slices and 20 synthetic notes. Regenerate the
file with the recipe in "Generation" if a future task deliberately revises it;
the committed file is the frozen input and must not change while prompts or
parameters are tuned.

## Slices

| Slice | Count | What it exercises |
|---|---|---|
| `english-exact` | 15 | English exact identifiers and decisions |
| `norwegian` | 10 | Norwegian queries, including `æ/ø/å` |
| `code-terms` | 10 | Function names, SQL/FTS5 terms, CLI flags |
| `decision-reasons` | 10 | Why a decision was made |
| `procedural` | 10 | Step-by-step "how do I" questions |
| `synonyms` | 12 | Relevant notes with little or no lexical overlap |
| `ambiguous-titles` | 10 | Two notes sharing a title |
| `outdated-decisions` | 10 | Superseded and stale notes |
| `no-answer` | 12 | Queries with no relevant note |
| `instructions-in-notes` | 10 | Instructions embedded in note bodies treated as data |
| `graph-expanded` | 8 | Relevant note reachable only through bounded graph expansion |

## Judgment rubric

Each `(query, source_hash)` pair is graded once on this fixed rubric:

| Label | Meaning |
|---|---|
| `2` | Direct support: the note contains the answer or the exact decision. |
| `1` | Helpful context: the note supports the answer but is not sufficient alone. |
| `0` | Irrelevant: the note is judged and does not support the query. |

Rules that the metrics and export enforce:

- A candidate that has not been explicitly judged is **unjudged**, not `0`.
  Unjudged candidates are counted and never exported as negatives.
- Recall treats `1` and `2` as relevant. `0` is not relevant.
- nDCG uses gain `2 ** label - 1` and discount `log2(rank + 1)` (1-based rank).
- Recall is `null` when the query has no relevant note. The `no-answer` slice is
  scored with a separate false-positive count instead.
- An agent's "I used this note" event is `agent_proposed`; it is never promoted
  to a gold label. Only an explicit `human_reviewed` (or frozen `synthetic`)
  judgment can be exported as a label.

## Generation

`dataset.jsonl` was generated from an invented 20-note body set and a per-slice
query template list. Every line embeds the `sha256` of the synthetic note bodies
it references, which is also recorded in `source-hashes.json`. The candidate
pool is the pre-Laya lexical/exact-match pool; `graph_candidates` models the
bounded graph expansion (bound = 10 neighbours).

## Serving the dataset to the exporter

`node dist/cli.js feedback export --output <path> --include-text --split-seed <n>`
reads the run-time dataset (default `<state>/evaluations/retrieval.jsonl`) to
resolve `query_text` and `note_text` from each line's `query` and `notes`
entries. Without `--include-text` the export contains only identifiers, hashes,
labels, and the manifest.
