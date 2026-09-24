import { expect, test } from 'vitest';
import { z } from 'zod';
import {
  noteContentSchema,
  noteInputSchema
} from '../../src/contracts/content.js';
import {
  captureRequestSchema,
  feedbackRequestSchema,
  readRequestSchema,
  recallRequestSchema,
  projectEnsureRequestSchema,
  reviewRequestSchema,
  statusRequestSchema
} from '../../src/contracts/protocol.js';
import { BRAIN_ERROR_CODES, BrainError } from '../../src/contracts/errors.js';
import {
  CONTENT_TEXT_MAX_CHARS,
  EVIDENCE_MAX_ITEMS,
  INPUT_BODY_MAX_BYTES,
  MARKDOWN_BODY_MAX_CHARS,
  READ_BUDGET_TOKENS_MAX,
  READ_BUDGET_TOKENS_MIN,
  RECALL_BUDGET_TOKENS_MAX,
  RECALL_BUDGET_TOKENS_MIN,
  RECALL_LIMIT_MAX,
  RELATED_IDS_MAX_ITEMS,
  TAGS_MAX_ITEMS,
  TITLE_MAX_CODE_POINTS
} from '../../src/core/limits.js';
import type { NoteContent, NoteInput } from '../../src/core/types.js';
import { fixtureIds, lessonFixture } from '../fixtures/content.js';
import {
  ownerContext,
  reviewerContext,
  scopeFixtures,
  workerContext
} from '../fixtures/principals.js';

test('a session does not require lesson or evidence sections', () => {
  expect(noteContentSchema.safeParse({
    kind: 'session', task: 'Measure TTFT', state: 'Direct run completed',
    next_actions: ['Run the proxied request'], session_id: 'session-a'
  }).success).toBe(true);
});

test('a playbook requires at least one step', () => {
  expect(noteContentSchema.safeParse({
    kind: 'playbook', use_when: 'Slow first output', prerequisites: [],
    steps: [], verification: ['Compare both timings']
  }).success).toBe(false);
});

const contentExamples: NoteContent[] = [
  {
    kind: 'lesson',
    situation: 'Latency regressed after the proxy was introduced.',
    lesson: 'Compare direct and proxied timings before blaming the proxy.',
    applicability: 'Synthetic streaming benchmarks.'
  },
  {
    kind: 'decision',
    context: 'The gateway needed a private backend.',
    decision: 'Use the Basic Memory adapter over private HTTP.',
    rationale: 'It preserves the documented note envelope.',
    alternatives: ['Write Markdown directly'],
    consequences: ['One more process to operate'],
    reconsider_when: 'A native SQLite backend becomes available.'
  },
  {
    kind: 'playbook',
    use_when: 'A candidate needs promotion.',
    prerequisites: ['Reviewer credential'],
    steps: ['Read the candidate', 'Check evidence', 'Approve with the exact etag'],
    verification: ['The head is active with an approval fingerprint.'],
    cautions: ['Approval is not independent verification.']
  },
  {
    kind: 'fact',
    claim: 'The pinned image reports Basic Memory 4.0.0b1.',
    applicability: 'The compatibility baseline recorded in this repository.',
    valid_until: '2027-01-01T00:00:00Z'
  },
  {
    kind: 'preference',
    preference: 'Prefer hybrid recall over text-only recall.',
    applicability: 'Routine planning and debugging.',
    source_statement_ref: 'user-statement-fixture-1',
    exceptions: ['When embeddings are unavailable and fallback is allowed.']
  },
  {
    kind: 'session',
    task: 'Implement typed contracts.',
    state: 'Schemas and fixtures are in place.',
    next_actions: ['Run the full suite'],
    session_id: 'session-contracts',
    blockers: [],
    branch: 'feat/second-brain',
    repository_ref: 'second-brain'
  },
  {
    kind: 'note',
    summary: 'Flexible note for otherwise untyped material.',
    body_markdown: '# Heading\n\nFree-form **Markdown** body.'
  }
];

const etag = 'a'.repeat(64);

