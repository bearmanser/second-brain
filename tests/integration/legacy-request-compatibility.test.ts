import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  LEGACY_WARNING_HYBRID_DEPRECATED,
  LEGACY_WARNING_INCLUDE_SHARED_DEPRECATED,
  normalizeRecallMode,
  normalizeRecallRequest,
  normalizeRecallScope
} from '../../src/contracts/compatibility.js';
import { SYSTEM_ACTOR, type AuthenticatedContext, type NoteInput } from '../../src/core/types.js';
import type { LayaCandidate, LayaScoreResult } from '../../src/retrieval/laya-protocol.js';
import type { RerankWorker, RerankWorkerHealth } from '../../src/retrieval/reranker.js';
import { startLocalHttpHarness } from '../support/harness.js';

const WORKER_FINGERPRINT = 'f'.repeat(64);

class StubWorker implements RerankWorker {
  health(): RerankWorkerHealth {
    return {
      state: 'ready',
      model_fingerprint: WORKER_FINGERPRINT,
      question_version: 'relevance-2026-09-23.1'
    };
  }

  async score(input: {
    request_id: string;
    query: string;
    candidates: readonly LayaCandidate[];
    signal?: AbortSignal;
  }): Promise<LayaScoreResult> {
    return {
      model_fingerprint: WORKER_FINGERPRINT,
      question_version: 'relevance-2026-09-23.1',
      scores: input.candidates.map((candidate) => ({
        chunk_key: candidate.chunk_key,
        probabilities: { A: 0.5, B: 0, C: 0.5 },
        input_tokens: 4,
        truncated: false
      }))
    };
  }
}

function localContext(): AuthenticatedContext {
  return { actor: SYSTEM_ACTOR, request_id: randomUUID(), signal: new AbortController().signal };
}

function memoryNote(title: string, marker: string): NoteInput {
  return {
    title,
    tags: ['legacy-compat'],
    content: { kind: 'note', summary: marker, body_markdown: `# ${title}\n\n${marker}\n` },
    evidence: [],
    related_ids: []
  };
}

const canonical: Record<string, string> = {
  freellmapi: 'freellmapi',
  'github.com/example/freellmapi': 'freellmapi',
  'free-llm-api': 'freellmapi',
  shared: 'shared',
  profile: 'profile'
};

const lookup = {
  canonicalId: (identifier: string) => canonical[identifier]
};

test('an old scope is an organization alias, never an access right', () => {
  const normalized = normalizeRecallScope({ scope: 'freellmapi' }, lookup);
  expect(normalized.filter).toEqual({ mode: 'project', identifier: 'freellmapi' });
  expect(normalized.include_shared).toBe(false);
});

test('an unknown legacy scope is a clear error and never widens the query', () => {
  try {
    normalizeRecallScope({ scope: 'not-a-project' }, lookup);
    throw new Error('expected an unknown-scope error');
  } catch (error) {
    expect((error as { code?: string }).code).toBe('NOT_FOUND');
    expect((error as Error).message).toContain('not-a-project');
  }
});

test('include_shared selects the shared category for scope-only and project-filtered requests', () => {
  for (const input of [
    { project: 'freellmapi', include_shared: true },
    { scope: 'freellmapi', include_shared: true }
  ]) {
    const normalized = normalizeRecallScope(input, lookup);
    expect(normalized.filter).toEqual({ mode: 'project', identifier: 'freellmapi' });
    expect(normalized.selected_shared).toBe(true);
    expect(normalized.warnings).toContain(LEGACY_WARNING_INCLUDE_SHARED_DEPRECATED);
  }
});

test('include_shared changes nothing for a whole-brain request', () => {
  const normalized = normalizeRecallScope({ include_shared: true }, lookup);
  expect(normalized.filter).toEqual({ mode: 'all' });
  expect(normalized.selected_shared).toBe(false);
});

test('the shared category is not added when the request already targets shared', () => {
  const normalized = normalizeRecallScope(
    { project: 'shared', include_shared: true },
    lookup
  );
  expect(normalized.selected_shared).toBe(false);
});

test('a repository-identity alias resolves to the canonical project id', () => {
  const normalized = normalizeRecallScope({ scope: 'github.com/example/freellmapi' }, lookup);
  expect(normalized.filter).toEqual({ mode: 'project', identifier: 'freellmapi' });
});

test('an unknown scope is reported before a conflicting known project', () => {
  try {
    normalizeRecallScope({ project: 'profile', scope: 'not-a-project' }, lookup);
    throw new Error('expected an unknown-scope error');
  } catch (error) {
    expect((error as { code?: string }).code).toBe('NOT_FOUND');
    expect((error as Error).message).toContain('not-a-project');
  }
});

test('conflicting known project and scope aliases are rejected instead of guessed', () => {
  expect(() =>
    normalizeRecallScope({ project: 'freellmapi', scope: 'profile' }, lookup)
  ).toThrow(/different projects/);
});

