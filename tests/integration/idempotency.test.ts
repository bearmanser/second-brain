import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import type { BrainError } from '../../src/contracts/errors.js';
import { Journal, type OperationReservation } from '../../src/storage/journal.js';
import {
  openLegacyDatabaseAt,
  seedLegacyFeedback,
  seedLegacyOperation
} from '../support/legacy-project-fixture.js';

const KEY = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const PAYLOAD = 'a'.repeat(64);
const OTHER_PAYLOAD = 'b'.repeat(64);

function receipt(operationId: string): string {
  return JSON.stringify({
    operation_id: operationId,
    id: KEY(0xa1),
    revision_id: KEY(0xb1),
    outcome: 'stored',
    materialized: true,
    indexed: true,
    possible_duplicates: [],
    warnings: []
  });
}

function seedCapture(
  database: Database.Database,
  input: {
    operation_id: string;
    idempotency_key: string;
    principal_id?: string;
    payload_hash?: string;
    payload_json?: string;
    state?: string;
    receipt_json?: string | null;
    plan_json?: string | null;
  }
): void {
  seedLegacyOperation(database, {
    operation_id: input.operation_id,
    idempotency_key: input.idempotency_key,
    principal_id: input.principal_id ?? KEY(0x10),
    tool: 'brain_capture',
    scope: 'freellmapi',
    payload_hash: input.payload_hash ?? PAYLOAD,
    payload_json: input.payload_json ?? '{"note":"legacy"}',
    state: input.state ?? 'complete',
    receipt_json:
      input.receipt_json === undefined ? receipt(input.operation_id) : input.receipt_json,
    plan_json: input.plan_json ?? null
  });
}

interface LegacyFixture {
  journal: Journal;
  root: string;
  path: string;
}

function openSeeded(seed: (database: Database.Database) => void): LegacyFixture {
  const root = mkdtempSync(join('/tmp/opencode', 'idem-'));
  const path = join(root, 'journal.db');
  const database = openLegacyDatabaseAt(path, 8);
  seed(database);
  database.close();
  return { journal: Journal.open(path, { requireExisting: true }), root, path };
}

function dispose(fixture: LegacyFixture): void {
  fixture.journal.close();
  rmSync(fixture.root, { recursive: true, force: true });
}

function codeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return (error as BrainError).code;
  }
  return 'NO_ERROR';
}

const captureInput = (idempotencyKey: string, overrides: Partial<OperationReservation> = {}): OperationReservation => ({
  principal_id: 'system',
  idempotency_key: idempotencyKey,
  tool: 'brain_capture',
  scope: 'freellmapi',
  payload_hash: PAYLOAD,
  payload_json: '{"note":"legacy"}',
  ...overrides
});

test('replays one uniquely identified legacy key and preserves its row and receipt bytes', () => {
  const fixture = openSeeded((database) => {
    seedCapture(database, { operation_id: KEY(0x01), idempotency_key: KEY(0x101) });
  });
  try {
    const result = fixture.journal.reserve(captureInput(KEY(0x101)));
    expect(result.kind).toBe('replay');
    expect(result.record.operation_id).toBe(KEY(0x01));

    expect(codeOf(() => fixture.journal.reserve(captureInput(KEY(0x101), { payload_hash: OTHER_PAYLOAD })))).toBe(
      'IDEMPOTENCY_CONFLICT'
    );

    const probe = new Database(fixture.path, { readonly: true });
    const row = probe
      .prepare('SELECT operation_id, payload_hash, receipt_json FROM operations WHERE operation_id = ?')
      .get(KEY(0x01)) as { operation_id: string; payload_hash: string; receipt_json: string };
    probe.close();
    expect(row.payload_hash).toBe(PAYLOAD);
    expect(JSON.parse(row.receipt_json).operation_id).toBe(KEY(0x01));
  } finally {
    dispose(fixture);
  }
});

