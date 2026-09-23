import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { createHarness, type MemoryHarness } from '../support/harness.js';

const KEY = '00000000-0000-4000-8000-000000000131';
const OPERATION_A = '00000000-0000-4000-8000-000000000041';
const OPERATION_B = '00000000-0000-4000-8000-000000000042';
const TIMESTAMP = '2026-09-23T09:00:00.000Z';

function insertLegacyAmbiguous(h: MemoryHarness): void {
  const database = new Database(join(h.deps.config.mounts.state, 'journal.db'));
  try {
    database.pragma('foreign_keys = ON');
    const insertOperation = database.prepare(
      `INSERT INTO operations (
        operation_id, principal_id, idempotency_key, tool, scope, payload_hash,
        payload_json, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insertOperation.run(
      OPERATION_A,
      'legacy-a',
      KEY,
      'brain_capture',
      'freellmapi',
      'a'.repeat(64),
      '{}',
      'submitted',
      TIMESTAMP,
      TIMESTAMP
    );
    insertOperation.run(
      OPERATION_B,
      'legacy-b',
      KEY,
      'brain_capture',
      'freellmapi',
      'b'.repeat(64),
      '{}',
      'submitted',
      TIMESTAMP,
      TIMESTAMP
    );
    database
      .prepare(
        "INSERT INTO brain_idempotency_keys (idempotency_key, origin, resolution) VALUES (?, 'legacy', 'unresolved')"
      )
      .run(KEY);
    database
      .prepare(
        "INSERT INTO legacy_idempotency_members (idempotency_key, record_kind, record_id) VALUES (?, 'operation', ?)"
      )
      .run(KEY, OPERATION_A);
    database
      .prepare(
        "INSERT INTO legacy_idempotency_members (idempotency_key, record_kind, record_id) VALUES (?, 'operation', ?)"
      )
      .run(KEY, OPERATION_B);
  } finally {
    database.close();
  }
}

test('ambiguous legacy pending groups cause zero backend writes during recovery', async () => {
  const h = await createHarness();
  try {
    const before = h.backend.create_calls.length;
    insertLegacyAmbiguous(h);
    const report = await h.deps.mutations.recoverDetailed();
    expect(h.backend.create_calls.length).toBe(before);
    expect(report.blocking_operations.length).toBeGreaterThan(0);
    expect(report.finalized).toBe(0);
    expect(h.deps.journal.isKeyBlocked(KEY)).toBe(true);
  } finally {
    await h.close();
  }
});