test('equivalent aliases of the same project are accepted', () => {
  const normalized = normalizeRecallScope(
    { project: 'free-llm-api', scope: 'github.com/example/freellmapi' },
    lookup
  );
  expect(normalized.filter).toEqual({ mode: 'project', identifier: 'freellmapi' });
});

test('hybrid is a warned alias that executes as reranked', () => {
  const normalized = normalizeRecallMode('hybrid');
  expect(normalized.requested).toBe('hybrid');
  expect(normalized.executed).toBe('reranked');
  expect(normalized.warnings.join(' ')).toContain(LEGACY_WARNING_HYBRID_DEPRECATED);

  expect(normalizeRecallMode('text').executed).toBe('text');
  expect(normalizeRecallMode(undefined).executed).toBe('text');
  expect(normalizeRecallMode('reranked').deprecated).toBe(false);
});

test('normalizeRecallRequest combines the canonical filter and the executed mode', () => {
  const normalized = normalizeRecallRequest(
    { scope: 'github.com/example/freellmapi', include_shared: true, mode: 'hybrid' },
    lookup
  );
  expect(normalized.filter).toEqual({ mode: 'project', identifier: 'freellmapi' });
  expect(normalized.selected_shared).toBe(true);
  expect(normalized.requested_mode).toBe('hybrid');
  expect(normalized.mode).toBe('reranked');
  expect(normalized.warnings.join(' ')).toContain(LEGACY_WARNING_HYBRID_DEPRECATED);
  expect(normalized.warnings).toContain(LEGACY_WARNING_INCLUDE_SHARED_DEPRECATED);
});

test('legacy scope aliases, include_shared, and hybrid execute against the V2 runtime', async () => {
  const h = await startLocalHttpHarness({ worker: new StubWorker() });
  try {
    const ctx = localContext();
    const services = h.runtime.services;
    const marker = `legacy compatibility marker ${randomUUID()}`;

    const projectNote = await services.capture(ctx, {
      idempotency_key: randomUUID(),
      project: 'freellmapi',
      note: memoryNote('Legacy project note', marker)
    });
    await services.review(ctx, {
      operation: {
        action: 'approve',
        idempotency_key: randomUUID(),
        id: projectNote.id,
        expected_etag: projectNote.etag as string,
        rationale: 'approve the legacy project note'
      }
    });

    const sharedNote = await services.capture(ctx, {
      idempotency_key: randomUUID(),
      project: 'shared',
      note: memoryNote('Legacy shared note', marker)
    });
    await services.review(ctx, {
      operation: {
        action: 'approve',
        idempotency_key: randomUUID(),
        id: sharedNote.id,
        expected_etag: sharedNote.etag as string,
        rationale: 'approve the legacy shared note'
      }
    });

    const whole = await services.recall(ctx, { query: marker });
    const ids = (result: { items: { id: string }[] }): string[] =>
      [...new Set(result.items.map((item) => item.id))].sort();
    expect(ids(whole)).toEqual([projectNote.id, sharedNote.id].sort());

    const narrowed = await services.recall(ctx, { scope: 'freellmapi', query: marker });
    expect(ids(narrowed)).toEqual([projectNote.id]);

    const alias = await services.recall(ctx, { scope: 'free-llm-api', query: marker });
    expect(ids(alias)).toEqual([projectNote.id]);

    const withShared = await services.recall(ctx, {
      scope: 'freellmapi',
      include_shared: true,
      query: marker
    });
    expect(withShared.warnings).toContain(LEGACY_WARNING_INCLUDE_SHARED_DEPRECATED);
    expect(ids(withShared)).toEqual([projectNote.id, sharedNote.id].sort());
    expect(withShared.partial).toBe(false);

    const hybrid = await services.recall(ctx, { query: marker, mode: 'hybrid' });
    expect(hybrid.mode).toBe('reranked');
    expect(hybrid.warnings.some((warning) => warning.startsWith(LEGACY_WARNING_HYBRID_DEPRECATED))).toBe(
      true
    );
  } finally {
    await h.close();
  }
});

test('an unknown legacy scope fails clearly on the V2 runtime and never widens the search', async () => {
  const h = await startLocalHttpHarness();
  try {
    const ctx = localContext();
    const services = h.runtime.services;
    const marker = `unknown scope marker ${randomUUID()}`;
    const receipt = await services.capture(ctx, {
      idempotency_key: randomUUID(),
      project: 'freellmapi',
      note: memoryNote('Unknown scope note', marker)
    });
    await services.review(ctx, {
      operation: {
        action: 'approve',
        idempotency_key: randomUUID(),
        id: receipt.id,
        expected_etag: receipt.etag as string,
        rationale: 'approve before the unknown-scope recall'
      }
    });

    const whole = await services.recall(ctx, { query: marker });
    expect(whole.items.map((item) => item.id)).toContain(receipt.id);

    await expect(services.recall(ctx, { scope: 'ghost-project', query: marker })).rejects.toMatchObject({
      code: 'NOT_FOUND'
    });
  } finally {
    await h.close();
  }
});