test('a legacy key reused by different principals with conflicting payloads is a permanent conflict', () => {
  const fixture = openSeeded((database) => {
    seedCapture(database, {
      operation_id: KEY(0x02),
      idempotency_key: KEY(0x102),
      principal_id: KEY(0x11),
      payload_hash: PAYLOAD
    });
    seedCapture(database, {
      operation_id: KEY(0x03),
      idempotency_key: KEY(0x102),
      principal_id: KEY(0x12),
      payload_hash: OTHER_PAYLOAD
    });
  });
  try {
    expect(codeOf(() => fixture.journal.reserve(captureInput(KEY(0x102))))).toBe(
      'IDEMPOTENCY_CONFLICT'
    );
    const probe = new Database(fixture.path, { readonly: true });
    const count = (probe.prepare('SELECT COUNT(*) AS count FROM operations').get() as { count: number })
      .count;
    const resolution = (
      probe
        .prepare('SELECT resolution FROM brain_idempotency_keys WHERE idempotency_key = ?')
        .get(KEY(0x102)) as { resolution: string }
    ).resolution;
    probe.close();
    expect(count).toBe(2);
    expect(resolution).toBe('conflict');
  } finally {
    dispose(fixture);
  }
});

test('identical legacy payloads with different receipts remain conflicting histories', () => {
  const fixture = openSeeded((database) => {
    seedCapture(database, {
      operation_id: KEY(0x04),
      idempotency_key: KEY(0x103),
      principal_id: KEY(0x13),
      payload_hash: PAYLOAD,
      receipt_json: receipt(KEY(0x04))
    });
    seedCapture(database, {
      operation_id: KEY(0x05),
      idempotency_key: KEY(0x103),
      principal_id: KEY(0x14),
      payload_hash: PAYLOAD,
      receipt_json: receipt(KEY(0x05))
    });
  });
  try {
    expect(codeOf(() => fixture.journal.reserve(captureInput(KEY(0x103))))).toBe(
      'IDEMPOTENCY_CONFLICT'
    );
  } finally {
    dispose(fixture);
  }
});

test('an operation key colliding with legacy feedback is a cross-tool conflict', () => {
  const fixture = openSeeded((database) => {
    seedCapture(database, {
      operation_id: KEY(0x06),
      idempotency_key: KEY(0x104),
      principal_id: KEY(0x15)
    });
    seedLegacyFeedback(database, {
      feedback_id: KEY(0x07),
      idempotency_key: KEY(0x104),
      principal_id: KEY(0x16),
      payload_hash: null
    });
  });
  try {
    expect(codeOf(() => fixture.journal.reserve(captureInput(KEY(0x104))))).toBe(
      'IDEMPOTENCY_CONFLICT'
    );
    expect(
      codeOf(() =>
        fixture.journal.recordFeedback({
          principal_id: 'system',
          idempotency_key: KEY(0x104),
          scope: 'freellmapi',
          logical_id: KEY(0xa1),
          revision_id: KEY(0xb1),
          verdict: 'useful',
          reason: 'cross tool'
        })
      )
    ).toBe('IDEMPOTENCY_CONFLICT');
  } finally {
    dispose(fixture);
  }
});

test('new keys are globally unique across tools and actors', () => {
  const journal = Journal.open(':memory:');
  try {
    const first = journal.reserve(captureInput(KEY(0x201)));
    expect(first.kind).toBe('new');
    expect(codeOf(() => journal.reserve(captureInput(KEY(0x201), { tool: 'brain_review' })))).toBe(
      'IDEMPOTENCY_CONFLICT'
    );
    expect(
      codeOf(() =>
        journal.recordFeedback({
          principal_id: 'system',
          idempotency_key: KEY(0x201),
          scope: 'freellmapi',
          logical_id: KEY(0xa1),
          revision_id: KEY(0xb1),
          verdict: 'useful',
          reason: 'cross tool'
        })
      )
    ).toBe('IDEMPOTENCY_CONFLICT');
  } finally {
    journal.close();
  }
});

