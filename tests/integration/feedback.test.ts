import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';
import type { CredentialRecord } from '../../src/config/schema.js';
import { BrainError } from '../../src/contracts/errors.js';
import {
  feedback,
  FEEDBACK_WARNING_UNRESOLVED,
  logOperational,
  retrievalEventFromRecall
} from '../../src/features/feedback.js';
import { recall } from '../../src/features/recall.js';
import { authenticate } from '../../src/security/authenticate.js';
import { redactError } from '../../src/security/redact.js';
import type { FeedbackRequest, RecallResult } from '../../src/core/types.js';
import { lessonFixture } from '../fixtures/content.js';
import { reviewerContext, reviewerPrincipal, workerContext, workerPrincipal } from '../fixtures/principals.js';
import { createHarness, type MemoryHarness } from '../support/harness.js';

const QUERY_MARKER = 'First-token latency looked worse';
const NOTE_MARKER = 'Measure the direct and proxied request';
const EVIDENCE_MARKER = 'benchmark-fixture-1';
const BEARER_TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ASSIGNMENT_SECRET = 'sk-abcdefghijklmnopqrstuvwxyz012345';
const ROTATED_TOKEN_ONE = 'rotation-token-one';
const ROTATED_TOKEN_TWO = 'rotation-token-two';

const uuid = (): string => randomUUID();

function requestFor(head: { source: { id: string; revision_id: string } }, overrides: Partial<FeedbackRequest> = {}): FeedbackRequest {
  return {
    idempotency_key: uuid(),
    scope: 'freellmapi',
    id: head.source.id,
    revision_id: head.source.revision_id,
    verdict: 'useful',
    reason: 'Prevented repeating the proxy-only benchmark',
    ...overrides
  };
}

function journalRows(h: MemoryHarness, table: string): Record<string, unknown>[] {
  const database = new Database(join(h.deps.config.mounts.state, 'journal.db'), { readonly: true });
  try {
    return database.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  } finally {
    database.close();
  }
}

function recordRetrieval(
  h: MemoryHarness,
  overrides: Partial<Parameters<MemoryHarness['deps']['journal']['recordRetrieval']>[0]> = {}
) {
  return h.deps.journal.recordRetrieval({
    retrieval_id: uuid(),
    principal_id: reviewerContext.principal.id,
    scope: 'freellmapi',
    scope_ids: ['freellmapi'],
    returned_ids: [],
    item_count: 0,
    token_used: 0,
    token_limit: 1500,
    mode: 'hybrid',
    outcome: 'ok',
    partial: false,
    duration_ms: 3,
    ...overrides
  });
}

test('repeated usefulness feedback does not create repeated evidence', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  const request = {
    idempotency_key: '33333333-3333-4333-8333-333333333333',
    scope: 'freellmapi',
    id: head.source.id,
    revision_id: head.source.revision_id,
    verdict: 'useful' as const,
    reason: 'Prevented repeating the proxy-only benchmark'
  };
  const first = await feedback(reviewerContext, request, h.deps);
  const second = await feedback(reviewerContext, request, h.deps);
  expect(second.feedback_id).toBe(first.feedback_id);
  expect(h.deps.journal.listFeedback('freellmapi')).toHaveLength(1);
  await h.close();
});

test('rejects the same key with a different verdict', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  const request = requestFor(head);
  await feedback(reviewerContext, request, h.deps);
  await expect(
    feedback(reviewerContext, { ...request, verdict: 'stale' }, h.deps)
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(h.deps.journal.listFeedback('freellmapi')).toHaveLength(1);
  await h.close();
});

test('accepts a retrieval reference that belongs to the caller and returned the revision', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  const retrieval = recordRetrieval(h, {
    returned_ids: [{ id: head.source.id, revision_id: head.source.revision_id }],
    item_count: 1
  });
  const result = await feedback(
    reviewerContext,
    requestFor(head, { retrieval_id: retrieval.retrieval_id }),
    h.deps
  );
  expect(result.recorded).toBe(true);
  const stored = h.deps.journal.getFeedback(result.feedback_id);
  expect(stored?.retrieval_id).toBe(retrieval.retrieval_id);
  await h.close();
});

test('rejects a retrieval reference that belongs to another caller', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  const retrieval = recordRetrieval(h, {
    principal_id: workerPrincipal.id,
    returned_ids: [{ id: head.source.id, revision_id: head.source.revision_id }],
    item_count: 1
  });
  await expect(
    feedback(reviewerContext, requestFor(head, { retrieval_id: retrieval.retrieval_id }), h.deps)
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await h.close();
});

test('rejects a retrieval reference that did not return the target revision', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  const retrieval = recordRetrieval(h, {
    returned_ids: [{ id: head.source.id, revision_id: uuid() }],
    item_count: 1
  });
  await expect(
    feedback(reviewerContext, requestFor(head, { retrieval_id: retrieval.retrieval_id }), h.deps)
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await h.close();
});

test('rejects a feedback request that names a stale revision', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  await expect(
    feedback(reviewerContext, requestFor(head, { revision_id: uuid() }), h.deps)
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await h.close();
});

