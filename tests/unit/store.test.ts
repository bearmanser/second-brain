import Database from 'better-sqlite3';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { Store } from '../../src/store.js';
import { scratch } from '../helpers.js';

const at = (n: number): string => new Date(n * 1000).toISOString();

test('summarizes feedback per verdict', () => {
  const store = Store.open(':memory:');
  store.addFeedback({ note_id: 'n', verdict: 'useful', reason: null, note_hash: 'h1', created_at: at(1) });
  store.addFeedback({ note_id: 'n', verdict: 'useful', reason: 'good', note_hash: 'h1', created_at: at(2) });
  store.addFeedback({ note_id: 'n', verdict: 'stale', reason: null, note_hash: 'h1', created_at: at(3) });
  store.addFeedback({ note_id: 'other', verdict: 'incorrect', reason: null, note_hash: 'x', created_at: at(4) });
  expect(store.feedbackSummary('n')).toEqual({ useful: 2, stale: 1 });
  expect(store.feedbackSummary('missing')).toEqual({});
  expect(store.latestFeedback('n')).toMatchObject({ verdict: 'stale', note_hash: 'h1' });
});

test('demotes only while the latest negative verdict matches the current hash', () => {
  const store = Store.open(':memory:');
  store.addFeedback({ note_id: 'n', verdict: 'incorrect', reason: null, note_hash: 'h1', created_at: at(1) });
  expect(store.isDemoted('n', 'h1')).toBe(true);
  expect(store.isDemoted('n', 'h2')).toBe(false);
  store.addFeedback({ note_id: 'n', verdict: 'useful', reason: null, note_hash: 'h1', created_at: at(1) });
  expect(store.isDemoted('n', 'h1')).toBe(false);
  expect(store.isDemoted('unknown', 'h1')).toBe(false);
});

test('deletes feedback for a note', () => {
  const store = Store.open(':memory:');
  store.addFeedback({ note_id: 'n', verdict: 'stale', reason: null, note_hash: 'h', created_at: at(1) });
  store.deleteFeedback('n');
  expect(store.feedbackSummary('n')).toEqual({});
});

test('reserves and reads idempotency keys, persisting across reopen', () => {
  const file = join(scratch('store'), 'brain.db');
  const store = Store.open(file);
  const row = { key: 'key-12345', payload_hash: 'p', note_id: 'n', path: 'Notes/a.md', created_at: at(1) };
  store.reserveIdempotency(row);
  expect(store.getIdempotency('key-12345')).toEqual(row);
  expect(store.getIdempotency('nope')).toBeUndefined();
  store.close();
  expect(Store.open(file).getIdempotency('key-12345')).toEqual(row);
});

test('refuses an unsupported schema version', () => {
  const file = join(scratch('store'), 'brain.db');
  const raw = new Database(file);
  raw.pragma('user_version = 7');
  raw.close();
  expect(() => Store.open(file)).toThrow(/schema version 7/);
});
