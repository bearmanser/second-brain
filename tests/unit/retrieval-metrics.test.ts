import { expect, test } from 'vitest';
import {
  RERANK_QUESTION_ID,
  buildCrossModeReport,
  dedupeLogicalIds,
  legacyLogicalId,
  meanMetric,
  mrrAtK,
  ndcgAtK,
  noAnswerFalsePositive,
  percentile,
  recallAtK,
  retrievalQueryId,
  summariseLocalRetrieval,
  unjudgedAtK
} from '../../src/retrieval/evaluation.js';
import type { CrossModeQuery, LocalEvaluationQuery } from '../../src/retrieval/evaluation.js';

test('candidate recall measures missing relevant documents', () => {
  expect(recallAtK(new Set(['a', 'b']), ['a', 'c'], 50)).toBe(0.5);
});

test('ideal graded ordering has normalized gain one', () => {
  expect(ndcgAtK(new Map([['a', 2], ['b', 1], ['c', 0]]), ['a', 'b', 'c'], 10)).toBeCloseTo(1);
});

test('recall is not measurable when no relevant note exists', () => {
  expect(recallAtK(new Set(), ['a', 'b'], 50)).toBeNull();
});

test('recall counts a relevant note once even when a pool repeats it', () => {
  expect(recallAtK(new Set(['a', 'b']), ['a', 'a', 'b'], 50)).toBe(1);
});

test('recall stops at k', () => {
  expect(recallAtK(new Set(['b']), ['a', 'b'], 1)).toBe(0);
});

test('graded nDCG is not measurable without a positive label', () => {
  expect(ndcgAtK(new Map([['a', 0], ['b', 0]]), ['a', 'b'], 10)).toBeNull();
  expect(ndcgAtK(new Map(), ['a'], 10)).toBeNull();
});

test('an unjudged top result never lifts nDCG above the judged ideal', () => {
  const labels = new Map<string, 0 | 1 | 2>([['known', 2]]);
  expect(ndcgAtK(labels, ['unknown', 'known'], 10)).toBeLessThan(1);
  expect(ndcgAtK(labels, ['unknown', 'known'], 10)).toBeCloseTo((3 / Math.log2(3)) / 3);
});

test('unjudged candidates are counted rather than scored as negatives', () => {
  const labels = new Map<string, 0 | 1 | 2>([['a', 2]]);
  expect(unjudgedAtK(labels, ['a', 'b', 'c'], 50)).toBe(2);
  expect(unjudgedAtK(labels, ['a', 'b', 'c'], 1)).toBe(0);
});

test('MRR reports the rank of the first relevant direct answer', () => {
  expect(mrrAtK(new Set(['b']), ['a', 'b', 'c'], 10)).toBeCloseTo(0.5);
  expect(mrrAtK(new Set(['z']), ['a', 'b'], 10)).toBe(0);
  expect(mrrAtK(new Set(), ['a'], 10)).toBeNull();
});

test('means ignore unmeasurable queries instead of treating them as zero', () => {
  expect(meanMetric([1, null, 0.5])).toBeCloseTo(0.75);
  expect(meanMetric([null, null])).toBeNull();
});

test('percentiles use nearest-rank over finite latency samples', () => {
  expect(percentile([10, 20, 30, 40], 0.5)).toBe(20);
  expect(percentile([10, 20, 30, 40], 0.95)).toBe(40);
  expect(percentile([], 0.5)).toBeNull();
});

test('no-answer false positives are measured separately from recall', () => {
  expect(noAnswerFalsePositive([], 50)).toBe(false);
  expect(noAnswerFalsePositive(['anything'], 50)).toBe(true);
});

test('local retrieval summary keeps lexical and graph recall on their own bounds', () => {
  const queries: LocalEvaluationQuery[] = [
    {
      query_id: 'english-direct',
      slice: 'english',
      candidates: ['doc-a', 'doc-b'],
      labels: new Map<string, 0 | 1 | 2>([
        ['doc-a', 2],
        ['doc-b', 1]
      ]),
      direct_answer: 'doc-a',
      latency_ms: 10,
      fallback: false
    },
    {
      query_id: 'no-answer',
      slice: 'no-answer',
      candidates: ['doc-a'],
      labels: new Map<string, 0 | 1 | 2>([['doc-b', 0]]),
      no_answer: true,
      latency_ms: 30,
      fallback: true
    },
    {
      query_id: 'graph-expanded',
      slice: 'english',
      candidates: ['doc-x'],
      graph_candidates: ['doc-g', 'doc-h'],
      labels: new Map<string, 0 | 1 | 2>([
        ['doc-x', 0],
        ['doc-g', 2],
        ['doc-h', 1]
      ]),
      direct_answer: 'doc-g',
      latency_ms: 20,
      fallback: false
    }
  ];
  const metrics = summariseLocalRetrieval(queries);
  expect(metrics.queries).toBe(3);
  expect(metrics.measurable_recall).toBe(2);
  expect(metrics.candidate_recall_at_50).toBeCloseTo(0.5);
  expect(metrics.graph_recall_at_50).toBeCloseTo(0.5);
  expect(metrics.graph_recall_bound).toBe(10);
  expect(metrics.unjudged_candidates).toBe(1);
  expect(metrics.no_answer_queries).toBe(1);
  expect(metrics.no_answer_false_positives).toBe(1);
  expect(metrics.fallback_rate).toBeCloseTo(1 / 3);
  expect(metrics.latency_p50_ms).toBe(20);
  expect(metrics.latency_p95_ms).toBe(30);
  expect(metrics.by_slice.english?.queries).toBe(2);
  expect(metrics.by_slice.english?.candidate_recall_at_50).toBeCloseTo(0.5);
  expect(metrics.by_slice['no-answer']?.no_answer_false_positives).toBe(1);
  expect(metrics.by_slice['no-answer']?.measurable_recall).toBe(0);
});

