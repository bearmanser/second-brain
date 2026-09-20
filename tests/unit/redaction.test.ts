import { expect, test } from 'vitest';
import { BrainError } from '../../src/contracts/errors.js';
import { auditFields, logOperational } from '../../src/features/feedback.js';
import { AUDIT_FIELDS, Journal } from '../../src/storage/journal.js';
import {
  REDACTION_CAVEAT,
  redactError,
  redactString,
  redactValue
} from '../../src/security/redact.js';

const QUERY_MARKER = 'sensitive-query-marker';
const NOTE_MARKER = 'private-note-marker';
const EVIDENCE_MARKER = 'benchmark-fixture-1';
const BEARER_TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ASSIGNMENT_SECRET = 'sk-abcdefghijklmnopqrstuvwxyz012345';

test('auditFields keeps only the content-free allowlist', () => {
  const fields = auditFields({
    request_id: 'req-1',
    tool: 'brain_recall',
    outcome: 'ok',
    duration_ms: 11,
    note_count: 2,
    query: QUERY_MARKER,
    note: NOTE_MARKER,
    token: ASSIGNMENT_SECRET,
    evidence: EVIDENCE_MARKER
  } as never);
  expect(Object.keys(fields).sort()).toEqual([...AUDIT_FIELDS].sort());
  expect(fields).toEqual({
    request_id: 'req-1',
    tool: 'brain_recall',
    outcome: 'ok',
    duration_ms: 11,
    note_count: 2
  });
  const serialized = JSON.stringify(fields);
  expect(serialized).not.toContain(QUERY_MARKER);
  expect(serialized).not.toContain(NOTE_MARKER);
  expect(serialized).not.toContain(EVIDENCE_MARKER);
  expect(serialized).not.toContain(ASSIGNMENT_SECRET);
});

test('auditFields defaults note_count to zero', () => {
  const fields = auditFields({
    request_id: 'req-2',
    tool: 'brain_feedback',
    outcome: 'recorded',
    duration_ms: 3
  });
  expect(fields.note_count).toBe(0);
});

test('logOperational never forwards request content to the sink', () => {
  const lines: string[] = [];
  logOperational(
    (fields) => lines.push(JSON.stringify(fields)),
    {
      request_id: 'req-3',
      tool: 'brain_recall',
      outcome: 'ok',
      duration_ms: 1,
      query: QUERY_MARKER,
      note: NOTE_MARKER,
      token: ASSIGNMENT_SECRET,
      evidence: EVIDENCE_MARKER
    } as never
  );
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0])).toEqual({
    request_id: 'req-3',
    tool: 'brain_recall',
    outcome: 'ok',
    duration_ms: 1,
    note_count: 0
  });
  expect(lines[0]).not.toContain(QUERY_MARKER);
  expect(lines[0]).not.toContain(NOTE_MARKER);
  expect(lines[0]).not.toContain(EVIDENCE_MARKER);
  expect(lines[0]).not.toContain(ASSIGNMENT_SECRET);
});

test('appendAudit rejects events that are not limited to the allowlist', () => {
  const journal = Journal.open(':memory:');
  expect(() =>
    journal.appendAudit({
      request_id: 'req-4',
      tool: 'brain_recall',
      outcome: 'ok',
      duration_ms: 1,
      note_count: 0,
      note: NOTE_MARKER
    } as never)
  ).toThrow(/INVALID_INPUT/);
  expect(() =>
    journal.appendAudit({
      request_id: 'req-4',
      tool: 'brain_recall',
      outcome: 'ok',
      duration_ms: 1
    } as never)
  ).toThrow(/INVALID_INPUT/);
  expect(journal.listAudit()).toHaveLength(0);
  journal.close();
});

test('appendAudit persists only declared metadata and rejects credential text', () => {
  const journal = Journal.open(':memory:');
  const stored = journal.appendAudit(
    auditFields({
      request_id: 'req-5',
      tool: 'brain_feedback',
      outcome: 'recorded',
      duration_ms: 2,
      note_count: 1
    })
  );
  expect(Object.keys(stored).sort()).toEqual(['created_at', ...AUDIT_FIELDS].sort());
  expect(journal.listAudit()).toEqual([stored]);
  expect(JSON.stringify(stored)).not.toContain(NOTE_MARKER);

  expect(() =>
    journal.appendAudit({
      request_id: 'req-6',
      tool: 'brain_recall',
      outcome: `Bearer ${BEARER_TOKEN}`,
      duration_ms: 1,
      note_count: 0
    })
  ).toThrow(/INVALID_INPUT/);
  expect(() =>
    journal.appendAudit({
      request_id: 'req-7',
      tool: 'brain_recall',
      outcome: 'ok',
      duration_ms: 1,
      note_count: -1
    })
  ).toThrow(/INVALID_INPUT/);
  journal.close();
});

test('redacts credentials from a message without inventing content', () => {
  const error = new BrainError({
    code: 'BACKEND_UNAVAILABLE',
    message: `upstream rejected Authorization: Bearer ${BEARER_TOKEN} (password=${ASSIGNMENT_SECRET})`
  });
  const redacted = redactError(error);
  expect(redacted.code).toBe('BACKEND_UNAVAILABLE');
  expect(redacted.message).not.toContain(BEARER_TOKEN);
  expect(redacted.message).not.toContain(ASSIGNMENT_SECRET);
  expect(redacted.message).toContain('[REDACTED]');
  expect(redacted).not.toHaveProperty('stack');

  expect(redactString(`token=${ASSIGNMENT_SECRET}`)).not.toContain(ASSIGNMENT_SECRET);
});

test('redactValue strips credential-named keys from structured logs', () => {
  const redacted = redactValue({
    authorization: `Bearer ${BEARER_TOKEN}`,
    password: 'hunter2',
    api_key: ASSIGNMENT_SECRET,
    request_id: 'req-8'
  }) as Record<string, unknown>;
  expect(redacted.authorization).toBe('[REDACTED]');
  expect(redacted.password).toBe('[REDACTED]');
  expect(redacted.api_key).toBe('[REDACTED]');
  expect(redacted.request_id).toBe('req-8');
});

test('documents that redaction is best-effort', () => {
  expect(REDACTION_CAVEAT).toContain('best-effort');
});
