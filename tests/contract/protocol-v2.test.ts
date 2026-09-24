import { expect, test } from 'vitest';
import {
  captureRequestSchema,
  captureRequestSchemaV2,
  noteReferenceSchema,
  readRequestSchema,
  recallRequestSchema,
  reviewRequestSchema,
  reviewRequestSchemaV2
} from '../../src/contracts/protocol.js';
import { notePathSchema, noteInputSchemaV2 } from '../../src/contracts/content.js';
import { RECALL_MODES } from '../../src/core/types.js';

const ID = '44b093c5-71db-4785-b9a5-bb8118304278';
const ETAG = 'a'.repeat(64);

const baseNote = {
  title: 'Decision note',
  tags: ['retrieval'],
  content: { kind: 'decision', context: 'c', decision: 'd', rationale: 'r' },
  evidence: [],
  related_ids: []
};

const flexibleNote = {
  title: 'Research note',
  tags: ['retrieval'],
  content: { kind: 'note', summary: 's', body_markdown: '# Research note\n' },
  evidence: [],
  related_ids: []
};

test('a read reference has exactly one selector', () => {
  expect(noteReferenceSchema.safeParse({ path: 'Knowledge/Laya.md' }).success).toBe(true);
  expect(noteReferenceSchema.safeParse({ title: 'Laya' }).success).toBe(true);
  expect(noteReferenceSchema.safeParse({ id: ID }).success).toBe(true);
  expect(
    noteReferenceSchema.safeParse({ id: ID, path: 'Knowledge/Laya.md' }).success
  ).toBe(false);
  expect(noteReferenceSchema.safeParse({}).success).toBe(false);
});

test('brain_read rejects ambiguous selectors and requires a managed id for history', () => {
  expect(readRequestSchema.safeParse({ path: 'Knowledge/Laya.md' }).success).toBe(true);
  expect(readRequestSchema.safeParse({ title: 'Laya' }).success).toBe(true);
  expect(readRequestSchema.safeParse({ id: ID, title: 'Laya' }).success).toBe(false);
  expect(readRequestSchema.safeParse({}).success).toBe(false);
  expect(readRequestSchema.safeParse({ path: 'Knowledge/Laya.md', revision_id: ID }).success).toBe(
    false
  );
  expect(readRequestSchema.safeParse({ id: ID, revision_id: ID }).success).toBe(true);
});

test('brain_recall accepts text, reranked, and the deprecated hybrid alias', () => {
  expect(RECALL_MODES).toEqual(['text', 'reranked', 'hybrid']);
  for (const mode of RECALL_MODES) {
    expect(recallRequestSchema.safeParse({ query: 'alpha', mode }).success).toBe(true);
  }
  expect(recallRequestSchema.safeParse({ query: 'alpha', mode: 'semantic' }).success).toBe(false);
});

test('brain_review accepts explicit move and adopt actions', () => {
  const move = reviewRequestSchema.safeParse({
    operation: {
      action: 'move',
      idempotency_key: ID,
      id: ID,
      target_path: 'Knowledge/Moved.md',
      expected_etag: 'a'.repeat(64),
      rationale: 'relocate'
    }
  });
  expect(move.success).toBe(true);
  const adopt = reviewRequestSchema.safeParse({
    operation: {
      action: 'adopt',
      idempotency_key: ID,
      path: 'Knowledge/Plain.md',
      expected_etag: 'a'.repeat(64),
      rationale: 'adopt a plain note'
    }
  });
  expect(adopt.success).toBe(true);
});

test('legacy capture validation stays bound to the frozen V1 schema', () => {
  expect(captureRequestSchema.safeParse({ idempotency_key: ID, note: baseNote }).success).toBe(true);
  expect(
    captureRequestSchema.safeParse({ idempotency_key: ID, note: { ...baseNote, type: 'decision' } })
      .success
  ).toBe(false);
  expect(
    captureRequestSchema.safeParse({ idempotency_key: ID, note: { ...baseNote, source: 'self' } })
      .success
  ).toBe(false);
  expect(
    captureRequestSchemaV2.safeParse({
      idempotency_key: ID,
      note: {
        ...baseNote,
        content: { kind: 'note', summary: 's', body_markdown: '# s\n' },
        type: 'research'
      }
    }).success
  ).toBe(true);
});