test('rejects a feedback request against a scope the caller may not read', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  await expect(
    feedback(reviewerContext, requestFor(head, { scope: 'profile' }), h.deps)
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await h.close();
});

test('authorizes every related note and rejects an inaccessible one', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  const related = await h.seed({ ...lessonFixture, title: 'Related lesson' }, { status: 'active' });
  const accepted = await feedback(
    reviewerContext,
    requestFor(head, { related_id: related.source.id }),
    h.deps
  );
  expect(accepted.recorded).toBe(true);

  const inaccessible = await h.seed(
    { ...lessonFixture, title: 'Private profile lesson' },
    { scope: 'profile', status: 'active' }
  );
  await expect(
    feedback(reviewerContext, requestFor(head, { related_id: inaccessible.source.id }), h.deps)
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await h.close();
});

test('records an unresolved warning without archiving, rewriting, or boosting the note', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  const result = await feedback(
    reviewerContext,
    requestFor(head, { verdict: 'stale', reason: 'Superseded by a later measurement' }),
    h.deps
  );
  const stored = h.deps.journal.getFeedback(result.feedback_id);
  expect(stored?.warning).toBe(FEEDBACK_WARNING_UNRESOLVED);

  const after = await h.deps.catalogue.get('freellmapi', head.source.id);
  expect(after.revision.revision_id).toBe(head.source.revision_id);
  expect(after.source.status).toBe('active');
  expect(h.backend.create_calls).toHaveLength(0);
  await h.close();
});

test('bounds a long feedback reason in private state', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  const result = await feedback(
    reviewerContext,
    requestFor(head, { reason: 'x'.repeat(4000) }),
    h.deps
  );
  const stored = h.deps.journal.getFeedback(result.feedback_id);
  expect(stored?.reason.length).toBeLessThanOrEqual(240);
  await h.close();
});

test('rejects an obvious credential in the feedback reason', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  await expect(
    feedback(reviewerContext, requestFor(head, { reason: `api_key=${ASSIGNMENT_SECRET}` }), h.deps)
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await h.close();
});

test('does not persist or log credentials carried by a thrown backend error', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  const logged: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((value) => String(value)).join(' '));
    })
  );
  h.deps.catalogue.getRevision = async () => {
    throw new BrainError({
      code: 'BACKEND_UNAVAILABLE',
      message: `upstream rejected Authorization: Bearer ${BEARER_TOKEN}`
    });
  };
  let caught: unknown;
  try {
    await feedback(reviewerContext, requestFor(head), h.deps);
  } catch (error) {
    caught = error;
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  expect(caught).toBeInstanceOf(BrainError);
  expect((caught as BrainError).code).toBe('BACKEND_UNAVAILABLE');
  expect(JSON.stringify(redactError(caught))).not.toContain(BEARER_TOKEN);
  const audit = JSON.stringify(journalRows(h, 'audit_events'));
  expect(audit).not.toContain(BEARER_TOKEN);
  expect(audit).not.toContain(EVIDENCE_MARKER);
  expect(logged.join('\n')).not.toContain(BEARER_TOKEN);
  await h.close();
});

test('never persists the recall query in retrieval metadata', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  const result = await recall(
    reviewerContext,
    { scope: 'freellmapi', query: QUERY_MARKER, include_candidates: true },
    h.deps
  );
  expect(result.items.some((item) => item.id === head.source.id)).toBe(true);
  const event = h.deps.journal.recordRetrieval(
    retrievalEventFromRecall(reviewerContext, result, { scope: 'freellmapi', duration_ms: 2 })
  );
  const rows = JSON.stringify(journalRows(h, 'retrieval_events'));
  expect(rows).not.toContain(QUERY_MARKER);
  expect(rows).not.toContain(NOTE_MARKER);
  expect(event.returned_ids).toContainEqual({
    id: head.source.id,
    revision_id: head.source.revision_id
  });

  const accepted = await feedback(
    reviewerContext,
    requestFor(head, { retrieval_id: event.retrieval_id }),
    h.deps
  );
  expect(accepted.recorded).toBe(true);
  await h.close();
});

test('keeps feedback bound to the principal across token rotation without logging tokens', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  const digest = (token: string): string => createHash('sha256').update(token).digest('hex');
  const credentials: CredentialRecord[] = [
    { token_sha256: digest(ROTATED_TOKEN_ONE), principal: reviewerPrincipal },
    { token_sha256: digest(ROTATED_TOKEN_TWO), principal: reviewerPrincipal }
  ];
  const before = authenticate(`Bearer ${ROTATED_TOKEN_ONE}`, credentials);
  const after = authenticate(`Bearer ${ROTATED_TOKEN_TWO}`, credentials);
  expect(after.id).toBe(before.id);
  const rotatedContext = { ...reviewerContext, principal: after };
  const retrieval = recordRetrieval(h, {
    returned_ids: [{ id: head.source.id, revision_id: head.source.revision_id }],
    item_count: 1
  });
  const result = await feedback(
    rotatedContext,
    requestFor(head, { retrieval_id: retrieval.retrieval_id }),
    h.deps
  );
  expect(result.recorded).toBe(true);
  const audit = JSON.stringify([
    ...journalRows(h, 'audit_events'),
    ...journalRows(h, 'feedback_records')
  ]);
  expect(audit).not.toContain(ROTATED_TOKEN_ONE);
  expect(audit).not.toContain(ROTATED_TOKEN_TWO);
  await h.close();
});