const validFeedback = {
  idempotency_key: fixtureIds.idempotencyKey,
  scope: 'freellmapi',
  id: fixtureIds.note,
  revision_id: fixtureIds.revision,
  retrieval_id: fixtureIds.replacement,
  verdict: 'useful' as const,
  reason: 'The recalled lesson matched the debugging task.',
  related_id: fixtureIds.revision
};

const validCapture = {
  idempotency_key: fixtureIds.idempotencyKey,
  scope: 'freellmapi',
  note: lessonFixture
};

const reviewOperations = {
  list: { action: 'list', filter: 'candidate' },
  approve: {
    action: 'approve',
    idempotency_key: fixtureIds.idempotencyKey,
    id: fixtureIds.note,
    expected_etag: etag,
    rationale: 'The evidence supports a scoped lesson.'
  },
  archive: {
    action: 'archive',
    idempotency_key: fixtureIds.idempotencyKey,
    id: fixtureIds.note,
    expected_etag: etag,
    rationale: 'No longer relevant to this scope.'
  },
  revise: {
    action: 'revise',
    idempotency_key: fixtureIds.idempotencyKey,
    id: fixtureIds.note,
    expected_etag: etag,
    rationale: 'Tighten the applicability statement.',
    note: lessonFixture
  },
  supersede: {
    action: 'supersede',
    idempotency_key: fixtureIds.idempotencyKey,
    id: fixtureIds.note,
    expected_etag: etag,
    rationale: 'Replaced by a narrower lesson.',
    replacement_id: fixtureIds.replacement
  },
  resolve: {
    action: 'resolve',
    idempotency_key: fixtureIds.idempotencyKey,
    id: fixtureIds.note,
    expected_heads: [{ revision_id: fixtureIds.revision, etag }],
    rationale: 'Resolve the fork with the preserved heads as parents.',
    note: lessonFixture
  }
} as const;

const publishedInputSchemas = {
  brain_capture: captureRequestSchema,
  brain_recall: recallRequestSchema,
  brain_read: readRequestSchema,
  brain_review: reviewRequestSchema,
  brain_feedback: feedbackRequestSchema,
  brain_project_ensure: projectEnsureRequestSchema,
  brain_status: statusRequestSchema
} as const;

const publishedExamples: Record<keyof typeof publishedInputSchemas, unknown> = {
  brain_capture: validCapture,
  brain_recall: {
    scope: 'freellmapi',
    query: 'slow streaming startup',
    topics: ['ttft'],
    phase: 'debugging',
    kinds: ['lesson', 'decision'],
    include_shared: false,
    include_candidates: false,
    mode: 'hybrid',
    allow_text_fallback: true,
    budget_tokens: RECALL_BUDGET_TOKENS_MIN,
    limit: RECALL_LIMIT_MAX
  },
  brain_read: {
    scope: 'freellmapi',
    id: fixtureIds.note,
    revision_id: fixtureIds.revision,
    budget_tokens: READ_BUDGET_TOKENS_MIN
  },
  brain_review: { scope: 'freellmapi', operation: reviewOperations.list },
  brain_feedback: validFeedback,
  brain_project_ensure: {
    idempotency_key: fixtureIds.idempotencyKey,
    remote_url: 'git@github.com:bearmanser/second-brain.git'
  },
  brain_status: { scope: 'freellmapi', operation_id: fixtureIds.revision, include_schemas: true }
};

test('project ensure accepts only a UUID and a bounded nonempty remote URL', () => {
  expect(
    projectEnsureRequestSchema.safeParse({
      idempotency_key: fixtureIds.idempotencyKey,
      remote_url: 'https://github.com/bearmanser/second-brain.git'
    }).success
  ).toBe(true);
  expect(
    projectEnsureRequestSchema.safeParse({
      idempotency_key: fixtureIds.idempotencyKey,
      remote_url: ''
    }).success
  ).toBe(false);
  expect(
    projectEnsureRequestSchema.safeParse({
      idempotency_key: fixtureIds.idempotencyKey,
      remote_url: 'https://github.com/bearmanser/second-brain.git',
      scope: 'caller-controlled'
    }).success
  ).toBe(false);
});

