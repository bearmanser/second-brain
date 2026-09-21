import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { scoreRetrieval, type RetrievalSummary } from '../eval/analyse.mjs';
import {
  MAX_PILOT_RUNS,
  MIN_NEGATIVE_QUERIES,
  MIN_POSITIVE_QUERIES,
  RECALL_TARGET,
  planPilotRuns,
  retrievalGate,
  validateCaseRecord,
  validateCorpus,
  validateRetrieval,
  type CorpusLike,
  type RetrievalLike
} from '../eval/plan.mjs';
import { startHttpHarness } from '../support/harness.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(join(REPO_ROOT, relative), 'utf8')) as T;
}

const corpus = readJson<CorpusLike>('tests/eval/corpus.json');
const retrieval = readJson<RetrievalLike>('tests/eval/retrieval.json');

function cleanMetrics(overrides: Partial<RetrievalSummary> = {}): RetrievalSummary {
  return {
    cases: 1,
    positive_cases: 1,
    negative_cases: 0,
    recall_at_5: 1,
    precision_at_5: 1,
    recall_target_met: true,
    negative_cases_passed: 0,
    negative_cases_failed: 0,
    leakage_events: 0,
    mean_elapsed_ms: 1,
    ...overrides
  };
}

test('calculates relevance using labels rather than backend scores', () => {
  expect(scoreRetrieval(['n1', 'n3'], ['n1', 'n2'])).toEqual({
    recall_at_k: 0.5,
    precision_at_k: 0.5
  });
});

test('treats duplicate ids as a single retrieved source', () => {
  expect(scoreRetrieval(['n1', 'n1', 'n2'], ['n1', 'n2'])).toEqual({
    recall_at_k: 1,
    precision_at_k: 1
  });
});

test('scores an empty positive label set by whether anything leaked', () => {
  expect(scoreRetrieval([], [])).toEqual({ recall_at_k: 1, precision_at_k: 0 });
  expect(scoreRetrieval(['n9'], [])).toEqual({ recall_at_k: 0, precision_at_k: 0 });
});

test('the SDK initialization response carries the gateway guidance', async () => {
  const harness = await startHttpHarness();
  try {
    const client = await harness.connect(harness.token, 'second-brain-eval-instructions');
    try {
      const instructions = client.getInstructions() ?? '';
      expect(instructions).toContain('brain_recall');
      expect(instructions).toContain('candidate');
      expect(instructions).toContain('untrusted data');
    } finally {
      await client.close();
    }
  } finally {
    await harness.close();
  }
});

test('the corpus has unique identities and covers every required fixture', () => {
  expect(validateCorpus(corpus)).toEqual([]);
  const keys = corpus.notes.map((note) => note.key);
  expect(new Set(keys).size).toBe(keys.length);
  for (const required of [
    'streaming-lesson',
    'routing-decision',
    'legacy-routing-superseded',
    'cache-warm-playbook',
    'batching-hypothesis',
    'quota-expired-fact',
    'profile-secret',
    'handoff-session',
    'misleading-note',
    'ttft-paraphrase'
  ]) {
    expect(keys).toContain(required);
  }
});

test('the retrieval labels are valid and meet the query minimums', () => {
  const keys = new Set(corpus.notes.map((note) => note.key));
  expect(validateRetrieval(retrieval, keys)).toEqual([]);
  const positive = retrieval.queries.filter((query) => query.label === 'positive');
  const negative = retrieval.queries.filter((query) => query.label !== 'positive');
  expect(positive.length).toBeGreaterThanOrEqual(MIN_POSITIVE_QUERIES);
  expect(negative.length).toBeGreaterThanOrEqual(MIN_NEGATIVE_QUERIES);
});

test('the pilot run plan is capped before starting', () => {
  expect(planPilotRuns(6, 2, MAX_PILOT_RUNS)).toBe(MAX_PILOT_RUNS);
  expect(planPilotRuns(6, 2, 10)).toBe(10);
  expect(planPilotRuns(100, 100, 1000)).toBe(MAX_PILOT_RUNS);
  expect(planPilotRuns(0, 2, MAX_PILOT_RUNS)).toBe(0);
});

test('the retrieval gate fails on leaks, negative failures, failed cases, and low recall', () => {
  expect(retrievalGate(cleanMetrics(), [{ outcome: 'pass', leaked: false }]).ok).toBe(true);
  expect(retrievalGate(cleanMetrics({ leakage_events: 1 }), [{ outcome: 'pass', leaked: true }]).ok).toBe(false);
  expect(retrievalGate(cleanMetrics({ negative_cases_failed: 1 }), [{ outcome: 'pass', leaked: false }]).ok).toBe(false);
  expect(retrievalGate(cleanMetrics(), [{ outcome: 'fail', leaked: false }]).ok).toBe(false);
  expect(retrievalGate(cleanMetrics({ recall_at_5: RECALL_TARGET - 0.01 }), [{ outcome: 'pass', leaked: false }]).ok).toBe(false);
  expect(retrievalGate(cleanMetrics({ recall_at_5: 0.5 }), [{ outcome: 'pass', leaked: false }], 0.4).ok).toBe(true);
});

test('the case record schema requires the mandated fields', () => {
  const complete: Record<string, unknown> = {
    case_id: 'r01',
    memory_condition: 'enabled',
    model_identifier: null,
    client: 'second-brain-eval/0.1.0',
    retrieved_ids: [],
    tool_timeline: ['brain_recall'],
    outcome: 'pass',
    elapsed_ms: 1,
    token_usage: null
  };
  expect(validateCaseRecord(complete)).toEqual([]);
  const missing: Record<string, unknown> = { ...complete };
  delete missing.retrieved_ids;
  expect(validateCaseRecord(missing)).toContain('retrieved_ids');
  expect(validateCaseRecord({ ...complete, token_usage: 0 })).toContain('token_usage is neither null nor an object');
});