test('normal logs never contain the query, note, token, or evidence marker', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  const logged: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((value) => String(value)).join(' '));
    })
  );
  const sinkLines: string[] = [];
  try {
    const reason = `useful: ${QUERY_MARKER} / ${NOTE_MARKER} / ${EVIDENCE_MARKER}`;
    await feedback(reviewerContext, requestFor(head, { reason }), h.deps);
    logOperational(
      (fields) => sinkLines.push(JSON.stringify(fields)),
      {
        request_id: workerContext.request_id,
        tool: 'brain_recall',
        outcome: 'ok',
        duration_ms: 5,
        note_count: 1,
        query: QUERY_MARKER,
        note: NOTE_MARKER,
        token: ASSIGNMENT_SECRET,
        evidence: EVIDENCE_MARKER
      } as never
    );
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  const combined = `${logged.join('\n')}\n${sinkLines.join('\n')}`;
  expect(combined).not.toContain(QUERY_MARKER);
  expect(combined).not.toContain(NOTE_MARKER);
  expect(combined).not.toContain(EVIDENCE_MARKER);
  expect(combined).not.toContain(ASSIGNMENT_SECRET);
  expect(combined).not.toContain(BEARER_TOKEN);
  const audit = JSON.stringify(journalRows(h, 'audit_events'));
  expect(audit).not.toContain(QUERY_MARKER);
  expect(audit).not.toContain(NOTE_MARKER);
  expect(audit).not.toContain(EVIDENCE_MARKER);
  expect(audit).not.toContain(ASSIGNMENT_SECRET);
  const storedFeedback = h.deps.journal.listFeedback('freellmapi')[0];
  expect(storedFeedback?.reason).toContain(NOTE_MARKER);
  await h.close();
});

test('prunes retrieval metadata after thirty days but keeps the feedback record', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  const retrieval = recordRetrieval(h, {
    retrieval_id: uuid(),
    returned_ids: [{ id: head.source.id, revision_id: head.source.revision_id }],
    item_count: 1,
    created_at: '2000-01-01T00:00:00.000Z'
  });
  const result = await feedback(
    reviewerContext,
    requestFor(head, { retrieval_id: retrieval.retrieval_id }),
    h.deps
  );
  expect(h.deps.journal.pruneRetrievalEvents(new Date())).toBe(1);
  expect(h.deps.journal.getRetrieval(retrieval.retrieval_id)).toBeUndefined();
  const retained = h.deps.journal.getFeedback(result.feedback_id);
  expect(retained?.retrieval_id).toBe(retrieval.retrieval_id);
  expect(retained?.revision_id).toBe(head.source.revision_id);
  await h.close();
});

test('prunes audit events after thirty days and keeps feedback until an explicit purge', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  h.deps.journal.appendAudit({
    request_id: 'old-request',
    tool: 'brain_recall',
    outcome: 'ok',
    duration_ms: 1,
    note_count: 0
  });
  expect(h.deps.journal.pruneAuditEvents(new Date())).toBe(0);
  const result = await feedback(reviewerContext, requestFor(head), h.deps);
  expect(h.deps.journal.getFeedback(result.feedback_id)).toBeDefined();

  h.deps.journal.purgeFeedback('shared');
  expect(h.deps.journal.getFeedback(result.feedback_id)).toBeDefined();
  expect(h.deps.journal.purgeFeedback('freellmapi')).toBe(1);
  expect(h.deps.journal.getFeedback(result.feedback_id)).toBeUndefined();
  await h.close();
});

test('rejects feedback against another caller retrieval even after it is pruned', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  const retrieval = recordRetrieval(h, {
    principal_id: workerPrincipal.id,
    returned_ids: [{ id: head.source.id, revision_id: head.source.revision_id }],
    created_at: '2000-01-01T00:00:00.000Z'
  });
  h.deps.journal.pruneRetrievalEvents(new Date());
  await expect(
    feedback(reviewerContext, requestFor(head, { retrieval_id: retrieval.retrieval_id }), h.deps)
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await h.close();
});

test('records retrieval metadata through a real recall result', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  const result: RecallResult = await recall(
    reviewerContext,
    { scope: 'freellmapi', query: QUERY_MARKER },
    h.deps
  );
  const event = retrievalEventFromRecall(reviewerContext, result, {
    scope: 'freellmapi',
    duration_ms: 7
  });
  expect(event.retrieval_id).toBe(result.retrieval_id);
  expect(event.principal_id).toBe(reviewerContext.principal.id);
  expect(event.mode).toBe(result.mode);
  const stored = h.deps.journal.recordRetrieval(event);
  expect(stored.token_limit).toBe(result.budget.limit);
  await h.close();
});
