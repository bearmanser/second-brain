import { expect, test } from 'vitest';
import {
  meanMetric,
  mrrAtK,
  ndcgAtK,
  noAnswerFalsePositive,
  percentile,
  recallAtK,
  summariseLocalRetrieval,
  unjudgedAtK
} from '../../src/retrieval/evaluation.js';
import type { LocalEvaluationQuery } from '../../src/retrieval/evaluation.js';

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
});
