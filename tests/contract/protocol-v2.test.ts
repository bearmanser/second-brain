import { expect, test } from 'vitest';
import {
  noteReferenceSchema,
  readRequestSchema,
  recallRequestSchema,
  reviewRequestSchema
} from '../../src/contracts/protocol.js';
import { RECALL_MODES } from '../../src/core/types.js';

const ID = '44b093c5-71db-4785-b9a5-bb8118304278';

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
