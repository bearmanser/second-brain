import { createHmac } from 'node:crypto';
import { expect, test } from 'vitest';
import { signCursor, verifyCursor } from '../../src/retrieval/cursor.js';
import { reviewerContext, workerContext } from '../fixtures/principals.js';

const NOW = new Date('2026-09-20T12:00:00Z');
const KEY = new Uint8Array(32).fill(7);

const payload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  principal_id: reviewerContext.principal.id,
  scope: 'freellmapi',
  id: 'n1',
  revision_id: 'r1',
  raw_hash: 'a'.repeat(64),
  offset: 100,
  expires_at: '2026-09-20T12:10:00Z',
  ...overrides
});

const forge = (body: Record<string, unknown>, secret: Uint8Array): string => {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  const signature = createHmac('sha256', secret).update(bytes).digest();
  return `${bytes.toString('base64url')}.${signature.toString('base64url')}`;
};

test('rejects a cursor whose signature is replaced', () => {
  const key = new Uint8Array(32).fill(7);
  const cursor = signCursor(
    {
      principal_id: reviewerContext.principal.id,
      scope: 'freellmapi',
      id: 'n1',
      revision_id: 'r1',
      raw_hash: 'a'.repeat(64),
      offset: 100,
      expires_at: '2026-09-20T12:10:00Z'
    },
    key
  );
  const body = cursor.split('.')[0];
  expect(() =>
    verifyCursor(`${body}.invalid`, key, reviewerContext, new Date('2026-09-20T12:00:00Z'))
  ).toThrow(/INVALID_INPUT/);
});

test('round-trips the exact documented payload fields', () => {
  const cursor = signCursor(
    {
      principal_id: reviewerContext.principal.id,
      scope: 'freellmapi',
      id: 'n1',
      revision_id: 'r1',
      raw_hash: 'b'.repeat(64),
      offset: 42,
      expires_at: '2026-09-20T12:05:00Z'
    },
    KEY
  );
  expect(cursor.split('.')).toHaveLength(2);
  const verified = verifyCursor(cursor, KEY, reviewerContext, NOW);
  expect(Object.keys(verified).sort()).toEqual(
    ['expires_at', 'id', 'offset', 'principal_id', 'raw_hash', 'revision_id', 'scope'].sort()
  );
  expect(verified).toEqual({
    principal_id: reviewerContext.principal.id,
    scope: 'freellmapi',
    id: 'n1',
    revision_id: 'r1',
    raw_hash: 'b'.repeat(64),
    offset: 42,
    expires_at: '2026-09-20T12:05:00Z'
  });
  expect('path' in verified).toBe(false);
  expect('relative_path' in verified).toBe(false);
});

test('signs deterministically', () => {
  const first = signCursor(payload() as never, KEY);
  const second = signCursor(payload() as never, KEY);
  expect(first).toBe(second);
});

test('does not let an extra path field ride inside the signed body', () => {
  const cursor = signCursor(payload({ relative_path: '../../etc/passwd' }) as never, KEY);
  const verified = verifyCursor(cursor, KEY, reviewerContext, NOW);
  expect(Object.keys(verified)).toHaveLength(7);
  expect('relative_path' in verified).toBe(false);

  const forged = forge(payload({ path: '../../etc/passwd' }), KEY);
  expect(() => verifyCursor(forged, KEY, reviewerContext, NOW)).toThrow(/INVALID_INPUT/);
});

test('rejects a cursor signed with another secret', () => {
  const cursor = signCursor(payload() as never, KEY);
  expect(() => verifyCursor(cursor, new Uint8Array(32).fill(9), reviewerContext, NOW)).toThrow(
    /INVALID_INPUT/
  );
});

test('rejects a cursor bound to another principal', () => {
  const cursor = signCursor(payload() as never, KEY);
  expect(() => verifyCursor(cursor, KEY, workerContext, NOW)).toThrow(/INVALID_INPUT/);
});

test('rejects an expired cursor and accepts the expiry boundary', () => {
  const expired = signCursor(payload({ expires_at: '2026-09-20T11:59:59Z' }) as never, KEY);
  expect(() => verifyCursor(expired, KEY, reviewerContext, NOW)).toThrow(/INVALID_INPUT/);

  const boundary = signCursor(payload({ expires_at: '2026-09-20T12:00:00Z' }) as never, KEY);
  expect(verifyCursor(boundary, KEY, reviewerContext, NOW).offset).toBe(100);
});