test('V2 capture accepts the additive type/source fields and enforces the type/content relationship', () => {
  expect(
    captureRequestSchemaV2.safeParse({
      idempotency_key: ID,
      note: { ...baseNote, type: 'decision', source: 'self-reported' }
    }).success
  ).toBe(true);
  expect(
    captureRequestSchemaV2.safeParse({ idempotency_key: ID, note: { ...flexibleNote, type: 'research' } })
      .success
  ).toBe(true);
  expect(
    captureRequestSchemaV2.safeParse({ idempotency_key: ID, note: { ...baseNote, type: 'research' } })
      .success
  ).toBe(false);
  expect(
    captureRequestSchemaV2.safeParse({ idempotency_key: ID, note: { ...flexibleNote, type: 'decision' } })
      .success
  ).toBe(false);
  expect(noteInputSchemaV2.safeParse({ ...baseNote, type: 'not-a-type' }).success).toBe(false);
});

test('V2 review carries the additive note fields while the legacy review schema does not', () => {
  const legacy = reviewRequestSchema.safeParse({
    operation: {
      action: 'revise',
      idempotency_key: ID,
      id: ID,
      expected_etag: ETAG,
      rationale: 'revise',
      note: { ...baseNote, type: 'decision' }
    }
  });
  expect(legacy.success).toBe(false);
  const v2 = reviewRequestSchemaV2.safeParse({
    operation: {
      action: 'revise',
      idempotency_key: ID,
      id: ID,
      expected_etag: ETAG,
      rationale: 'revise',
      note: { ...baseNote, type: 'decision', source: 'self' }
    }
  });
  expect(v2.success).toBe(true);
});

test('the shared note path contract matches the vault constraints', () => {
  expect(notePathSchema.safeParse('Knowledge/Laya.md').success).toBe(true);
  expect(notePathSchema.safeParse('Projects/Second Brain/Research/Læring.md').success).toBe(true);
  expect(notePathSchema.safeParse('/Knowledge/Laya.md').success).toBe(false);
  expect(notePathSchema.safeParse('Knowledge\\Laya.md').success).toBe(false);
  expect(notePathSchema.safeParse('Knowledge/.hidden/Laya.md').success).toBe(false);
  expect(notePathSchema.safeParse('Knowledge/Laya').success).toBe(false);
  expect(notePathSchema.safeParse('Knowledge/Laya\u0007.md').success).toBe(false);
  expect(notePathSchema.safeParse('Knowledge/../Laya.md').success).toBe(false);
});

test('read, move, and adopt agree on the shared note path contract', () => {
  expect(readRequestSchema.safeParse({ path: 'Knowledge/Laya' }).success).toBe(false);
  expect(
    reviewRequestSchema.safeParse({
      operation: {
        action: 'move',
        idempotency_key: ID,
        id: ID,
        target_path: '.hidden/Moved.md',
        expected_etag: ETAG,
        rationale: 'relocate'
      }
    }).success
  ).toBe(false);
  expect(
    reviewRequestSchema.safeParse({
      operation: {
        action: 'adopt',
        idempotency_key: ID,
        path: 'Knowledge/Plain',
        expected_etag: ETAG,
        rationale: 'adopt'
      }
    }).success
  ).toBe(false);
  expect(readRequestSchema.safeParse({ path: 'Knowledge/Laya.md' }).success).toBe(true);
  expect(
    reviewRequestSchema.safeParse({
      operation: {
        action: 'move',
        idempotency_key: ID,
        id: ID,
        target_path: 'Knowledge/Moved.md',
        expected_etag: ETAG,
        rationale: 'relocate'
      }
    }).success
  ).toBe(true);
});

test('read, move, and adopt never silently change the identity of a supplied path', () => {
  const paths = [' Knowledge/Laya.md', 'Knowledge/Laya.md ', 'Knowledge/ Laya.md'];
  for (const path of paths) {
    const accepted = notePathSchema.safeParse(path);
    const read = readRequestSchema.safeParse({ path });
    const move = reviewRequestSchemaV2.safeParse({
      operation: {
        action: 'move', idempotency_key: ID, id: ID, target_path: path,
        expected_etag: ETAG, rationale: 'relocate'
      }
    });
    const adopt = reviewRequestSchemaV2.safeParse({
      operation: {
        action: 'adopt', idempotency_key: ID, path,
        expected_etag: ETAG, rationale: 'adopt'
      }
    });
    for (const result of [accepted, read, move, adopt]) {
      if (result.success) {
        const parsed = result.data as string | { path?: string; operation?: { path?: string; target_path?: string } };
        expect(typeof parsed === 'string' ? parsed : parsed.path ?? parsed.operation?.path ?? parsed.operation?.target_path).toBe(path);
      }
    }
    if (path.startsWith(' ') || path.endsWith(' ')) {
      expect(accepted.success).toBe(false);
      expect(read.success).toBe(false);
      expect(move.success).toBe(false);
      expect(adopt.success).toBe(false);
    }
  }
});