test('accepts one synthetic example for every note kind', () => {
  expect(contentExamples).toHaveLength(7);
  expect(new Set(contentExamples.map((item) => item.kind)).size).toBe(7);
  for (const content of contentExamples) {
    expect(noteContentSchema.safeParse(content).success).toBe(true);
    expect(noteInputSchema.safeParse({ ...lessonFixture, content }).success).toBe(true);
  }
});

test('does not require lesson-specific content for another kind', () => {
  const session = contentExamples.find((item) => item.kind === 'session');
  expect(session).toBeDefined();
  expect(noteContentSchema.safeParse(session).success).toBe(true);
  expect(
    noteContentSchema.safeParse({
      ...session,
      situation: 'not applicable',
      lesson: 'not applicable',
      applicability: 'not applicable'
    }).success
  ).toBe(false);
  expect(
    noteContentSchema.safeParse({ kind: 'fact', claim: 'c', applicability: 'a', valid_until: null }).success
  ).toBe(false);
});

test('rejects missing required fields and unknown kinds', () => {
  expect(noteContentSchema.safeParse({ kind: 'lesson', situation: 's', applicability: 'a' }).success).toBe(false);
  expect(
    noteContentSchema.safeParse({ kind: 'playbook', use_when: 'u', prerequisites: [], verification: ['v'] }).success
  ).toBe(false);
  expect(
    noteContentSchema.safeParse({ kind: 'session', task: 't', state: 's', next_actions: ['n'] }).success
  ).toBe(false);
  expect(noteContentSchema.safeParse({ kind: 'note', summary: 's' }).success).toBe(false);
  expect(noteContentSchema.safeParse({ kind: 'unknown' }).success).toBe(false);
  expect(noteContentSchema.safeParse({ kind: 'lesson' }).success).toBe(false);
});

test('rejects reserved gateway fields and unsupported schema versions', () => {
  expect(noteInputSchema.safeParse({ ...lessonFixture, brain_status: 'active' }).success).toBe(false);
  expect(noteInputSchema.safeParse({ ...lessonFixture, brain_schema_version: 2 }).success).toBe(false);
  expect(noteInputSchema.safeParse({ ...lessonFixture, brain_id: fixtureIds.note }).success).toBe(false);
  const content = lessonFixture.content;
  expect(noteContentSchema.safeParse({ ...content, brain_status: 'active' }).success).toBe(false);
  expect(captureRequestSchema.safeParse({ ...validCapture, schema_version: 2 }).success).toBe(false);
  expect(captureRequestSchema.safeParse({ ...validCapture, brain_status: 'active' }).success).toBe(false);
  expect(
    captureRequestSchema.safeParse({ ...validCapture, note: { ...lessonFixture, brain_status: 'active' } }).success
  ).toBe(false);
});

test('bounds tags, evidence, links, and nested text arrays', () => {
  const manyTags = Array.from({ length: TAGS_MAX_ITEMS + 1 }, (_, index) => `tag-${index}`);
  const manyEvidence = Array.from({ length: EVIDENCE_MAX_ITEMS + 1 }, () => ({
    kind: 'reference' as const,
    ref: 'fixture-ref',
    description: 'synthetic evidence'
  }));
  const manyLinks = Array.from({ length: RELATED_IDS_MAX_ITEMS + 1 }, () => fixtureIds.note);
  const manyLimitations = Array.from({ length: 33 }, (_, index) => `limitation ${index}`);

  expect(noteInputSchema.safeParse({ ...lessonFixture, tags: manyTags.slice(0, TAGS_MAX_ITEMS) }).success).toBe(true);
  expect(noteInputSchema.safeParse({ ...lessonFixture, tags: manyTags }).success).toBe(false);
  expect(
    noteInputSchema.safeParse({ ...lessonFixture, evidence: manyEvidence.slice(0, EVIDENCE_MAX_ITEMS) }).success
  ).toBe(true);
  expect(noteInputSchema.safeParse({ ...lessonFixture, evidence: manyEvidence }).success).toBe(false);
  expect(
    noteInputSchema.safeParse({ ...lessonFixture, related_ids: manyLinks.slice(0, RELATED_IDS_MAX_ITEMS) }).success
  ).toBe(true);
  expect(noteInputSchema.safeParse({ ...lessonFixture, related_ids: manyLinks }).success).toBe(false);
  expect(
    noteContentSchema.safeParse({ ...lessonFixture.content, limitations: manyLimitations.slice(0, 32) }).success
  ).toBe(true);
  expect(noteContentSchema.safeParse({ ...lessonFixture.content, limitations: manyLimitations }).success).toBe(false);
});