test('rejects an expiry beyond the ten-minute window', () => {
  const cursor = signCursor(payload({ expires_at: '2026-09-20T12:10:01Z' }) as never, KEY);
  expect(() => verifyCursor(cursor, KEY, reviewerContext, NOW)).toThrow(/INVALID_INPUT/);
});

test('rejects an invalid expiry', () => {
  const cursor = signCursor(payload({ expires_at: 'not-a-date' }) as never, KEY);
  expect(() => verifyCursor(cursor, KEY, reviewerContext, NOW)).toThrow(/INVALID_INPUT/);
});

test('rejects a non-UTC or non-RFC3339 expiry', () => {
  for (const value of [
    '2026-09-20T12:10:00+02:00',
    '2026-09-20T12:10:00z',
    '2026-09-20T12:10:00',
    '2026-09-20',
    '20260920T121000Z'
  ]) {
    const cursor = signCursor(payload({ expires_at: value }) as never, KEY);
    expect(() => verifyCursor(cursor, KEY, reviewerContext, NOW)).toThrow(/INVALID_INPUT/);
  }
});

test('rejects negative, fractional, and non-numeric offsets', () => {
  for (const offset of [-1, 1.5, Number.NaN, '5']) {
    const cursor = signCursor(payload({ offset }) as never, KEY);
    expect(() => verifyCursor(cursor, KEY, reviewerContext, NOW)).toThrow(/INVALID_INPUT/);
  }
});

test('accepts a zero offset', () => {
  const cursor = signCursor(payload({ offset: 0 }) as never, KEY);
  expect(verifyCursor(cursor, KEY, reviewerContext, NOW).offset).toBe(0);
});

test('rejects truncated, empty, extra, and non-base64url tokens', () => {
  const cursor = signCursor(payload() as never, KEY);
  const [body, signature] = cursor.split('.');
  expect(() => verifyCursor(body, KEY, reviewerContext, NOW)).toThrow(/INVALID_INPUT/);
  expect(() => verifyCursor(`${cursor}.extra`, KEY, reviewerContext, NOW)).toThrow(/INVALID_INPUT/);
  expect(() => verifyCursor(`${body}.`, KEY, reviewerContext, NOW)).toThrow(/INVALID_INPUT/);
  expect(() => verifyCursor(`.${signature}`, KEY, reviewerContext, NOW)).toThrow(/INVALID_INPUT/);
  expect(() => verifyCursor('not base64url!!.also!!', KEY, reviewerContext, NOW)).toThrow(
    /INVALID_INPUT/
  );
  expect(() => verifyCursor('', KEY, reviewerContext, NOW)).toThrow(/INVALID_INPUT/);
});

test('rejects a tampered body that keeps the original signature', () => {
  const cursor = signCursor(payload() as never, KEY);
  const [body, signature] = cursor.split('.');
  const tampered = Buffer.from(
    JSON.stringify({ ...payload(), offset: 999999 }),
    'utf8'
  ).toString('base64url');
  expect(() => verifyCursor(`${tampered}.${signature}`, KEY, reviewerContext, NOW)).toThrow(
    /INVALID_INPUT/
  );
  expect(typeof body).toBe('string');
});

test('rejects a signed body that is valid JSON but not an object', () => {
  const body = Buffer.from(JSON.stringify([1, 2, 3]), 'utf8');
  const signature = createHmac('sha256', KEY).update(body).digest();
  expect(() =>
    verifyCursor(`${body.toString('base64url')}.${signature.toString('base64url')}`, KEY, reviewerContext, NOW)
  ).toThrow(/INVALID_INPUT/);

  const emptyObject = Buffer.from('{}', 'utf8');
  const emptySignature = createHmac('sha256', KEY).update(emptyObject).digest();
  expect(() =>
    verifyCursor(
      `${emptyObject.toString('base64url')}.${emptySignature.toString('base64url')}`,
      KEY,
      reviewerContext,
      NOW
    )
  ).toThrow(/INVALID_INPUT/);
});