test('retrieval query identifiers are stable across whitespace and case but split distinct questions', () => {
  expect(retrievalQueryId({ query: '  Hello   World ' })).toBe(
    retrievalQueryId({ query: 'hello world' })
  );
  expect(retrievalQueryId({ query: 'a' })).not.toBe(retrievalQueryId({ query: 'b' }));
  expect(retrievalQueryId({ query: 'x', kinds: ['decision', 'fact'] })).toBe(
    retrievalQueryId({ query: 'x', kinds: ['fact', 'decision'] })
  );
});

test('legacy revision paths map to the same logical id and dedupe repeats', () => {
  const mapping = new Map([
    ['revision-1', 'logical-1'],
    ['History/Old.md', 'logical-2']
  ]);
  expect(legacyLogicalId({ revision_id: 'revision-1' }, mapping)).toBe('logical-1');
  expect(legacyLogicalId({ path: 'History/Old.md' }, mapping)).toBe('logical-2');
  expect(legacyLogicalId({ logical_id: 'logical-3', path: 'ignored.md' }, mapping)).toBe('logical-3');
  expect(dedupeLogicalIds(['a', undefined, 'a', '', 'b'])).toEqual(['a', 'b']);
});

function comparisonQueries(): CrossModeQuery[] {
  return [
    {
      query_id: 'direct',
      slice: 'english',
      labels: new Map<string, 0 | 1 | 2>([
        ['doc-a', 2],
        ['doc-b', 1]
      ]),
      eligible: ['doc-a', 'doc-b', 'doc-c'],
      direct_answer: 'doc-a',
      modes: [
        { mode: 'local_text', ranked: ['doc-a', 'doc-b'], available: true, latency_ms: 10 },
        {
          mode: 'local_text_graph',
          ranked: ['doc-a', 'doc-b', 'doc-c'],
          graph_ranked: ['doc-c'],
          available: true,
          latency_ms: 11
        },
        {
          mode: 'laya_reranked',
          ranked: ['doc-a', 'doc-b'],
          available: true,
          fallback: true,
          latency_ms: 12
        }
      ]
    },
    {
      query_id: 'none',
      slice: 'no-answer',
      labels: new Map<string, 0 | 1 | 2>([['doc-c', 0]]),
      eligible: ['doc-c'],
      no_answer: true,
      modes: [
        { mode: 'local_text', ranked: ['doc-c'], available: true, latency_ms: 20 },
        { mode: 'local_text_graph', ranked: ['doc-c'], graph_ranked: [], available: true, latency_ms: 21 },
        { mode: 'laya_reranked', ranked: ['doc-c'], available: true, fallback: true, latency_ms: 22 }
      ]
    }
  ];
}

test('the cross-mode harness reports every mode on the frozen eligible universe', () => {
  const report = buildCrossModeReport(comparisonQueries(), {
    model_artifacts_available: false,
    rss_bytes: 123456
  });
  expect(report.universe).toEqual({ queries: 2, documents: 3 });
  expect(report.modes.legacy_baseline.available).toBe(true);
  expect(report.modes.legacy_baseline.candidate_recall_at_50).toBeNull();
  expect(report.legacy_baseline.recall_at_5).toBe(0.9286);
  expect(report.legacy_baseline.mean_elapsed_ms).toBe(44.8);
  expect(report.legacy_baseline.corpus_sha256).toBe(
    '5d6ef74fc946144fca514621fd38461a3f73450d1415ea5bbbfe1d73c845569e'
  );
  expect(report.modes.local_text.candidate_recall_at_50).toBeCloseTo(1);
  expect(report.modes.local_text.ndcg_at_10).toBeCloseTo(1);
  expect(report.modes.local_text.mrr).toBeCloseTo(1);
  expect(report.modes.local_text.graph_recall_at_50).toBeNull();
  expect(report.modes.local_text_graph.candidate_recall_at_50).toBeCloseTo(1);
  expect(report.modes.local_text_graph.graph_recall_at_50).toBeCloseTo(0);
  expect(report.modes.local_text_graph.graph_recall_bound).toBe(10);
  expect(report.modes.laya_reranked.fallback_rate).toBeCloseTo(1);
  expect(report.modes.laya_reranked.model_backed).toBe(false);
  expect(report.modes.local_text.rss_bytes_peak).toBe(123456);
  expect(report.modes.local_text.latency_p50_ms).toBe(10);
  expect(report.modes.local_text.latency_p95_ms).toBe(20);
  expect(report.not_run).toContain('laya_reranked');
  expect(report.by_slice.local_text.english?.queries).toBe(1);
  expect(report.by_slice.local_text['no-answer']?.measurable_recall).toBe(0);
  expect(RERANK_QUESTION_ID).toBe('note_relevance');
});