test('enforces the 256 KiB post-parse input-body limit', () => {
  const fill = (count: number): string[] =>
    Array.from({ length: count }, () => 'x'.repeat(CONTENT_TEXT_MAX_CHARS));
  const buildSession = (nextActions: number, blockers: number): NoteInput => ({
    ...lessonFixture,
    content: {
      kind: 'session',
      task: 'boundary',
      state: 'boundary',
      next_actions: fill(nextActions),
      session_id: 'session-boundary',
      blockers: fill(blockers)
    }
  });

  const under = buildSession(31, 0);
  const over = buildSession(32, 32);
  const underBytes = Buffer.byteLength(JSON.stringify(under), 'utf8');
  const overBytes = Buffer.byteLength(JSON.stringify(over), 'utf8');

  expect(underBytes).toBeLessThanOrEqual(INPUT_BODY_MAX_BYTES);
  expect(overBytes).toBeGreaterThan(INPUT_BODY_MAX_BYTES);
  expect(noteInputSchema.safeParse(under).success).toBe(true);
  expect(noteInputSchema.safeParse(over).success).toBe(false);
});

test('counts titles in Unicode code points and bounds ordinary strings', () => {
  const astralAtLimit = '😀'.repeat(TITLE_MAX_CODE_POINTS);
  expect(noteInputSchema.safeParse({ ...lessonFixture, title: astralAtLimit }).success).toBe(true);
  expect(noteInputSchema.safeParse({ ...lessonFixture, title: `${astralAtLimit}😀` }).success).toBe(false);
  expect(noteInputSchema.safeParse({ ...lessonFixture, title: 'Aplicación 直接 streaming' }).success).toBe(true);
  expect(noteInputSchema.safeParse({ ...lessonFixture, title: '   ' }).success).toBe(false);

  const longText = 'x'.repeat(CONTENT_TEXT_MAX_CHARS + 1);
  expect(
    noteContentSchema.safeParse({ kind: 'fact', claim: longText, applicability: 'a' }).success
  ).toBe(false);
  const longBody = 'y'.repeat(MARKDOWN_BODY_MAX_CHARS + 1);
  expect(noteContentSchema.safeParse({ kind: 'note', summary: 's', body_markdown: longBody }).success).toBe(false);
});

test('distinguishes null from absent optionals', () => {
  const session = contentExamples.find((item) => item.kind === 'session');
  expect(noteContentSchema.safeParse({ ...session, blockers: undefined }).success).toBe(true);
  expect(noteContentSchema.safeParse({ ...session, blockers: null }).success).toBe(false);
  expect(noteContentSchema.safeParse({ ...lessonFixture.content, limitations: undefined }).success).toBe(true);
  expect(noteContentSchema.safeParse({ ...lessonFixture.content, limitations: null }).success).toBe(false);
  expect(
    noteContentSchema.safeParse({ kind: 'decision', context: 'c', decision: 'd', rationale: 'r', alternatives: null })
      .success
  ).toBe(false);
  expect(
    recallRequestSchema.safeParse({ scope: 'freellmapi', query: 'q', phase: null }).success
  ).toBe(false);
});

test('accepts only UTC RFC3339 timestamps and rejects explicit offsets', () => {
  expect(
    noteContentSchema.safeParse({ kind: 'fact', claim: 'c', applicability: 'a', valid_until: '2026-09-20T12:00:00Z' })
      .success
  ).toBe(true);
  expect(
    noteContentSchema.safeParse({ kind: 'fact', claim: 'c', applicability: 'a', valid_until: '2026-09-20T12:00:00+02:00' })
      .success
  ).toBe(false);
  expect(
    noteInputSchema.safeParse({
      ...lessonFixture,
      evidence: [{ kind: 'observation', ref: 'r', description: 'd', observed_at: '2026-09-20T12:00:00Z' }]
    }).success
  ).toBe(true);
  expect(
    noteInputSchema.safeParse({
      ...lessonFixture,
      evidence: [{ kind: 'observation', ref: 'r', description: 'd', observed_at: '2026-09-20T12:00:00+02:00' }]
    }).success
  ).toBe(false);
});

