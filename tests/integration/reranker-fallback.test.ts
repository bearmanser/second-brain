import { expect, test } from 'vitest';
import type { LayaCandidate, LayaScoreResult } from '../../src/retrieval/laya-protocol.js';
import type { Candidate } from '../../src/retrieval/query.js';
import {
  RERANKER_UNAVAILABLE,
  rerankCandidates,
  type RerankWorker,
  type RerankWorkerHealth
} from '../../src/retrieval/reranker.js';
import { openSearchIndex, type SearchIndex } from '../../src/storage/search-index.js';

const FINGERPRINT = 'f'.repeat(64);

function indexed(): { index: SearchIndex; lexical: Candidate[] } {
  const index = openSearchIndex(':memory:');
  index.replaceDocument({ path: 'Knowledge/Three.md', raw: '# Three\n\nalpha three term\n', etag: 'v1' });
  index.replaceDocument({ path: 'Knowledge/One.md', raw: '# One\n\nalpha one term\n', etag: 'v1' });
  index.replaceDocument({ path: 'Knowledge/Two.md', raw: '# Two\n\nalpha two term\n', etag: 'v1' });
  const lexical = index.candidates({ query: 'alpha', limit: 50 });
  return { index, lexical };
}

function probabilities(score: number): { A: number; B: number; C: number } {
  return { A: score, B: 0, C: 1 - score };
}

class FakeWorker implements RerankWorker {
  constructor(private readonly behaviour: (candidates: readonly LayaCandidate[]) => Promise<LayaScoreResult>) {}
  health(): RerankWorkerHealth {
    return { state: 'ready', model_fingerprint: FINGERPRINT, question_version: 'relevance-2026-09-23.1' };
  }
  score(input: { request_id: string; query: string; candidates: readonly LayaCandidate[] }): Promise<LayaScoreResult> {
    return this.behaviour(input.candidates);
  }
}

test('reranking reverses a scored candidate set while preserving every source field', async () => {
  const { index, lexical } = indexed();
  try {
    expect(lexical.length).toBeGreaterThan(1);
    const worker = new FakeWorker((candidates) =>
      Promise.resolve({
        model_fingerprint: FINGERPRINT,
        question_version: 'relevance-2026-09-23.1',
        scores: candidates.map((entry, position) => ({
          chunk_key: entry.chunk_key,
          probabilities: probabilities(0.1 + 0.4 * position),
          input_tokens: 4,
          truncated: false
        }))
      })
    );
    const result = await rerankCandidates({ query: 'alpha', candidates: lexical, worker });
    expect(result.mode).toBe('reranked');
    expect(result.items.map((entry) => entry.chunk_key)).toEqual(
      [...lexical].reverse().map((entry) => entry.chunk_key)
    );
    const byKey = new Map(lexical.map((entry) => [entry.chunk_key, entry]));
    for (const item of result.items) {
      const source = byKey.get(item.chunk_key);
      expect(item.path).toBe(source?.path);
      expect(item.text).toBe(source?.text);
      expect(item.line_from).toBe(source?.line_from);
      expect(item.reasons).toEqual(source?.reasons);
    }
  } finally {
    index.close();
  }
});

test('a rerank failure returns exactly the incoming lexical order with a reasoned warning', async () => {
  const { index, lexical } = indexed();
  try {
    const worker = new FakeWorker(() =>
      Promise.reject(Object.assign(new Error('laya timeout'), { reason: 'timeout' }))
    );
    const result = await rerankCandidates({ query: 'alpha', candidates: lexical, worker });
    expect(result.mode).toBe('text');
    expect(result.items.map((entry) => entry.chunk_key)).toEqual(lexical.map((entry) => entry.chunk_key));
    expect(result.items.map((entry) => entry.text)).toEqual(lexical.map((entry) => entry.text));
    expect(result.warnings).toContain('reranker_unavailable:timeout');
    for (const item of result.items) expect(item.relevance_score).toBeUndefined();
  } finally {
    index.close();
  }
});

test('a caller that disables fallback gets RERANKER_UNAVAILABLE rather than an empty list', async () => {
  const { index, lexical } = indexed();
  try {
    const worker = new FakeWorker(() =>
      Promise.reject(Object.assign(new Error('laya disabled'), { reason: 'disabled' }))
    );
    await expect(
      rerankCandidates({ query: 'alpha', candidates: lexical, worker, allowFallback: false })
    ).rejects.toMatchObject({ code: RERANKER_UNAVAILABLE, reason: 'disabled' });
  } finally {
    index.close();
  }
});