test('the same key and payload replays across actor, token and source-label changes', () => {
  const journal = Journal.open(':memory:');
  try {
    const first = journal.reserve(captureInput(KEY(0x202), { principal_id: 'system' }));
    const replay = journal.reserve(
      captureInput(KEY(0x202), { principal_id: KEY(0x17), payload_json: '{"note":"legacy","source":"agent"}' })
    );
    expect(replay.kind).toBe('replay');
    expect(replay.record.operation_id).toBe(first.record.operation_id);
    expect(replay.record.principal_id).toBe('system');
  } finally {
    journal.close();
  }
});

test('two connections racing one key produce a single durable winner', () => {
  const root = mkdtempSync(join('/tmp/opencode', 'idem-race-'));
  const path = join(root, 'journal.db');
  try {
    const created = Journal.open(path);
    created.close();

    const left = Journal.open(path, { requireExisting: true });
    const right = Journal.open(path, { requireExisting: true });
    const results = [left.reserve(captureInput(KEY(0x203))), right.reserve(captureInput(KEY(0x203)))];
    left.close();
    right.close();

    expect(results.map((entry) => entry.kind).sort()).toEqual(['new', 'replay']);
    const winner = results[0];
    expect(results.every((entry) => entry.record.operation_id === winner.record.operation_id)).toBe(true);
    const probe = new Database(path, { readonly: true });
    const count = (probe.prepare('SELECT COUNT(*) AS count FROM operations').get() as { count: number })
      .count;
    probe.close();
    expect(count).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an aborted new reservation keeps a released fingerprint for identical retries only', () => {
  const journal = Journal.open(':memory:');
  try {
    const first = journal.reserve(captureInput(KEY(0x204)));
    journal.abort(first.record.operation_id);
    expect(journal.get(first.record.operation_id)).toBeUndefined();

    const retried = journal.reserve(captureInput(KEY(0x204)));
    expect(retried.kind).toBe('new');
    expect(retried.record.operation_id).not.toBe(first.record.operation_id);

    journal.abort(retried.record.operation_id);
    expect(codeOf(() => journal.reserve(captureInput(KEY(0x204), { payload_hash: OTHER_PAYLOAD })))).toBe(
      'IDEMPOTENCY_CONFLICT'
    );
  } finally {
    journal.close();
  }
});

test('aborting an imported legacy reservation refuses the original key', () => {
  const fixture = openSeeded((database) => {
    seedCapture(database, {
      operation_id: KEY(0x08),
      idempotency_key: KEY(0x105),
      state: 'prepared',
      receipt_json: null,
      plan_json: null
    });
  });
  try {
    fixture.journal.abort(KEY(0x08));
    expect(fixture.journal.get(KEY(0x08))?.state).toBe('failed');
    expect(codeOf(() => fixture.journal.reserve(captureInput(KEY(0x105))))).toBe(
      'IDEMPOTENCY_CONFLICT'
    );
    const fresh = fixture.journal.reserve(captureInput(KEY(0x10f)));
    expect(fresh.kind).toBe('new');
  } finally {
    dispose(fixture);
  }
});

test('a mismatching retry preserves the original binding across restart', () => {
  const fixture = openSeeded((database) => {
    seedCapture(database, { operation_id: KEY(0x20), idempotency_key: KEY(0x120) });
  });
  try {
    expect(fixture.journal.reserve(captureInput(KEY(0x120))).kind).toBe('replay');
    expect(
      codeOf(() => fixture.journal.reserve(captureInput(KEY(0x120), { payload_hash: OTHER_PAYLOAD })))
    ).toBe('IDEMPOTENCY_CONFLICT');
    const again = fixture.journal.reserve(captureInput(KEY(0x120)));
    expect(again.kind).toBe('replay');
    expect(again.record.operation_id).toBe(KEY(0x20));

    fixture.journal.close();
    const reopened = Journal.open(fixture.path, { requireExisting: true });
    try {
      expect(reopened.reserve(captureInput(KEY(0x120))).kind).toBe('replay');
      expect(
        codeOf(() => reopened.reserve(captureInput(KEY(0x120), { payload_hash: OTHER_PAYLOAD })))
      ).toBe('IDEMPOTENCY_CONFLICT');
    } finally {
      reopened.close();
    }
  } finally {
    dispose(fixture);
  }
});

test('an ambiguous legacy group with a corrupt member requires recovery', () => {
  const fixture = openSeeded((database) => {
    seedCapture(database, { operation_id: KEY(0x21), idempotency_key: KEY(0x121) });
    seedCapture(database, {
      operation_id: KEY(0x22),
      idempotency_key: KEY(0x121),
      principal_id: KEY(0x31),
      payload_hash: OTHER_PAYLOAD,
      receipt_json: '{not json'
    });
  });
  try {
    expect(codeOf(() => fixture.journal.reserve(captureInput(KEY(0x121))))).toBe(
      'RECOVERY_REQUIRED'
    );
    expect(fixture.journal.isKeyBlocked(KEY(0x121))).toBe(true);
  } finally {
    dispose(fixture);
  }
});

test('an ambiguous legacy pending group is blocked before any recovery submission', () => {
  const fixture = openSeeded((database) => {
    seedCapture(database, {
      operation_id: KEY(0x23),
      idempotency_key: KEY(0x122),
      state: 'submitted',
      receipt_json: null,
      plan_json: '{}'
    });
    seedCapture(database, {
      operation_id: KEY(0x24),
      idempotency_key: KEY(0x122),
      principal_id: KEY(0x32),
      state: 'submitted',
      receipt_json: null,
      plan_json: '{}'
    });
  });
  try {
    expect(fixture.journal.isKeyBlocked(KEY(0x122))).toBe(true);
    expect(codeOf(() => fixture.journal.reserve(captureInput(KEY(0x122))))).toBe(
      'IDEMPOTENCY_CONFLICT'
    );
  } finally {
    dispose(fixture);
  }
});

test('an unprovable truncated feedback reason requires recovery', () => {
  const principalId = KEY(0x1a);
  const idempotencyKey = KEY(0x123);
  const base = {
    principal_id: 'system',
    idempotency_key: idempotencyKey,
    scope: 'freellmapi',
    logical_id: KEY(0xa1),
    revision_id: KEY(0xb1),
    verdict: 'useful' as const
  };
  const incomingLonger = openSeeded((database) => {
    seedLegacyFeedback(database, {
      feedback_id: KEY(0x2a),
      principal_id: principalId,
      idempotency_key: idempotencyKey,
      reason: 'a'.repeat(240),
      payload_hash: null
    });
  });
  try {
    expect(
      codeOf(() => incomingLonger.journal.replayFeedback({ ...base, reason: `${'a'.repeat(240)}${'b'.repeat(40)}` }))
    ).toBe('RECOVERY_REQUIRED');
  } finally {
    dispose(incomingLonger);
  }

  const storedBoundary = openSeeded((database) => {
    seedLegacyFeedback(database, {
      feedback_id: KEY(0x2b),
      principal_id: principalId,
      idempotency_key: idempotencyKey,
      reason: 'a'.repeat(240),
      payload_hash: null
    });
  });
  try {
    expect(
      codeOf(() => storedBoundary.journal.replayFeedback({ ...base, reason: 'a'.repeat(240) }))
    ).toBe('RECOVERY_REQUIRED');
  } finally {
    dispose(storedBoundary);
  }

  const boundaryMismatch = openSeeded((database) => {
    seedLegacyFeedback(database, {
      feedback_id: KEY(0x2d),
      principal_id: principalId,
      idempotency_key: idempotencyKey,
      reason: 'a'.repeat(240),
      payload_hash: null
    });
  });
  try {
    expect(codeOf(() => boundaryMismatch.journal.replayFeedback({ ...base, reason: `b${'a'.repeat(239)}` }))).toBe(
      'IDEMPOTENCY_CONFLICT'
    );
    expect(codeOf(() => boundaryMismatch.journal.recordFeedback({ ...base, reason: `b${'a'.repeat(239)}` }))).toBe(
      'IDEMPOTENCY_CONFLICT'
    );
    expect(boundaryMismatch.journal.isKeyBlocked(idempotencyKey)).toBe(false);
    expect(codeOf(() => boundaryMismatch.journal.recordFeedback({ ...base, reason: 'a'.repeat(240) }))).toBe(
      'RECOVERY_REQUIRED'
    );
  } finally {
    dispose(boundaryMismatch);
  }

  const provable = openSeeded((database) => {
    seedLegacyFeedback(database, {
      feedback_id: KEY(0x2c),
      principal_id: principalId,
      idempotency_key: idempotencyKey,
      reason: 'a short legacy reason',
      payload_hash: null
    });
  });
  try {
    expect(codeOf(() => provable.journal.replayFeedback({ ...base, reason: 'a short legacy reason' }))).toBe(
      'NO_ERROR'
    );
    expect(
      codeOf(() => provable.journal.replayFeedback({ ...base, reason: 'a different short reason' }))
    ).toBe('IDEMPOTENCY_CONFLICT');
  } finally {
    dispose(provable);
  }
});

test('classifies a valid historical project-ensure key without a mutation outcome', () => {
  const fixture = openSeeded((database) => {
    seedLegacyOperation(database, {
      operation_id: KEY(0x25),
      idempotency_key: KEY(0x124),
      tool: 'brain_project_ensure',
      scope: 'freellmapi',
      payload_hash: PAYLOAD,
      state: 'complete',
      receipt_json: JSON.stringify({
        operation_id: KEY(0x25),
        repository_identity: 'github.com/example/legacy',
        scope: 'freellmapi',
        created: true,
        backend_ready: true,
        materialized: true,
        warnings: []
      }),
      plan_json: null
    });
  });
  try {
    const replay = fixture.journal.reserve(
      captureInput(KEY(0x124), { tool: 'brain_project_ensure' })
    );
    expect(replay.kind).toBe('replay');
    expect(replay.record.operation_id).toBe(KEY(0x25));
    expect(fixture.journal.isKeyBlocked(KEY(0x124))).toBe(false);
  } finally {
    dispose(fixture);
  }
});

test('quarantines incomplete mutation receipts instead of replaying a matching operation id', () => {
  const fixture = openSeeded((database) => {
    seedCapture(database, {
      operation_id: KEY(0x26), idempotency_key: KEY(0x125),
      receipt_json: JSON.stringify({ operation_id: KEY(0x26), outcome: 'stored' })
    });
  });
  try {
    expect(codeOf(() => fixture.journal.reserve(captureInput(KEY(0x125))))).toBe('RECOVERY_REQUIRED');
    expect(fixture.journal.isKeyBlocked(KEY(0x125))).toBe(true);
  } finally {
    dispose(fixture);
  }
});

test('quarantines a mutation receipt whose revision identity differs from its saved plan', () => {
  const fixture = openSeeded((database) => {
    seedCapture(database, {
      operation_id: KEY(0x28), idempotency_key: KEY(0x128),
      plan_json: JSON.stringify({ revision: { id: KEY(0xa1), revision_id: KEY(0xb2) } })
    });
  });
  try {
    expect(codeOf(() => fixture.journal.reserve(captureInput(KEY(0x128))))).toBe('RECOVERY_REQUIRED');
  } finally {
    dispose(fixture);
  }
});

test('quarantines a project receipt whose repository identity differs from the original payload', () => {
  const fixture = openSeeded((database) => {
    seedLegacyOperation(database, {
      operation_id: KEY(0x29), idempotency_key: KEY(0x129), tool: 'brain_project_ensure',
      scope: 'freellmapi', payload_hash: PAYLOAD, state: 'complete',
      payload_json: JSON.stringify({ repository_identity: 'github.com/example/expected' }),
      receipt_json: JSON.stringify({
        operation_id: KEY(0x29), repository_identity: 'github.com/example/other',
        scope: 'freellmapi', created: true, backend_ready: true, materialized: true, warnings: []
      })
    });
  });
  try {
    expect(codeOf(() => fixture.journal.reserve(captureInput(KEY(0x129), { tool: 'brain_project_ensure' })))).toBe(
      'RECOVERY_REQUIRED'
    );
  } finally {
    dispose(fixture);
  }
});

test('quarantines project receipts naming a different project or missing result fields', () => {
  const base = {
    operation_id: KEY(0x27), repository_identity: 'github.com/example/legacy',
    scope: 'other-project', created: true, backend_ready: true, materialized: true, warnings: []
  };
  for (const [index, candidate] of [base, { ...base, scope: 'freellmapi', warnings: undefined }].entries()) {
    const key = KEY(0x126 + index);
    const fixture = openSeeded((database) => {
      seedLegacyOperation(database, {
        operation_id: KEY(0x27), idempotency_key: key, tool: 'brain_project_ensure',
        scope: 'freellmapi', payload_hash: PAYLOAD, state: 'complete',
        receipt_json: JSON.stringify(candidate), plan_json: null
      });
    });
    try {
      expect(codeOf(() => fixture.journal.reserve(captureInput(key, { tool: 'brain_project_ensure' })))).toBe(
        'RECOVERY_REQUIRED'
      );
    } finally {
      dispose(fixture);
    }
  }
});

test('pruning terminal payloads does not break replay of a bound key', () => {
  const fixture = openSeeded((database) => {
    seedCapture(database, {
      operation_id: KEY(0x09),
      idempotency_key: KEY(0x106),
      payload_json: ''
    });
  });
  try {
    fixture.journal.pruneTerminalPayloads(new Date('2030-01-01T00:00:00.000Z'));
    const replay = fixture.journal.reserve(captureInput(KEY(0x106)));
    expect(replay.kind).toBe('replay');
    expect(replay.record.operation_id).toBe(KEY(0x09));
  } finally {
    dispose(fixture);
  }
});

test('unreadable or missing legacy members return recovery-required without fresh execution', () => {
  const corrupt = openSeeded((database) => {
    seedCapture(database, {
      operation_id: KEY(0x0a),
      idempotency_key: KEY(0x107),
      receipt_json: '{not json'
    });
  });
  try {
    expect(codeOf(() => corrupt.journal.reserve(captureInput(KEY(0x107))))).toBe(
      'RECOVERY_REQUIRED'
    );
  } finally {
    dispose(corrupt);
  }

  const missing = openSeeded((database) => {
    seedCapture(database, { operation_id: KEY(0x0b), idempotency_key: KEY(0x108) });
  });
  try {
    const probe = new Database(missing.path);
    probe.prepare('DELETE FROM operations WHERE operation_id = ?').run(KEY(0x0b));
    probe.close();
    expect(codeOf(() => missing.journal.reserve(captureInput(KEY(0x108))))).toBe(
      'RECOVERY_REQUIRED'
    );
  } finally {
    dispose(missing);
  }
});

test('one pending legacy operation binds for evidence-driven recovery while ambiguous pending conflicts', () => {
  const single = openSeeded((database) => {
    seedCapture(database, {
      operation_id: KEY(0x0c),
      idempotency_key: KEY(0x109),
      state: 'submitted',
      receipt_json: null,
      plan_json: '{}'
    });
  });
  try {
    const replay = single.journal.reserve(captureInput(KEY(0x109)));
    expect(replay.kind).toBe('replay');
    expect(replay.record.state).toBe('submitted');
    expect(replay.record.operation_id).toBe(KEY(0x0c));
  } finally {
    dispose(single);
  }

  const ambiguous = openSeeded((database) => {
    seedCapture(database, {
      operation_id: KEY(0x0d),
      idempotency_key: KEY(0x10a),
      principal_id: KEY(0x18),
      state: 'submitted',
      receipt_json: null,
      plan_json: '{}'
    });
    seedCapture(database, {
      operation_id: KEY(0x0e),
      idempotency_key: KEY(0x10a),
      principal_id: KEY(0x19),
      state: 'submitted',
      receipt_json: null,
      plan_json: '{}'
    });
  });
  try {
    expect(codeOf(() => ambiguous.journal.reserve(captureInput(KEY(0x10a))))).toBe(
      'IDEMPOTENCY_CONFLICT'
    );
  } finally {
    dispose(ambiguous);
  }
});

test('a long legacy feedback reason replays by the original hash recipe and conflicts otherwise', () => {
  const principalId = KEY(0x1a);
  const idempotencyKey = KEY(0x10b);
  const longReason = 'r'.repeat(300);
  const truncated = longReason.slice(0, 240);
  const legacyHash = createHash('sha256')
    .update(
      JSON.stringify({
        principal_id: principalId,
        idempotency_key: idempotencyKey,
        scope: 'freellmapi',
        logical_id: KEY(0xa1),
        revision_id: KEY(0xb1),
        retrieval_id: null,
        related_id: null,
        verdict: 'useful',
        reason: longReason,
        warning: null
      }),
      'utf8'
    )
    .digest('hex');

  const fixture = openSeeded((database) => {
    seedLegacyFeedback(database, {
      feedback_id: KEY(0x1b),
      principal_id: principalId,
      idempotency_key: idempotencyKey,
      reason: truncated,
      payload_hash: legacyHash
    });
  });
  try {
    const request = {
      principal_id: 'system',
      idempotency_key: idempotencyKey,
      scope: 'freellmapi',
      logical_id: KEY(0xa1),
      revision_id: KEY(0xb1),
      verdict: 'useful' as const,
      reason: longReason
    };
    const replay = fixture.journal.replayFeedback(request);
    expect(replay?.kind).toBe('replay');
    expect(replay?.entry.feedback_id).toBe(KEY(0x1b));
    expect(codeOf(() => fixture.journal.recordFeedback({ ...request, reason: 'a different reason' }))).toBe(
      'IDEMPOTENCY_CONFLICT'
    );
  } finally {
    dispose(fixture);
  }
});

test('new feedback binds one global key and replays after pruning', () => {
  const journal = Journal.open(':memory:');
  try {
    const request = {
      principal_id: 'system',
      idempotency_key: KEY(0x10c),
      scope: 'freellmapi',
      logical_id: KEY(0xa1),
      revision_id: KEY(0xb1),
      verdict: 'useful' as const,
      reason: 'first feedback'
    };
    const first = journal.recordFeedback(request);
    expect(first.kind).toBe('new');
    const replay = journal.recordFeedback({ ...request, principal_id: KEY(0x1c) });
    expect(replay.kind).toBe('replay');
    expect(replay.entry.feedback_id).toBe(first.entry.feedback_id);

    journal.pruneTerminalPayloads(new Date('2030-01-01T00:00:00.000Z'));
    const afterPrune = journal.replayFeedback(request);
    expect(afterPrune?.kind).toBe('replay');
    expect(codeOf(() => journal.recordFeedback({ ...request, verdict: 'stale' }))).toBe(
      'IDEMPOTENCY_CONFLICT'
    );
  } finally {
    journal.close();
  }
});