test('capture requires a UUID idempotency key and a known scope', () => {
  expect(captureRequestSchema.safeParse(validCapture).success).toBe(true);
  expect(captureRequestSchema.safeParse({ ...validCapture, idempotency_key: 'not-a-uuid' }).success).toBe(false);
  expect(captureRequestSchema.safeParse({ scope: 'freellmapi', note: lessonFixture }).success).toBe(false);
  expect(captureRequestSchema.safeParse({ ...validCapture, scope: 'Freellmapi' }).success).toBe(false);
  expect(captureRequestSchema.safeParse({ ...validCapture, scope: '1freellmapi' }).success).toBe(false);
});

test('recall bounds mode, kinds, phase, budget, and limit', () => {
  expect(recallRequestSchema.safeParse({ scope: 'freellmapi', query: 'q' }).success).toBe(true);
  expect(recallRequestSchema.safeParse({ scope: 'freellmapi', query: 'q', mode: 'magic' }).success).toBe(false);
  expect(recallRequestSchema.safeParse({ scope: 'freellmapi', query: 'q', kinds: ['bogus'] }).success).toBe(false);
  expect(recallRequestSchema.safeParse({ scope: 'freellmapi', query: 'q', phase: 'bogus' }).success).toBe(false);
  expect(
    recallRequestSchema.safeParse({ scope: 'freellmapi', query: 'q', budget_tokens: RECALL_BUDGET_TOKENS_MIN - 1 })
      .success
  ).toBe(false);
  expect(
    recallRequestSchema.safeParse({ scope: 'freellmapi', query: 'q', budget_tokens: RECALL_BUDGET_TOKENS_MAX + 1 })
      .success
  ).toBe(false);
  expect(recallRequestSchema.safeParse({ scope: 'freellmapi', query: 'q', limit: RECALL_LIMIT_MAX + 1 }).success).toBe(false);
  expect(recallRequestSchema.safeParse({ scope: 'freellmapi', query: 'q', session_id: 42 }).success).toBe(false);
});

test('read validates identity and pagination budget bounds', () => {
  expect(readRequestSchema.safeParse({ scope: 'freellmapi', id: fixtureIds.note }).success).toBe(true);
  expect(readRequestSchema.safeParse({ scope: 'freellmapi', id: 'nope' }).success).toBe(false);
  expect(readRequestSchema.safeParse({ scope: 'freellmapi', id: fixtureIds.note, revision_id: 'nope' }).success).toBe(false);
  expect(
    readRequestSchema.safeParse({ scope: 'freellmapi', id: fixtureIds.note, budget_tokens: READ_BUDGET_TOKENS_MIN - 1 })
      .success
  ).toBe(false);
  expect(
    readRequestSchema.safeParse({ scope: 'freellmapi', id: fixtureIds.note, budget_tokens: READ_BUDGET_TOKENS_MAX + 1 })
      .success
  ).toBe(false);
});

test('review accepts every action variant and rejects malformed mutations', () => {
  for (const operation of Object.values(reviewOperations)) {
    expect(reviewRequestSchema.safeParse({ scope: 'freellmapi', operation }).success).toBe(true);
  }
  expect(
    reviewRequestSchema.safeParse({
      scope: 'freellmapi',
      operation: { action: 'approve', idempotency_key: fixtureIds.idempotencyKey, id: fixtureIds.note, expected_etag: etag }
    }).success
  ).toBe(false);
  expect(
    reviewRequestSchema.safeParse({
      scope: 'freellmapi',
      operation: { ...reviewOperations.approve, expected_etag: 'short' }
    }).success
  ).toBe(false);
  expect(
    reviewRequestSchema.safeParse({ scope: 'freellmapi', operation: { action: 'merge', id: fixtureIds.note } }).success
  ).toBe(false);
  expect(
    reviewRequestSchema.safeParse({
      scope: 'freellmapi',
      operation: { ...reviewOperations.resolve, expected_heads: [] }
    }).success
  ).toBe(false);
  expect(
    reviewRequestSchema.safeParse({ scope: 'freellmapi', operation: reviewOperations.list, idempotency_key: fixtureIds.idempotencyKey })
      .success
  ).toBe(false);
});

