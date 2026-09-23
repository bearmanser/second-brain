import { createHmac } from 'node:crypto';
import { expect, test } from 'vitest';
import type { CursorPayloadV1, CursorPayloadV2 } from '../../src/retrieval/cursor.js';
import {
  signCursorV2,
  signLegacyCursor,
  verifyCursorV2,
  verifyLegacyCursor
} from '../../src/retrieval/cursor.js';

const NOW = new Date('2026-09-20T12:00:00Z');
const KEY = new Uint8Array(32).fill(7);
const rawHash = (fill: string): string => fill.repeat(64);

const payload = (overrides: Partial<CursorPayloadV2> = {}): CursorPayloadV2 => ({
  version: 2,
  scope: 'freellmapi',
  id: '00000000-0000-4000-8000-0000000000a1',
  revision_id: '00000000-0000-4000-8000-0000000000b1',
  raw_hash: rawHash('a'),
  offset: 100,
  expires_at: '2026-09-20T12:10:00Z',
  ...overrides
});

const forgeV2 = (body: Record<string, unknown>, secret: Uint8Array): string => {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  const signature = createHmac('sha256', secret).update(bytes).digest();
  return `v2.${bytes.toString('base64url')}.${signature.toString('base64url')}`;
};

test('rejects a cursor whose signature is replaced', () => {
  const cursor = signCursorV2(payload(), KEY);
  const [prefix, body] = cursor.split('.');
  expect(() => verifyCursorV2(`${prefix}.${body}.invalid`, KEY, NOW)).toThrow(/INVALID_INPUT/);
});

test('round-trips the exact documented role-free payload fields', () => {
  const cursor = signCursorV2(payload({ raw_hash: rawHash('b'), offset: 42, expires_at: '2026-09-20T12:05:00Z' }), KEY);
  expect(cursor.split('.')).toHaveLength(3);
  const verified = verifyCursorV2(cursor, KEY, NOW);
  expect(Object.keys(verified).sort()).toEqual(
    ['version', 'expires_at', 'id', 'offset', 'raw_hash', 'revision_id', 'scope'].sort()
  );
  expect(verified).toEqual({
    version: 2,
    scope: 'freellmapi',
    id: '00000000-0000-4000-8000-0000000000a1',
    revision_id: '00000000-0000-4000-8000-0000000000b1',
    raw_hash: rawHash('b'),
    offset: 42,
    expires_at: '2026-09-20T12:05:00Z'
  });
  expect('principal_id' in verified).toBe(false);
  expect('path' in verified).toBe(false);
});

test('signs deterministically and rejects a cursor signed with another secret', () => {
  expect(signCursorV2(payload(), KEY)).toBe(signCursorV2(payload(), KEY));
  const cursor = signCursorV2(payload(), KEY);
  expect(() => verifyCursorV2(cursor, new Uint8Array(32).fill(9), NOW)).toThrow(/INVALID_INPUT/);
});

test('rejects an extra path field riding inside the signed body', () => {
  const forged = forgeV2({ ...payload(), relative_path: '../../etc/passwd' }, KEY);
  expect(() => verifyCursorV2(forged, KEY, NOW)).toThrow(/INVALID_INPUT/);
});

test('cursors are integrity tokens without a caller binding', () => {
  const legacy: CursorPayloadV1 = {
    principal_id: 'legacy-principal',
    scope: 'freellmapi',
    id: 'n1',
    revision_id: 'r1',
    raw_hash: rawHash('c'),
    offset: 3,
    expires_at: '2026-09-20T12:05:00Z'
  };
  const decoded = verifyLegacyCursor(signLegacyCursor(legacy, KEY), KEY, NOW);
  expect(decoded.principal_id).toBe('legacy-principal');
  expect(decoded.offset).toBe(3);
});

test('rejects an expired cursor and accepts the expiry boundary', () => {
  const expired = signCursorV2(payload({ expires_at: '2026-09-20T11:59:59Z' }), KEY);
  expect(() => verifyCursorV2(expired, KEY, NOW)).toThrow(/INVALID_INPUT/);
  const boundary = signCursorV2(payload({ expires_at: '2026-09-20T12:00:00Z' }), KEY);
  expect(verifyCursorV2(boundary, KEY, NOW).offset).toBe(100);
});

test('rejects an expiry beyond the ten-minute window or an invalid instant', () => {
  for (const value of ['2026-09-20T12:10:01Z', 'not-a-date', '2026-09-20T12:10:00+02:00', '2026-02-30T12:10:00Z']) {
    const cursor = signCursorV2(payload({ expires_at: value }), KEY);
    expect(() => verifyCursorV2(cursor, KEY, NOW)).toThrow(/INVALID_INPUT/);
  }
});

test('rejects short or empty signing secrets in both directions', () => {
  const valid = signCursorV2(payload(), KEY);
  for (const key of [new Uint8Array(0), new Uint8Array(16).fill(1), new Uint8Array(31).fill(1)]) {
    expect(() => signCursorV2(payload(), key)).toThrow(/INVALID_INPUT/);
    expect(() => verifyCursorV2(valid, key, NOW)).toThrow(/INVALID_INPUT/);
  }
});

test('rejects negative, fractional, and non-numeric offsets and accepts zero', () => {
  for (const offset of [-1, 1.5, Number.NaN, '5']) {
    const cursor = signCursorV2(payload({ offset: offset as unknown as number }), KEY);
    expect(() => verifyCursorV2(cursor, KEY, NOW)).toThrow(/INVALID_INPUT/);
  }
  expect(verifyCursorV2(signCursorV2(payload({ offset: 0 }), KEY), KEY, NOW).offset).toBe(0);
});

test('rejects truncated, empty, extra, and non-base64url tokens', () => {
  const cursor = signCursorV2(payload(), KEY);
  const [prefix, body, signature] = cursor.split('.');
  expect(() => verifyCursorV2(body, KEY, NOW)).toThrow(/INVALID_INPUT/);
  expect(() => verifyCursorV2(`${cursor}.extra`, KEY, NOW)).toThrow(/INVALID_INPUT/);
  expect(() => verifyCursorV2(`${prefix}.${body}.`, KEY, NOW)).toThrow(/INVALID_INPUT/);
  expect(() => verifyCursorV2(`${prefix}..${signature}`, KEY, NOW)).toThrow(/INVALID_INPUT/);
  expect(() => verifyCursorV2('', KEY, NOW)).toThrow(/INVALID_INPUT/);
});

test('rejects a tampered body that keeps the original signature', () => {
  const cursor = signCursorV2(payload(), KEY);
  const [, , signature] = cursor.split('.');
  const tampered = Buffer.from(JSON.stringify({ ...payload(), offset: 999999 }), 'utf8').toString('base64url');
  expect(() => verifyCursorV2(`v2.${tampered}.${signature}`, KEY, NOW)).toThrow(/INVALID_INPUT/);
});

test('rejects a signed body that is valid JSON but not a v2 object', () => {
  const body = Buffer.from(JSON.stringify([1, 2, 3]), 'utf8');
  const signature = createHmac('sha256', KEY).update(body).digest();
  expect(() => verifyCursorV2(`v2.${body.toString('base64url')}.${signature.toString('base64url')}`, KEY, NOW)).toThrow(
    /INVALID_INPUT/
  );
});
