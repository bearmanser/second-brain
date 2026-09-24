import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { LocalEvaluationQuery } from './evaluation.js';

export interface ParsedEvaluationDataset {
  queries: LocalEvaluationQuery[];
  candidatesByQuery: Map<string, string[]>;
  queryText: Map<string, string>;
  noteText: Map<string, string>;
  sha256: string;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function labelMap(value: unknown): Map<string, 0 | 1 | 2> {
  const labels = new Map<string, 0 | 1 | 2>();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return labels;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === 0 || raw === 1 || raw === 2) labels.set(id, raw);
  }
  return labels;
}

export function parseEvaluationDataset(raw: string): ParsedEvaluationDataset {
  const queries: LocalEvaluationQuery[] = [];
  const candidatesByQuery = new Map<string, string[]>();
  const queryText = new Map<string, string>();
  const noteText = new Map<string, string>();
  for (const [index, line] of raw.split('\n').entries()) {
    if (line.trim().length === 0) continue;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const queryId = typeof parsed.query_id === 'string' ? parsed.query_id : String(index);
    const candidates = stringList(parsed.candidates);
    candidatesByQuery.set(queryId, candidates);
    if (typeof parsed.query === 'string') queryText.set(queryId, parsed.query);
    if (Array.isArray(parsed.notes)) {
      for (const note of parsed.notes) {
        if (note === null || typeof note !== 'object') continue;
        const entry = note as Record<string, unknown>;
        if (typeof entry.source_hash === 'string' && typeof entry.text === 'string') {
          noteText.set(entry.source_hash, entry.text);
        }
      }
    }
    queries.push({
      query_id: queryId,
      ...(typeof parsed.query === 'string' ? { query: parsed.query } : {}),
      ...(typeof parsed.slice === 'string' ? { slice: parsed.slice } : {}),
      candidates,
      ...(parsed.graph_candidates === undefined
        ? {}
        : { graph_candidates: stringList(parsed.graph_candidates) }),
      labels: labelMap(parsed.labels),
      ...(typeof parsed.direct_answer === 'string' ? { direct_answer: parsed.direct_answer } : {}),
      ...(parsed.no_answer === true ? { no_answer: true } : {}),
      ...(parsed.fallback === true ? { fallback: true } : {}),
      ...(typeof parsed.latency_ms === 'number' ? { latency_ms: parsed.latency_ms } : {})
    });
  }
  return {
    queries,
    candidatesByQuery,
    queryText,
    noteText,
    sha256: createHash('sha256').update(raw, 'utf8').digest('hex')
  };
}

export async function readEvaluationDataset(path: string): Promise<ParsedEvaluationDataset> {
  return parseEvaluationDataset(await readFile(path, 'utf8'));
}