test('feedback validates verdicts and related references', () => {
  expect(feedbackRequestSchema.safeParse(validFeedback).success).toBe(true);
  expect(
    feedbackRequestSchema.safeParse({ ...validFeedback, verdict: 'amazing' }).success
  ).toBe(false);
  expect(
    feedbackRequestSchema.safeParse({ ...validFeedback, revision_id: 'nope' }).success
  ).toBe(false);
});

test('status accepts an empty request and optional filters', () => {
  expect(statusRequestSchema.safeParse({}).success).toBe(true);
  expect(statusRequestSchema.safeParse({ scope: 'freellmapi', include_schemas: true }).success).toBe(true);
  expect(statusRequestSchema.safeParse({ scope: 'shared', operation_id: fixtureIds.revision }).success).toBe(true);
  expect(statusRequestSchema.safeParse({ scope: 'BAD SCOPE' }).success).toBe(false);
  expect(statusRequestSchema.safeParse({ operation_id: 'nope' }).success).toBe(false);
});

test('publishes JSON schemas and validates each registered example', () => {
  const names = Object.keys(publishedInputSchemas) as (keyof typeof publishedInputSchemas)[];
  expect(names).toHaveLength(7);
  for (const name of names) {
    const jsonSchema = z.toJSONSchema(publishedInputSchemas[name]);
    expect(jsonSchema).toMatchObject({ $schema: expect.any(String) });
    expect(publishedInputSchemas[name].safeParse(publishedExamples[name]).success).toBe(true);
  }
  const contentJson = z.toJSONSchema(noteContentSchema);
  expect(contentJson).toMatchObject({ $schema: expect.any(String) });
  const inputJson = z.toJSONSchema(noteInputSchema);
  expect(inputJson).toMatchObject({ additionalProperties: false });
});

test('defines the Section C types with stable fixture values', () => {
  expect(scopeFixtures.map((scope) => scope.id).sort()).toEqual(['freellmapi', 'profile', 'shared']);
  expect(workerContext.actor.id).toBe('system');
  expect(workerContext.signal.aborted).toBe(false);
  expect(workerContext.request_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(lessonFixture.title).toBe('Compare direct and proxied TTFT');
  expect(lessonFixture.tags).toEqual(['streaming']);
  expect(lessonFixture.related_ids).toEqual([]);
});

test('BrainError carries a stable code, retryability, and optional operation id', () => {
  expect(BRAIN_ERROR_CODES).toHaveLength(16);
  expect(BRAIN_ERROR_CODES).toContain('AMBIGUOUS_REFERENCE');
  expect(BRAIN_ERROR_CODES).toContain('INTERNAL_ERROR');
  const internal = new BrainError({
    code: 'INTERNAL_ERROR',
    message: 'the gateway could not complete the request'
  });
  expect(internal.retryable).toBe(false);
  const forbidden = new BrainError({ code: 'FORBIDDEN', message: 'worker cannot approve' });
  expect(forbidden).toBeInstanceOf(Error);
  expect(forbidden).toBeInstanceOf(BrainError);
  expect(forbidden.name).toBe('BrainError');
  expect(forbidden.code).toBe('FORBIDDEN');
  expect(forbidden.message).toContain('FORBIDDEN');
  expect(forbidden.message).toContain('worker cannot approve');
  expect(forbidden.retryable).toBe(false);
  expect(forbidden.operation_id).toBeUndefined();

  const unavailable = new BrainError({ code: 'BACKEND_UNAVAILABLE', message: 'backend is down' });
  expect(unavailable.retryable).toBe(true);

  const withOperation = new BrainError({
    code: 'CONFLICT',
    message: 'revision conflict',
    retryable: false,
    operation_id: fixtureIds.revision
  });
  expect(withOperation.operation_id).toBe(fixtureIds.revision);
});

test('lessonFixture satisfies the note input schema', () => {
  const parsed = noteInputSchema.safeParse(lessonFixture);
  expect(parsed.success).toBe(true);
});
